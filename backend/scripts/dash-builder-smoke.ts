/**
 * Smoke test for the dashboard-builder resolver runtime.
 *
 * Runs the demo dashboard's resolvers end to end — compile, validate, execute,
 * shape — without needing the whole backend up. The source manager is stubbed
 * with one tool that queries the same DuckDB the Excel connection built, so the
 * SQL under test is the real SQL against the real data.
 *
 *   pnpm exec ts-node scripts/dash-builder-smoke.ts
 */
import * as path from 'path';
import { DuckDBInstance } from '@duckdb/node-api';

const SOURCE_ID = 'excel-168814462398_query';
const CSV_DIR = path.join(
	__dirname,
	'..',
	'duckdb',
	'67506ebc-c9d7-4921-adf2-2dfd1106a3f5',
	'excel-168814462398_csv',
);

/**
 * Stub `getAllTools` before anything imports it.
 *
 * `query.ts` reaches the source manager through that one function, so replacing
 * it is the whole seam — nothing else about the runtime is aware this is a test.
 */
async function installFakeSource() {
	const db = await DuckDBInstance.create(':memory:');
	const conn = await db.connect();
	for (const table of ['budgets', '6plus6']) {
		const file = path.join(CSV_DIR, `${table}.csv`).replace(/\\/g, '/');
		await conn.run(`CREATE VIEW "${table}" AS SELECT * FROM read_csv_auto('${file}')`);
	}

	/**
	 * Named-parameter substitution, copied from `sources/excel/instance.ts`.
	 *
	 * This must mirror the real source exactly, including the parts that look
	 * odd — the skip of positional `$1`/`$2` especially. An earlier version of
	 * this fake accepted a positional array and bound it, which is not what any
	 * source does; the tests passed and the browser failed with "Expected 2
	 * parameters, but none were supplied".
	 *
	 * A fake that is kinder than the real thing tests nothing. If this drifts
	 * from `instance.ts` again, the same class of bug comes back.
	 */
	const substituteParams = (sql: string, params?: Record<string, unknown>): string => {
		if (!params || Object.keys(params).length === 0) return sql;
		return sql.replace(/[@$](\w+)/g, (match, name) => {
			if (match.startsWith('$') && /^\d+$/.test(name)) return match;
			if (!(name in params)) return match;
			const value = params[name];
			if (value === null || value === undefined) return 'NULL';
			if (typeof value === 'number') return String(value);
			if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
			return `'${String(value).replace(/'/g, "''")}'`;
		});
	};

	const tool = {
		id: SOURCE_ID,
		name: SOURCE_ID,
		toolType: 'source',
		async fn({ sql, params }: { sql: string; params?: Record<string, unknown> }) {
			const finalSql = substituteParams(sql, params);
			const reader = await conn.run(finalSql);
			const data = await reader.getRowObjects();
			/* DuckDB returns BIGINT as a JS bigint, which JSON cannot serialise —
			 * the real Excel source normalises too, so this does the same. */
			const rows = data.map((r: any) =>
				Object.fromEntries(
					Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]),
				),
			);
			return { data: rows, count: rows.length };
		},
	};

	const toolsPath = require.resolve('../src/tools');
	require.cache[toolsPath] = {
		id: toolsPath,
		filename: toolsPath,
		loaded: true,
		exports: { getAllTools: () => [tool] },
	} as never;
}

async function main() {
	await installFakeSource();

	/* No browser here, so nothing has pushed the contract. Read it from the
	 * frontend source instead — the real one, because the check below compares a
	 * published view's imports against it. */
	const { setRegisteredContract } = await import('../src/dashboard-builder/contract/registered');
	const { readContractFromSource } = await import('./read-contract');
	setRegisteredContract(await readContractFromSource());

	/* Imported after the stub is in place. */
	const { runResolver, listResolvers } = await import('../src/dashboard-builder/resolvers');
	const { enumerateTestCases } = await import('../src/dashboard-builder/params');

	const dir = path.join(__dirname, '..', 'dashboard-programs', 'demo');
	const grants = [SOURCE_ID];

	console.log('\n=== declarations ===');
	const summaries = await listResolvers(dir);
	for (const s of summaries) {
		const params = Object.entries(s.params)
			.map(([k, v]) => `${k}${v.optional ? '?' : ''}:${v.type}`)
			.join(', ');
		console.log(
			`  ${s.name}(${params})  v=${s.version}` +
				(s.errors.length ? `  BLOCKED: ${s.errors.join('; ')}` : ''),
		);
	}

	console.log('\n=== runs: defaults, and each filter value ===');
	let failures = 0;
	for (const s of summaries) {
		if (s.errors.length) {
			failures++;
			continue;
		}
		for (const params of enumerateTestCases(s.params, 6)) {
			try {
				const result = await runResolver({
					dashboardId: 'demo',
					dir,
					name: s.name,
					params: params as Record<string, unknown>,
					grants,
				});
				const first = result.data[0] ?? {};
				const shown = Object.entries(first)
					.slice(0, 3)
					.map(([k, v]) => `${k}=${v}`)
					.join(' ');
				console.log(
					`  ${s.name.padEnd(11)} ${JSON.stringify(params).padEnd(38)} ` +
						`rows=${String(result.meta.rowCount).padStart(3)} ` +
						`${result.meta.elapsedMs}ms  ${shown}` +
						(result.meta.truncated ? '  [TRUNCATED]' : ''),
				);
				if (result.meta.rowCount === 0) {
					console.log('      ^ zero rows — is that genuinely the answer?');
				}
			} catch (err: any) {
				failures++;
				console.log(`  ${s.name}  ${JSON.stringify(params)}  FAILED [${err.code}] ${err.message}`);
			}
		}
	}

	console.log('\n=== the guards that should refuse ===');
	const expectFailure = async (label: string, run: () => Promise<unknown>) => {
		try {
			await run();
			console.log(`  ${label}: NOT REFUSED — that is a bug`);
			failures++;
		} catch (err: any) {
			console.log(`  ${label}: refused [${err.code}] ${err.message.split('\n')[0]}`);
		}
	};

	await expectFailure('ungranted source', () =>
		runResolver({ dashboardId: 'demo', dir, name: 'totals', grants: [], params: {} }),
	);
	await expectFailure('undeclared parameter', () =>
		runResolver({ dashboardId: 'demo', dir, name: 'totals', grants, params: { nope: 1 } }),
	);
	await expectFailure('value outside the declared enum', () =>
		runResolver({ dashboardId: 'demo', dir, name: 'totals', grants, params: { version: '12 + 0' } }),
	);
	await expectFailure('unknown resolver', () =>
		runResolver({ dashboardId: 'demo', dir, name: 'nope', grants, params: {} }),
	);

	/* ------------------ the surface the browser actually calls ----------------- */

	console.log('\n=== registry and view compile ===');
	const { getDashboard, listDashboards } = await import('../src/dashboard-builder/registry');

	const catalogue = await listDashboards();
	console.log(`  catalogue: ${catalogue.map((d) => `${d.id}${d.valid ? '' : ' (INVALID)'}`).join(', ')}`);

	const state = await getDashboard('demo');
	console.log(`  title      ${state.title}`);
	console.log(`  valid      ${state.valid}`);
	console.log(`  view       v=${state.viewVersion} ${state.view?.bytes ?? 0} bytes`);
	console.log(`  grants     ${state.grants.sources.join(', ') || 'none'}`);
	console.log(`  resolvers  ${state.resolvers.map((r) => r.name).join(', ')}`);
	if (state.violations.length) {
		for (const v of state.violations) console.log(`  violation  ${v.rule}: ${v.detail}`);
	}

	/**
	 * The compiled module must be free of bare imports and must read the runtime
	 * global — that is what makes it loadable in a page that already has React.
	 */
	const code = state.view?.code ?? '';
	const moduleChecks: [string, boolean][] = [
		['view compiled', Boolean(code)],
		['no bundled react', !/from\s*["']react["']/.test(code)],
		['no bare @contract import', !/from\s*["']@contract["']/.test(code)],
		['reads the runtime global', code.includes('__DASH_BUILDER_RUNTIME__')],
		['default export present', /export\s*\{[^}]*as default|export\s+default/.test(code)],
	];
	for (const [label, ok] of moduleChecks) {
		console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
		if (!ok) failures++;
	}

	/**
	 * Every name the view imports must exist in the published contract.
	 *
	 * This is the check that stops a view compiling against a name the frontend
	 * does not export — which would otherwise surface as `undefined is not a
	 * function`, three panels down, at render time.
	 */
	const { contractExports } = await import('../src/dashboard-builder/contract/runtime');
	const CONTRACT_EXPORTS = contractExports();
	const viewSource = require('fs').readFileSync(
		require('path').join(state.dir, 'view.tsx'),
		'utf8',
	) as string;
	const imported = (viewSource.match(/import\s*\{([\s\S]*?)\}\s*from\s*['"]@contract['"]/)?.[1] ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const unknown = imported.filter((n) => !(CONTRACT_EXPORTS as readonly string[]).includes(n));
	console.log(
		unknown.length
			? `  FAIL view imports names the contract does not export: ${unknown.join(', ')}`
			: `  ok   all ${imported.length} imported names are in CONTRACT_EXPORTS`,
	);
	if (unknown.length) failures++;

	console.log(failures === 0 ? '\nOK — all checks passed\n' : `\n${failures} failure(s)\n`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
