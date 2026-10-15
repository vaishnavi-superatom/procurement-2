/**
 * End-to-end smoke test: Node pool -> Python worker -> back.
 * Run: cd backend && npx ts-node sqlrewrite/_smoke.ts
 *
 * Kept (not deleted after use) as the quickest way to answer "is the sidecar
 * alive on this VM, and what does it do to my query?" without a running backend.
 */

import { sqlglotPool } from '../src/sources/core/sqlglot-pool';
import { rewriteSql, resetRewriterState, SqlRejectedError } from '../src/sources/core/sql-rewrite';

const BRANCH = { table: 'dw.FactSales', column: 'BranchFK', op: 'in', values: [16, 22] };

async function main() {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
    if (!cond) failures++;
  };

  const pong = await sqlglotPool.ping();
  ok('pool: worker answers ping', pong.ok === true, JSON.stringify(pong));

  // enforce mode — the rewritten SQL is what would run
  process.env.SA_SQL_REWRITE_MODE = 'enforce';
  resetRewriterState();

  const enforced = await rewriteSql(
    'SELECT b.BranchName, SUM(f.NetSales) AS total FROM dw.FactSales f ' +
      'JOIN dw.DimBranch b ON b.BranchFK = f.BranchFK WHERE f.FiscalYear = 2026 GROUP BY b.BranchName',
    { sourceType: 'mssql', sourceName: 'test', policies: [BRANCH], maxRows: 50 },
  );
  ok('enforce: policy injected with the query\'s own alias',
    enforced.sql.includes('f.BranchFK IN (16, 22)'), enforced.sql);
  ok('enforce: cap rendered as TOP for tsql', enforced.sql.includes('TOP 51'), enforced.sql);
  ok('enforce: cappedTo reported back', enforced.cappedTo === 50, String(enforced.cappedTo));

  // a refusal is a decision, not an outage
  let rejected = false;
  try {
    await rewriteSql('SELECT * INTO tmp FROM customer', { sourceType: 'mssql' });
  } catch (err) {
    rejected = err instanceof SqlRejectedError;
  }
  ok('enforce: SELECT INTO refused', rejected);

  // non-SQL dialect passes through untouched
  const passthrough = await rewriteSql("SELECT * FROM t WHERE k='a'", { sourceType: 'dynamodb' });
  ok('dynamodb: not rewritten (no PartiQL dialect)', passthrough.rewritten === false);

  // A malformed policy must NOT break shadow mode — shadow injects nothing, so
  // there is nothing for a block to protect. Regression: with no env vars set,
  // a bad policy blocked every query on the source.
  process.env.SA_SQL_REWRITE_MODE = 'shadow';
  resetRewriterState();
  const badPolicy = [{ sourceId: 'x', rowFilters: [{ table: 't', column: 'c', values: [1] }] } as any];
  let shadowBlocked = false;
  let shadowOut = '';
  try {
    shadowOut = (await rewriteSql('SELECT a FROM t', {
      sourceType: 'postgres', sourceName: 'test', policies: badPolicy,
    })).sql;
  } catch (err) {
    shadowBlocked = err instanceof SqlRejectedError;
  }
  ok('shadow: a malformed policy warns, does not block',
    !shadowBlocked && shadowOut === 'SELECT a FROM t', shadowBlocked ? 'BLOCKED' : shadowOut);

  // ...but the same policy IS fatal under enforce.
  process.env.SA_SQL_REWRITE_MODE = 'enforce';
  resetRewriterState();
  let enforceBlocked = false;
  try {
    await rewriteSql('SELECT a FROM t', { sourceType: 'postgres', sourceName: 'test', policies: badPolicy });
  } catch (err) {
    enforceBlocked = err instanceof SqlRejectedError;
  }
  ok('enforce: the same malformed policy blocks', enforceBlocked);

  // shadow mode returns the ORIGINAL, but still refuses what it decided to refuse
  process.env.SA_SQL_REWRITE_MODE = 'shadow';
  resetRewriterState();

  const shadow = await rewriteSql('SELECT a FROM t', {
    sourceType: 'postgres', policies: [{ table: 't', column: 'x', op: 'in', values: [1] }],
  });
  ok('shadow: executes the original, not the rewrite',
    shadow.sql === 'SELECT a FROM t' && shadow.rewritten === false, shadow.sql);

  let shadowRejected = false;
  try {
    await rewriteSql('DROP TABLE t', { sourceType: 'postgres' });
  } catch (err) {
    shadowRejected = err instanceof SqlRejectedError;
  }
  ok('shadow: still refuses a write', shadowRejected);

  sqlglotPool.shutdown();
  console.log(`\n${failures === 0 ? 'all passed' : `${failures} failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  sqlglotPool.shutdown();
  process.exit(1);
});
