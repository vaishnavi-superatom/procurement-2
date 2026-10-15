/**
 * Tests for the request context / policy gate on the BACKEND side.
 * Run: cd backend && npx ts-node sqlrewrite/_test-policy-gate.ts
 *
 * The case that matters most is the last one: the backend and the SDK share a
 * `Symbol.for()` storage key rather than any code, so if that contract ever
 * drifts the seam reads `anonymous` for every real user — silently under
 * SA_SQL_POLICY_ENFORCE=off, and as a total outage under `on`.
 */

import { getRequestContext, runAsSystem, describeContext } from '@superatomai/sdk-node';
import {
  resolvePolicies,
  resetReportedPaths,
  AnonymousQueryError,
  policyEnforcementOn,
} from '../src/sources/core/policy-gate';

let failures = 0;
const out: string[] = [];

function check(name: string, fn: () => void) {
  try { fn(); out.push(`PASS  ${name}`); }
  catch (err: any) { failures++; out.push(`FAIL  ${name}\n      ${err?.message ?? err}`); }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---- enforcement off (the default) ----------------------------------------

process.env.SA_SQL_REWRITE_MODE = 'shadow';

check('shadow does not enforce', () => assert(!policyEnforcementOn(), 'shadow must not refuse anonymous queries'));

check('anonymous runs unpoliced and is reported', () => {
  resetReportedPaths();
  const d = resolvePolicies('src_a', 'src_a');
  assert(d.principal === 'anonymous', d.principal);
  assert(d.policies.length === 0, 'expected no policies');
});

check('the warning names a real call path, not "unknown"', () => {
  resetReportedPaths();
  const warn = console.warn;
  let msg = '';
  console.warn = (m: any) => { msg = String(m); };
  try {
    // a named frame, so the report has something identifiable to show
    (function pretendCallSite() { resolvePolicies('src_a', 'src_a'); })();
  } finally { console.warn = warn; }
  assert(!msg.includes('Path: unknown'), `path extraction failed: ${msg}`);
  assert(msg.includes('pretendCallSite'), `expected the caller named in: ${msg}`);
});

check('the same anonymous path is reported once, not per query', () => {
  resetReportedPaths();
  const warn = console.warn;
  let calls = 0;
  console.warn = () => { calls++; };
  try {
    for (let i = 0; i < 5; i++) resolvePolicies('src_a', 'src_a');
  } finally { console.warn = warn; }
  assert(calls === 1, `expected 1 warning for 5 identical calls, got ${calls}`);
});

check('a system context is unpoliced but NAMED', () => {
  runAsSystem('alert-scheduler', () => {
    const d = resolvePolicies('src_a', 'src_a');
    assert(d.principal === 'system:alert-scheduler', d.principal);
    assert(d.policies.length === 0, 'system should carry no policies');
  });
});

check('runAsSystem rejects an empty reason', () => {
  let threw = false;
  try { runAsSystem('  ', () => undefined); } catch { threw = true; }
  assert(threw, 'expected a throw');
});

// ---- enforcement on --------------------------------------------------------

check('anonymous is REFUSED under enforce', () => {
  process.env.SA_SQL_REWRITE_MODE = 'enforce';
  let err: any;
  try { resolvePolicies('src_a', 'src_a'); } catch (e) { err = e; }
  assert(err instanceof AnonymousQueryError, `expected AnonymousQueryError, got ${err}`);
  assert(String(err.message).includes('runAsSystem'), 'error should say how to fix it');
  assert(String(err.message).includes('Path:'), 'error should name the offending path');
});

check('a system context still passes under enforce', () => {
  process.env.SA_SQL_REWRITE_MODE = 'enforce';
  runAsSystem('cross-machine-proxy', () => {
    const d = resolvePolicies('src_a', 'src_a');
    assert(d.principal === 'system:cross-machine-proxy', d.principal);
  });
  process.env.SA_SQL_REWRITE_MODE = 'shadow';
});

// ---- the cross-package contract -------------------------------------------

check('identity established in the SDK reaches the seam', () => {
  const sdk = require('@superatomai/sdk-node');
  if (typeof sdk.runAsUser !== 'function') {
    out.push('SKIP  installed SDK predates request-context — link or bump it to exercise this');
    return;
  }
  // Identity established by the SDK...
  sdk.runAsUser({ userId: 'u_seam', role: 'member' }, () => {
    // ...must be visible at the data seam.
    const ctx = getRequestContext();
    assert(ctx, 'backend saw NO context — the Symbol.for contract is broken');
    assert(describeContext() === 'user:u_seam', describeContext());
    const d = resolvePolicies('src_a', 'src_a');
    assert(d.principal === 'user:u_seam', d.principal);
    assert(Array.isArray(d.policies), 'policies should be an array');
  });
});

check('policies set by the SDK reach the seam, flattened and source-scoped', () => {
  const sdk = require('@superatomai/sdk-node');
  if (typeof sdk.runWithContext !== 'function') return;
  // ctx.policies is SourcePolicy[] (per-source), NOT flat row filters — the seam
  // flattens and narrows them. Passing the flat shape here was the old contract.
  sdk.runWithContext(
    {
      principal: { kind: 'user', userId: 'u_pol' },
      policies: [{ sourceId: 'src_a', rowFilters: [{ table: 't', column: 'c', op: 'in', values: [1] }] }],
    },
    () => {
      const mine = resolvePolicies('src_a', 'src_a');
      assert(mine.policies.length === 1, `expected 1 policy at the seam, got ${mine.policies.length}`);
      assert((mine.policies[0] as any).column === 'c', 'expected the flat row filter, not the wrapper');
      const other = resolvePolicies('src_b', 'src_b');
      assert(other.policies.length === 0, 'a policy for src_a must not reach src_b');
    },
  );
});

check('the retired SA_SQL_POLICY_ENFORCE cannot turn enforcement on', () => {
  process.env.SA_SQL_REWRITE_MODE = 'shadow';
  process.env.SA_SQL_POLICY_ENFORCE = 'on';
  try {
    assert(!policyEnforcementOn(), 'the retired var must be ignored, not honoured');
  } finally {
    delete process.env.SA_SQL_POLICY_ENFORCE;
  }
});

for (const l of out) console.log(l);
console.log(`\n${out.filter((l) => l.startsWith('PASS')).length}/${out.filter((l) => !l.startsWith('SKIP')).length} passed`);
process.exit(failures ? 1 : 0);
