/**
 * Tests for the script-bridge cache scoping (item 6).
 * Run: cd backend && npx ts-node sqlrewrite/_test-bridge-scope.ts
 *
 * The bug these exist to prevent: the bridge caches on the SQL the SCRIPT
 * wrote, but policy predicates are injected later inside execute(). Without a
 * scope in the key, two users running the same script share one entry and the
 * second is served the first's filtered rows — with the rewriter never
 * consulted. See REQUEST-CONTEXT-DESIGN.md.
 */

import { scopeKey, queryCacheKey } from '../src/services/script-bridge';
import type { RequestContext } from '@superatomai/sdk-node';

let failures = 0;
const out: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); out.push(`PASS  ${name}`); }
  catch (e: any) { failures++; out.push(`FAIL  ${name}\n      ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const user = (userId: string, policies?: unknown[]): RequestContext =>
  ({ principal: { kind: 'user', userId }, policies });

const SQL = 'SELECT * FROM sales';
const key = (ctx: RequestContext | undefined) => queryCacheKey('src_1', SQL, 50, scopeKey(ctx));

check('different policies ⇒ different cache keys (the bypass)', () => {
  const a = key(user('a', [{ table: 'sales', column: 'region', op: 'in', values: [1] }]));
  const b = key(user('b', [{ table: 'sales', column: 'region', op: 'in', values: [2] }]));
  assert(a !== b, 'two different policy scopes collided on one cache entry');
});

check('identical policies ⇒ shared entry (scope, not identity)', () => {
  const pol = [{ table: 'sales', column: 'region', op: 'in', values: [1] }];
  assert(key(user('a', pol)) === key(user('b', [...pol])), 'same scope should share the cache');
});

check('unpoliced users share one entry — behaviour unchanged today', () => {
  assert(key(user('a')) === key(user('b')), 'unpoliced users should still share');
  assert(scopeKey(user('a')) === 'unpoliced', scopeKey(user('a')));
});

check('anonymous is its own scope, never mixed with a user', () => {
  assert(scopeKey(undefined) === 'anon', scopeKey(undefined));
  assert(key(undefined) !== key(user('a')), 'anonymous shared a user entry');
});

check('each system job gets its own scope', () => {
  const sched: RequestContext = { principal: { kind: 'system', reason: 'alert-scheduler' } };
  const proxy: RequestContext = { principal: { kind: 'system', reason: 'cross-machine-proxy' } };
  assert(scopeKey(sched) === 'sys:alert-scheduler', scopeKey(sched));
  assert(key(sched) !== key(proxy), 'two system jobs collided');
  assert(key(sched) !== key(user('a')), 'a system job shared a user entry');
});

check('sql, tool and limit still separate entries', () => {
  const ctx = user('a');
  assert(queryCacheKey('t1', SQL, 50, scopeKey(ctx)) !== queryCacheKey('t2', SQL, 50, scopeKey(ctx)), 'toolId ignored');
  assert(queryCacheKey('t1', SQL, 50, scopeKey(ctx)) !== queryCacheKey('t1', SQL, 10, scopeKey(ctx)), 'limit ignored');
  assert(queryCacheKey('t1', SQL, 50, scopeKey(ctx)) !== queryCacheKey('t1', 'SELECT 1', 50, scopeKey(ctx)), 'sql ignored');
});

check('policy order does not fragment the cache unnecessarily', () => {
  // Documents current behaviour: the hash is over JSON, so ordering matters.
  // Acceptable — policies are built by one resolver, so order is stable — but
  // if that ever changes, sort before hashing rather than accepting misses.
  const p1 = [{ a: 1 }, { b: 2 }];
  const p2 = [{ b: 2 }, { a: 1 }];
  assert(scopeKey(user('x', p1)) !== scopeKey(user('x', p2)),
    'if this now passes, ordering was normalised — update this test');
});

for (const l of out) console.log(l);
console.log(`\n${out.length - failures}/${out.length} passed`);
process.exit(failures ? 1 : 0);
