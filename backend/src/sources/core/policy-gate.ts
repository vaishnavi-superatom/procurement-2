/**
 * Policy gate — what a missing request context means at the data seam.
 *
 * The rewriter can only inject policies it is given, and it is given whatever
 * the request context carries. So the question this module answers is not
 * "which rows may this user see" but the one underneath it: **do we know who
 * is asking at all?**
 *
 * Three answers, and they must stay distinguishable:
 *
 *   user      → apply their policies
 *   system    → a trusted job that named itself (runAsSystem)
 *   anonymous → we do not know. NOT the same as trusted.
 *
 * Collapsing `anonymous` into `system` is the failure this exists to prevent:
 * every code path that loses identity would silently become an unpoliced one,
 * and nothing would ever surface it.
 *
 * The context itself comes from the SDK (`sdk-nodejs/src/utils/request-context.ts`),
 * which is where a user's identity is established and where the storage lives.
 * This module only decides what to do with what it finds.
 *
 * Note for porting: the backend now needs an SDK build that exports
 * `getRequestContext`/`runAsSystem`. On a branch whose installed SDK predates
 * them, this fails at `tsc` — loudly, at build time — so a port of this change
 * has to carry an SDK bump with it.
 *
 * See backend/docs/REQUEST-CONTEXT-DESIGN.md.
 */

import {
  getRequestContext,
  describeContext,
  type RequestContext,
  type RowFilter,
  type SourcePolicy,
} from '@superatomai/sdk-node';
import { rewriteMode } from './sql-rewrite';

const RETIRED_ENV = 'SA_SQL_POLICY_ENFORCE';
let warnedRetiredEnv = false;

/**
 * Whether an anonymous query is refused.
 *
 * Not its own switch: this is what `SA_SQL_REWRITE_MODE=enforce` MEANS. Under
 * `shadow` the rewriter injects nothing, so refusing a contextless query would
 * protect nothing and merely break it — the failure that retired the second
 * variable. Under `enforce`, a call site nobody instrumented breaks loudly
 * instead of reading unfiltered, which is what makes an ambient mechanism safe.
 */
export function policyEnforcementOn(): boolean {
  // Say so rather than silently ignoring it: someone who sets the retired var
  // believes enforcement is on, and would otherwise get shadow.
  if (process.env[RETIRED_ENV] !== undefined && !warnedRetiredEnv) {
    warnedRetiredEnv = true;
    console.warn(
      `[policy-gate] ${RETIRED_ENV} is set but RETIRED and ignored. There is one switch now: ` +
      `SA_SQL_REWRITE_MODE=off|shadow|enforce. Anonymous queries are refused under 'enforce'. ` +
      `Currently: ${rewriteMode()}.`
    );
  }
  return rewriteMode() === 'enforce';
}

export class AnonymousQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnonymousQueryError';
  }
}

/** Paths already reported, so the log names each one once rather than per query. */
const reportedPaths = new Set<string>();

/**
 * Identify the caller by its first few in-repo stack frames.
 *
 * Deliberately not just the source name: the point of the `off` phase is to
 * enumerate CALL PATHS that arrive without a context, and two paths into the
 * same source are two separate things to fix.
 */
function callerPath(): string {
  const raw = new Error().stack || '';
  const frames = raw
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => !l.includes('node_modules') && !l.includes('node:internal'))
    // Match the module files themselves, not anything merely containing the
    // name — `_test-policy-gate.ts` is a caller, not a frame to hide.
    .filter((l) => !/[/\\](policy-gate|base-source)\.ts/.test(l))
    .slice(0, 3)
    .map((l) => {
      const f = l.match(/([\w.-]+\.ts):(\d+)/);
      const where = f ? `${f[1]}:${f[2]}` : '?';
      const m = l.match(/at\s+([^\s(]+)/);
      // A frame with no function name yields the raw path here; drop it and
      // keep file:line, which is the part that identifies the call site.
      const who = m?.[1] && !m[1].includes('/') ? m[1] : '';
      return who ? `${who}@${where}` : where;
    });
  return frames.join(' < ') || 'unknown';
}

export interface PolicyDecision {
  /** Row restrictions for THIS source, ready for the rewriter. */
  policies: RowFilter[];
  /** Gate 3 allow-list for this source; empty means no table restriction. */
  readableTables: string[];
  /** For the audit log: who this query ran as. */
  principal: string;
}

/**
 * Narrow a user's policies to the source about to be queried.
 *
 * Source-scoping is not a nicety. A filter naming `com_trn_documentstamp.LocationId`
 * injected into an Excel or Postgres query would either error or, worse, match a
 * same-named column somewhere it means something else. A policy with no
 * `sourceId` applies everywhere, which is only ever right for a column that
 * genuinely exists in every source.
 */
function forSource(policies: SourcePolicy[] | undefined, sourceId: string): {
  rowFilters: RowFilter[];
  readableTables: string[];
} {
  const rowFilters: RowFilter[] = [];
  const readableTables: string[] = [];
  for (const p of policies ?? []) {
    if (p.sourceId && p.sourceId !== sourceId) continue;
    if (p.rowFilters?.length) {
      // A policy-level label is the common case — one policy means one thing
      // ("Hyderabad branch"). Push it onto each filter so describeScope has it.
      rowFilters.push(...p.rowFilters.map((f) => (f.label || !p.label ? f : { ...f, label: p.label })));
    }
    if (p.readableTables?.length) readableTables.push(...p.readableTables);
  }
  return { rowFilters, readableTables };
}

/**
 * Resolve the policies for the query about to run, or refuse.
 *
 * @param label  source name, for the error message
 * @param opts.quiet  skip the per-query audit line — for the answer cache, which
 *                    only needs the scope to key on; the run itself still logs.
 */
export function resolvePolicies(sourceId: string, label: string, opts?: { quiet?: boolean }): PolicyDecision {
  const ctx: RequestContext | undefined = getRequestContext();

  if (!ctx) {
    if (policyEnforcementOn()) {
      throw new AnonymousQueryError(
        `Query blocked on "${label}": no request context, so there is no way to tell whose data ` +
        `this is. The calling path must establish a user context or declare itself trusted with ` +
        `runAsSystem(). Path: ${callerPath()}`,
      );
    }
    const path = callerPath();
    if (!reportedPaths.has(path)) {
      reportedPaths.add(path);
      console.warn(
        `[policy-gate] anonymous query on "${label}" — no request context. Running unpoliced ` +
        `because SA_SQL_REWRITE_MODE is not 'enforce'. Instrument this path before switching. ` +
        `Path: ${path}`,
      );
    }
    return { policies: [], readableTables: [], principal: 'anonymous' };
  }

  // A trusted job runs unpoliced by construction — that is what declaring it
  // meant. It is named in the audit log rather than being invisible.
  if (ctx.principal.kind === 'system') {
    return { policies: [], readableTables: [], principal: describeContext(ctx) };
  }

  const { rowFilters, readableTables } = forSource(ctx.policies, sourceId);
  // Logged even when there are NO filters. The zero case used to print nothing,
  // which made an unpoliced query indistinguishable from a policy-free user in
  // the logs — that silence is how a DATA_REQ carrying an empty policy list ran
  // unrestricted for a restricted user without anyone noticing.
  if (!opts?.quiet) console.log(
    `[policy-gate] ${describeContext(ctx)} on "${label}": ${rowFilters.length} row filter(s), ` +
    `${readableTables.length} readable table(s)`
  );
  return { policies: rowFilters, readableTables, principal: describeContext(ctx) };
}

/**
 * Render row filters as readable predicates for the agent.
 *
 * Values are included on purpose: "LocationId was restricted" is not enough to
 * label an answer truthfully — the agent needs the value to name the scope.
 * Long lists are elided; the point is an honest label, not a data dump.
 *
 * ADDING A POLICY TYPE — this function is the per-type half of a two-part
 * contract, and skipping it is silent:
 *
 *   1. the rewriter enforces it            (backend/sqlrewrite/worker.py)
 *   2. `SourcePolicy` carries it           (sdk request-context.ts)
 *   3. a renderer describes it             (HERE — write a sibling of this)
 *   4. a test asserts 2 and 3 agree        (sqlrewrite/_test-policy-e2e.ts)
 *
 * Do 1 and 2 only, and enforcement works while the agent keeps labelling answers
 * as unrestricted — the exact failure this whole path exists to fix. The generic
 * wording wrapped around these phrases lives in the source agent and does NOT
 * need changing per type; only the phrases do.
 */
export function describeScope(applied: RowFilter[], appliedKeys: string[]): string[] {
  // An EMPTY appliedKeys means the rewriter injected nothing — describe nothing.
  // Treating it as "no filter, so show them all" would tell the agent its result
  // was restricted when it was not, which is the more dangerous of the two lies:
  // it would caveat a full-scope answer as branch-scoped.
  if (!appliedKeys.length) return [];

  const wanted = new Set(appliedKeys.map((k) => k.toLowerCase()));
  const out: string[] = [];
  for (const f of applied) {
    const key = `${f.table || '*'}.${f.column}`.toLowerCase();
    if (!wanted.has(key)) continue;
    const vals = (f.values || []).map((v) => (typeof v === 'number' ? String(v) : `'${String(v)}'`));
    const shown = vals.length > 6 ? `${vals.slice(0, 6).join(', ')}, …(${vals.length} total)` : vals.join(', ');
    // A human label, when the policy author supplied one, is what reaches the
    // end user. The predicate is the fallback: correct, but
    // "com_trn_documentstamp.LocationId IN (110)" means nothing to the person
    // reading the answer, and the agent pastes it verbatim.
    if (f.label) { out.push(f.label); continue; }

    const col = `${f.table ? `${f.table}.` : ''}${f.column}`;
    // Render as the predicate the agent would recognise, not the internal op name.
    switch (f.op || 'in') {
      case 'eq': out.push(`${col} = ${shown}`); break;
      case 'ne': out.push(`${col} <> ${shown}`); break;
      case 'not_in': out.push(`${col} NOT IN (${shown})`); break;
      default: out.push(`${col} IN (${shown})`);
    }
  }
  return out;
}

/** Test seam. */
export function resetReportedPaths(): void {
  reportedPaths.clear();
}
