/**
 * The authorization seam.
 *
 * Agent-authored SQL is parsed to an AST, gated, has the caller's policies
 * injected as predicates, and is re-rendered before it reaches a source. What
 * runs is our output, never the agent's input.
 *
 * This module owns the POLICY of using the rewriter — which sources it applies
 * to, what happens when it is unavailable, and what "shadow mode" means.
 * Process lifecycle lives in sqlglot-pool.ts; the AST work lives in
 * backend/sqlrewrite/worker.py. Design: backend/docs/SQL-AUTHORIZATION-DESIGN.md
 *
 * PHASE 1: policies are always empty. The pipeline runs, proves parse/render
 * fidelity against real traffic, and changes nothing about which rows come
 * back. Policy resolution arrives in Phase 2 and requires the identity
 * plumbing (verified user id carried to this seam) that does not exist yet.
 */

import { SourceType } from './types';
import { RewriterUnavailableError, sqlglotPool } from './sqlglot-pool';

/**
 * off      — do not consult the rewriter at all.
 * shadow   — rewrite, log any difference, execute the ORIGINAL. Phase 1 default:
 *            it surfaces parse/render infidelity on real queries at zero risk.
 * enforce  — execute the rewritten SQL. Required before policies mean anything.
 */
export type RewriteMode = 'off' | 'shadow' | 'enforce';

/** Thrown when the rewriter refuses a query. Message is user-facing. */
export class SqlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlRejectedError';
  }
}

/**
 * Read/write dialect per source type.
 *
 * `null` means "not rewritten": the source is not SQL, or SQLGlot has no
 * dialect for it. Those keep the regex guard and take no policies — do not let
 * "we did SQL authorization" read as "every source is authorized".
 *
 * dynamodb speaks PartiQL, which SQLGlot does not model, and its instance
 * already strips LIMIT/ORDER BY to apply them client-side; rewriting it needs
 * separate work.
 */
const DIALECTS: Partial<Record<SourceType | 'federation', { read: string; write: string } | null>> = {
  postgres: { read: 'postgres', write: 'postgres' },
  mysql: { read: 'mysql', write: 'mysql' },
  mssql: { read: 'tsql', write: 'tsql' },
  netsuite: { read: 'oracle', write: 'oracle' },
  excel: { read: 'duckdb', write: 'duckdb' },
  csv: { read: 'duckdb', write: 'duckdb' },
  federation: { read: 'duckdb', write: 'duckdb' },
  dynamodb: null,
  redis: null,
  rest_api: null,
  graphql: null,
};

export interface RewriteOptions {
  sourceType: SourceType | 'federation';
  sourceName?: string;
  maxRows?: number;
  allowWrites?: boolean;
  /** Phase 2. Empty today; when non-empty, an unavailable rewriter is fatal. */
  policies?: unknown[];
  readableTables?: string[];
}

export interface RewriteOutcome {
  /** The SQL to execute. In shadow mode this is always the original. */
  sql: string;
  /** Row cap the rewriter injected, if any — for the truncation note. */
  cappedTo?: number | null;
  applied?: string[];
  rewritten: boolean;
}

/**
 * The single switch for this whole feature.
 *
 * Was two vars (`SA_SQL_REWRITE_MODE` + `SA_SQL_POLICY_ENFORCE`) until it became
 * clear they are not independent axes. Of the six combinations, one was
 * nonsense (refuse contextless queries while never applying policies), one was
 * a footgun (apply policies but let uninstrumented paths run unpoliced), and one
 * actively caused a bug — blocking queries in shadow mode, which injects nothing
 * and so had nothing to protect. Refusing a contextless query is only meaningful
 * where policies are applied, so it belongs INSIDE `enforce`.
 */
export function rewriteMode(): RewriteMode {
  const raw = (process.env.SA_SQL_REWRITE_MODE || 'shadow').toLowerCase();
  return raw === 'off' || raw === 'enforce' ? raw : 'shadow';
}

/** Module-local alias for the call sites below. */
const mode = rewriteMode;

/**
 * A backend on a VM without Python would otherwise log a failure per query
 * forever. Give up after a few consecutive unavailability errors and say so
 * once — but only when there are no policies to enforce. With policies, every
 * query must fail loudly rather than quietly stop being checked.
 */
const MAX_CONSECUTIVE_FAILURES = 5;
let consecutiveFailures = 0;
let disabledReason: string | null = null;

export function rewriterStatus(): { mode: RewriteMode; disabled: string | null } {
  return { mode: mode(), disabled: disabledReason };
}

/** Test seam — resets the self-disable latch. */
export function resetRewriterState(): void {
  consecutiveFailures = 0;
  disabledReason = null;
}

export async function rewriteSql(sql: string, opts: RewriteOptions): Promise<RewriteOutcome> {
  const passthrough: RewriteOutcome = { sql, rewritten: false };
  const policies = opts.policies ?? [];
  const hasPolicies = policies.length > 0 || (opts.readableTables?.length ?? 0) > 0;

  const active = mode();
  if (active === 'off') return passthrough;

  const dialect = DIALECTS[opts.sourceType];
  if (!dialect) return passthrough;

  if (disabledReason && !hasPolicies) return passthrough;

  const label = opts.sourceName ? ` on "${opts.sourceName}"` : '';

  let res;
  try {
    res = await sqlglotPool.rewrite({
      sql,
      read: dialect.read,
      write: dialect.write,
      policies: policies as unknown[],
      readableTables: opts.readableTables ?? [],
      maxRows: opts.maxRows,
      allowWrites: opts.allowWrites ?? false,
    });
    consecutiveFailures = 0;
    disabledReason = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // The rule that matters in review: a sidecar outage degrades to TODAY's
    // behaviour for unpoliced sources, and to no service for policed ones —
    // never to unrestricted reads.
    //
    // Gated on `enforce` because SHADOW NEVER INJECTS. Blocking a query there
    // protects nothing (the original runs unfiltered either way) and breaks
    // shadow's whole contract of being behaviour-neutral. Found the hard way:
    // with no env vars set at all, a malformed policy blocked every query on
    // the source.
    if (hasPolicies && active === 'enforce') {
      throw new SqlRejectedError(
        `Query blocked${label}: access rules could not be applied (${message}). ` +
        `Refusing to run the query unfiltered.`
      );
    }

    if (err instanceof RewriterUnavailableError) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !disabledReason) {
        disabledReason = message;
        console.warn(
          `[sqlrewrite] disabling after ${consecutiveFailures} consecutive failures ` +
          `(no policies are configured, so this is not a security regression): ${message}`
        );
      }
    }
    if (!disabledReason) console.warn(`[sqlrewrite] unavailable${label}: ${message}`);
    return passthrough;
  }

  if (!res.ok) {
    const kind = (res as { kind?: string }).kind;
    if (kind === 'rejected') {
      // A refusal is a decision about the STATEMENT, not an outage: it holds in
      // shadow mode too. Shadow exists to de-risk RE-RENDERING, not to let
      // statements we have decided are unsafe through.
      throw new SqlRejectedError(res.error || `Query rejected${label}.`);
    }
    if (kind === 'policy') {
      // A malformed policy is a CONFIGURATION problem. Fatal only where policies
      // are applied; in shadow it is a warning, because shadow injects nothing
      // and the query would run unfiltered regardless.
      if (active === 'enforce') {
        throw new SqlRejectedError(
          `Query blocked${label}: the access policy is malformed (${res.error}). ` +
          `Fix the policy — refusing to run the query unfiltered.`
        );
      }
      console.warn(`[sqlrewrite:shadow] access policy is malformed${label} — ${res.error}. ` +
        `Not enforced in shadow mode, but this WOULD block the query under SA_SQL_REWRITE_MODE=enforce.`);
      return passthrough;
    }
    if (hasPolicies && active === 'enforce') {
      throw new SqlRejectedError(
        `Query blocked${label}: access rules could not be applied (${res.error}).`
      );
    }
    console.warn(`[sqlrewrite] internal error${label}: ${res.error}`);
    return passthrough;
  }

  const rewritten = res.sql ?? sql;

  if (active === 'shadow') {
    if (normalize(rewritten) !== normalize(sql)) {
      // The Phase 1 signal. Every line here is a query whose re-rendered form
      // differs from what the agent wrote; each one needs eyeballing before
      // enforce mode is safe to turn on.
      console.info(
        `[sqlrewrite:shadow] rewrite differs${label}\n  in : ${sql}\n  out: ${rewritten}`
      );
    }
    return passthrough;
  }

  return {
    sql: rewritten,
    cappedTo: res.cappedTo ?? null,
    applied: res.applied ?? [],
    rewritten: true,
  };
}

/** Whitespace/case-insensitive compare, so formatting alone is not a "difference". */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim().toLowerCase();
}
