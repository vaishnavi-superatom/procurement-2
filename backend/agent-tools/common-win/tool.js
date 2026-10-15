#!/usr/bin/env node
/**
 * The agent's tools, in Node (the backend's own runtime): called from PowerShell
 * through the <name>.ps1 launchers beside this file, and for `query` also from
 * common/query on Linux and macOS, so every OS parses a query call the same way.
 *
 *   node tool.js <tool> [args...]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

/** Per tool: endpoint flags (`--x value`), switches (`--x`), and what a bare argument is. */
const SPECS = {
	'sources': {
		help: ['sources — the data sources this run can query.', '', '  tools/sources        toolId, name, type, what it holds',
			'', 'The table list is NOT here: tools/find-schema and tools/get-schema serve it.'],
	},
	'find-concept': {
		flags: { '--kind': 'kind', '--limit': 'limit' }, positional: 'q',
		help: ['find-concept — what this project defines, by name, alias or purpose.', '',
			'  tools/find-concept "<term>" ...          search; no term lists them all',
			'  tools/find-concept --kind <kind> "<term>"  one kind (formula, definition, filter, lookup, join, invariant)'],
	},
	'get-concept': {
		switches: { '--invariants': ['invariants', '1'] }, positional: 'name',
		help: ['get-concept — a concept\'s full body, and what it requires.', '',
			'  tools/get-concept "<name>" ...           one or more by name',
			'  tools/get-concept --invariants           the rules for every question'],
	},
	'find-entity': {
		switches: { '--types': ['types', '1'] }, flags: { '--type': 'type', '--limit': 'limit' }, positional: 'q',
		help: ['find-entity — the id behind a name, code or number.', '',
			'  tools/find-entity "<text>"               what it is, its id and the filter to use',
			'  tools/find-entity --type "<type>" "<text>"   ranked candidates of one type',
			'  tools/find-entity --types                the types that can be resolved'],
	},
	'get-entity': {
		flags: { '--type': 'type', '--name': 'name' }, positional: 'id',
		help: ['get-entity — one record, and how to filter on it.', '',
			'  tools/get-entity --type "<type>" <id>',
			'  tools/get-entity --type "<type>" --name "<name>"'],
	},
	'find-schema': {
		flags: { '--table': 'table', '--limit': 'limit' }, positional: 'q',
		help: ['find-schema — which table and column holds something.', '',
			'  tools/find-schema "<term>" ...           columns matching the terms',
			'  tools/find-schema --table "<table>"      every column of one table'],
	},
	'get-schema': {
		switches: { '--json': ['json', '1'] }, positional: 'path',
		help: ['get-schema — columns, types, keys and joins.', '',
			'  tools/get-schema "<table>" ...           a whole table',
			'  tools/get-schema "<table>.<column>"      one column'],
	},
	'query': {
		help: process.platform === 'win32' ? ['query — run read-only SQL against one source.', '',
			"  @'", '  SELECT ... WHERE PartyId = @p AND d >= \'2026-04-01\'',
			"  '@ | tools/query \"<source>\" - [--param p=<value>] [--limit N] [--save data/<name>.json]", '',
			"The SQL is piped in as a literal here-string, so quotes, % and $ reach the database untouched;",
			"'@ must start its own line. If PowerShell rejects the command, write the SQL to sql/<name>.sql and run",
			'  tools/query "<source>" --file sql/<name>.sql',
			'SELECT/WITH only, one statement, up to 5,000 rows. Read large saved data files with Python and print only what you need.',
			'More than 25 rows: all of them go to data/<ref>.json, ready for a table or chart file, and the first 5 print.',
			'--save writes all rows to that file as well, for :::graph.',
			'tools/query --wait <id>: the result of a query still running, by the id it printed.']
		: ['query — run read-only SQL against one source.', '',
			"  tools/query \"<source>\" - [--param p=<value>] [--limit N] [--save data/<name>.json] <<'SQL'",
			"  SELECT ... WHERE PartyId = @p AND d >= '2026-04-01'",
			'  SQL', '',
			"The SQL on stdin is untouched by the shell. Params also as '{\"p\":\"v\"}'. Options go anywhere.",
			'If the shell rejects the command, write the SQL to sql/<name>.sql and run  tools/query "<source>" --file sql/<name>.sql',
			'SELECT/WITH only, one statement, up to 5,000 rows. Read large saved data files with Python and print only what you need.',
			'More than 25 rows: all of them go to data/<ref>.json, ready for a table or chart file, and the first 5 print.',
			'--save writes all rows to that file as well, for :::graph.',
			'tools/query --wait <id>: the result of a query still running, by the id it printed.'],
	},
	'run-tool': {
		positionals: ['tool', 'params'],
		help: ["run-tool — run one of this project's pre-built business tools.", '',
			'  tools/run-tool                                list the tools and their parameters',
			"  tools/run-tool \"<id>\" '{\"param\":\"value\"}'     run one, with its parameters as JSON", '',
			"A concept with a program runs as: tools/run-tool concept '{\"method\":\"run\",\"name\":\"<concept>\",\"params\":{...}}'"],
	},
	'run-resolver': {
		rows: true,
		help: ['run-resolver — run one panel of the dashboard in view, at any filter values.', '',
			'  tools/run-resolver "<panel>"                                            the panel as it stands',
			'  tools/run-resolver "<panel>" --param from=2026-04-01 --param branch=[16]   with these filter values', '',
			'A value that is JSON (a number, a list) is passed as that; anything else as text.',
			'The same call the panel makes, with its own grants. Panels are the files in dashboard/data/.',
			'Prints like query; more than 25 rows go to data/<panel>.json.'],
	},
	'semantic': {
		rows: true,
		help: ['semantic — the project\'s governed metrics; ask a model before deriving a number in SQL.', '',
			'  tools/semantic models                     every model, one line each',
			'  tools/semantic manifest <model>           its metrics, dimensions and filters',
			'  tools/semantic search "<text>"            metrics matching some wording',
			'  tools/semantic describe <model> <name>    one metric or field in full',
			"  tools/semantic explain '<query json>'     the SQL it would run, and why",
			"  tools/semantic run '<query json>'         run it; prints like query", '',
			'A query is {"model","metrics":[],"dimensions":[],"filters":[]}. --source <id> picks the source.'],
	},
};

/** The dashboard in view: the one the question was asked from, else the one last copied in. */
function dashboardInView() {
	if (process.env.SA_DASHBOARD_ID) return process.env.SA_DASHBOARD_ID;
	try { return String(JSON.parse(fs.readFileSync('dashboard/dashboard.json', 'utf8')).id || ''); } catch { return ''; }
}

/**
 * `run-resolver "<panel>" [--param name=value ...]` as endpoint parameters.
 *
 * --param, like query's: Windows PowerShell strips the double quotes inside an
 * argument passed to a program, so '{"branch":[16]}' arrives as {branch:[16]} —
 * measured: three rejected calls and ~30 s before the agent found an escaping
 * that survived. A value that parses as JSON (a number, a list) is passed as
 * that; anything else as text. A JSON object still works when its quotes survive.
 */
function resolverParams(argv) {
	const [name, ...rest] = argv;
	const out = [['name', name ?? '']];
	const values = {};
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === '--param') {
			const kv = rest[++i] ?? '';
			const eq = kv.indexOf('=');
			if (eq < 1) fail(`run-resolver: --param needs name=value, got "${kv}"`);
			const raw = kv.slice(eq + 1);
			try { values[kv.slice(0, eq)] = JSON.parse(raw); } catch { values[kv.slice(0, eq)] = raw; }
			continue;
		}
		if (a.trim().startsWith('{')) { try { Object.assign(values, JSON.parse(a)); continue; } catch { /* fall through */ } }
		fail(`run-resolver: unexpected argument "${a}". Filters go as --param name=value.`);
	}
	if (Object.keys(values).length) out.push(['params', JSON.stringify(values)]);
	return out;
}

/** `semantic <verb> ...` as endpoint parameters. */
function semanticParams(argv) {
	const [verb, ...rest] = argv;
	const out = [['verb', verb ?? '']];
	const dashboard = dashboardInView();
	if (dashboard) out.push(['dashboard', dashboard]);
	const args = [];
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === '--source') { out.push(['source', rest[++i] ?? '']); continue; }
		args.push(rest[i]);
	}
	if (verb === 'manifest') out.push(['model', args[0] ?? '']);
	else if (verb === 'describe') out.push(['model', args[0] ?? ''], ['name', args[1] ?? '']);
	else if (verb === 'search') out.push(['text', args.join(' ')]);
	else if (verb === 'explain' || verb === 'run' || verb === 'validate') out.push(['query', args[0] ?? '']);
	return out;
}

/** Rows above this go to a table file; the agent sees a sample instead of a flood. */
const FILE_THRESHOLD = 25;
/** The data bridge's own limit: nothing that would have returned is cut short. */
const TIMEOUT_MS = 300_000;

function fail(msg, code = 2) { process.stderr.write(msg + '\n'); process.exit(code); }

function readStdin() {
	return new Promise((resolve, reject) => {
		if (process.stdin.isTTY) return resolve('');
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', c => { data += c; });
		process.stdin.on('end', () => resolve(data));
		process.stdin.on('error', reject);
	});
}

function get(endpoint, params) {
	const base = process.env.SA_BRIDGE_URL;
	const url = new URL(`${base.replace(/\/$/, '')}/tools/${endpoint}`);
	for (const [k, v] of params) url.searchParams.append(k, v);
	const lib = url.protocol === 'https:' ? https : http;
	const headers = process.env.SA_CONTEXT_TOKEN ? { 'x-sa-context': process.env.SA_CONTEXT_TOKEN } : {};
	return new Promise((resolve, reject) => {
		const req = lib.get(url, { headers }, res => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		});
		req.setTimeout(TIMEOUT_MS, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
		req.on('error', reject);
	});
}

/** Shared flag parsing for every tool but query. */
function paramsFor(spec, argv) {
	const out = [];
	if (spec.positionals) {
		spec.positionals.forEach((name, i) => { if (argv[i] !== undefined) out.push([name, argv[i]]); });
		return out;
	}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (spec.switches?.[a]) { out.push(spec.switches[a]); continue; }
		if (spec.flags?.[a]) { out.push([spec.flags[a], argv[++i] ?? '']); continue; }
		if (spec.positional) out.push([spec.positional, a]);
	}
	return out;
}

const label = k => {
	const w = k.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
	return w.charAt(0).toUpperCase() + w.slice(1);
};

/** Above the threshold, or with --save, the rows go to a file in the answer's format; a sample prints. */
function printQueryResult(raw, save) {
	let res;
	try { res = JSON.parse(raw); } catch { process.stdout.write(raw.endsWith('\n') ? raw : raw + '\n'); return; }
	const rows = res && Array.isArray(res.rows) ? res.rows : null;
	if (!rows || (rows.length <= FILE_THRESHOLD && !save)) { process.stdout.write(raw.endsWith('\n') ? raw : raw + '\n'); return; }
	// A cut-off result saved for a chart would draw part of the data as all of it.
	if (save && res.truncated) {
		fail(`Not saved (the query finished): only ${rows.length} of ${res.count} rows came back, so ${save} would be incomplete. Aggregate or narrow in SQL until the result fits, then save again.`, 3);
	}
	const keys = [];
	for (const r of rows) for (const k of Object.keys(r || {})) if (!keys.includes(k)) keys.push(k);
	const file = save || `data/${String(res.ref || res.panel || `query-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '-')}.json`;
	fs.mkdirSync('data', { recursive: true });
	// A cut-off result says so in the file, so a table built from it is labelled partial, never shown as complete.
	const partial = res.truncated ? { truncated: true, total: res.count } : {};
	fs.writeFileSync(file, JSON.stringify({ columns: keys.map(k => ({ key: k, label: label(k) })), rows, ...partial }), 'utf8');
	const { rows: _all, ...rest } = res;
	process.stdout.write(JSON.stringify({
		...rest, file,
		note: save ? `All ${rows.length} rows saved to ${file}; the first 5 are shown here.`
			: res.truncated ? `Only the first ${rows.length} of ${res.count} rows are in ${file}; a table from it is shown as partial. Aggregate or narrow in SQL for a complete answer. The first 5 are shown here.`
			: `All ${rows.length} returned rows are in ${file}, ready for a table or chart file; the first 5 are shown here.`,
		rows: rows.slice(0, 5),
	}, null, 2) + '\n');
}

/**
 * Every query leaves its output here under its id. The harness can return before
 * a slow query finishes and the agent then loses the handle to collect the rest;
 * the id is in the text it did read, so --wait can always fetch the result.
 */
const RESULTS = path.join(process.cwd(), '.query-results');

/** Copy everything printed from here on into the id's result file when the process ends. */
function recordAs(id) {
	fs.mkdirSync(RESULTS, { recursive: true });
	fs.writeFileSync(path.join(RESULTS, `${id}.started`), String(Date.now()));
	let printed = '';
	for (const stream of [process.stdout, process.stderr]) {
		const write = stream.write.bind(stream);
		stream.write = (chunk, ...rest) => { printed += String(chunk); return write(chunk, ...rest); };
	}
	process.on('exit', code => {
		try {
			const out = path.join(RESULTS, `${id}.out`);
			fs.writeFileSync(path.join(RESULTS, `${id}.rc`), String(code ?? 0));
			fs.writeFileSync(`${out}.tmp`, printed);
			fs.renameSync(`${out}.tmp`, out);
			fs.rmSync(path.join(RESULTS, `${id}.started`), { force: true });
		} catch { /* the result still printed */ }
	});
}

async function waitQuery(id) {
	if (!id) fail('query --wait needs the id the query printed.');
	process.stdout.write(`waiting for query ${id} — if this returns before the result, run tools/query --wait ${id} again.\n`);
	const file = (ext) => path.join(RESULTS, `${id}.${ext}`);
	// Under the harness's usual wait, so this call itself comes back with an answer.
	for (let i = 0; i < 25; i++) {
		if (fs.existsSync(file('out'))) {
			process.stdout.write(fs.readFileSync(file('out'), 'utf8'));
			process.exit(Number(fs.existsSync(file('rc')) ? fs.readFileSync(file('rc'), 'utf8') : 0) || 0);
		}
		// Each command runs in its own sandbox and cannot see the query's process, so
		// age decides: past the bridge's 300s limit with no result, it is gone.
		let started = 0;
		try { started = Number(fs.readFileSync(file('started'), 'utf8')); } catch { /* unknown id */ }
		if (Date.now() - started > 310_000 && !fs.existsSync(file('out'))) fail(`query ${id} left no result — run the query again.`, 4);
		await new Promise(r => setTimeout(r, 1000));
	}
	process.stdout.write(`query ${id} is still running — run tools/query --wait ${id} again. Do not re-run the query.\n`);
}

/** The usage example in this machine's own shell syntax. */
const QUERY_USAGE = process.platform === 'win32'
	? "@' (newline) SELECT ... (newline) '@ | tools/query \"<source>\" -   or   tools/query \"<source>\" --file sql/<name>.sql"
	: "tools/query \"<source>\" - <<'SQL' (newline) SELECT ... (newline) SQL   or   tools/query \"<source>\" --file sql/<name>.sql";
const QUERY_OPTIONS = '--save data/<name>.json, --limit N, --param name=value, --file <sql file>, --wait <id>';

/** Params JSON as written, or as PowerShell 5.1 leaves it after stripping the inner quotes ({p:1,d:2025-04-01}). */
function parseParams(text) {
	let v;
	try { v = JSON.parse(text); } catch {
		const body = text.trim().match(/^\{([\s\S]*)\}$/);
		if (!body) return null;
		v = {};
		for (const pair of body[1].split(',').filter(p => p.trim())) {
			const at = pair.indexOf(':');
			if (at < 1) return null;
			const key = pair.slice(0, at).trim().replace(/^["']|["']$/g, '');
			const raw = pair.slice(at + 1).trim().replace(/^["']|["']$/g, '');
			v[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
		}
	}
	if (Array.isArray(v) && v.length <= 1) v = v[0] ?? {};   // [] is none; [{"p":1}] means {"p":1}
	return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/**
 * Every way the agent writes a query call, read the same on every OS: options in
 * any position and as --x value or --x=value; the source is the first plain
 * argument, the SQL the second (or - for stdin, or --file). A call that cannot be
 * read is refused with what is wrong, never sent with a flag mistaken for SQL.
 */
function parseQueryArgs(argv) {
	const positional = [];
	const named = {};
	let save = '', limit = '', file = '', stdin = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-') { stdin = true; continue; }
		const opt = a.match(/^--?([a-z][a-z-]*)(?:=([\s\S]*))?$/i);
		if (opt) {
			const name = opt[1].toLowerCase();
			if (!['save', 'limit', 'param', 'params', 'file'].includes(name)) {
				fail(`query: unknown option "${a}". Options: ${QUERY_OPTIONS}. Usage: ${QUERY_USAGE}`);
			}
			const value = opt[2] ?? argv[++i];
			if (value === undefined || value === '') fail(`query: ${a} needs a value.`);
			if (name === 'save') save = value.replace(/\\/g, '/');
			else if (name === 'limit') limit = value;
			else if (name === 'file') file = value;
			else if (name === 'params') {
				const v = parseParams(value);
				if (!v) fail(`query: --params must be a JSON object, got ${value}. Or use --param name=value.`);
				Object.assign(named, v);
			} else {
				const eq = value.indexOf('=');
				if (eq < 1) fail(`query: --param needs name=value, got "${value}".`);
				named[value.slice(0, eq)] = value.slice(eq + 1);
			}
			continue;
		}
		// A params object or array where the source and SQL are already given.
		if (positional.length >= 1 && /^\s*[[{]/.test(a)) {
			const v = parseParams(a);
			if (!v) fail(`query: cannot read params ${a}. Use --param name=value, one per parameter.`);
			Object.assign(named, v);
			continue;
		}
		positional.push(a);
	}
	const [source, sqlArg, ...extra] = positional;
	if (!source) fail(`query: no source. Usage: ${QUERY_USAGE}`);
	if (extra.length) fail(`query: unexpected argument "${extra[0]}". Options: ${QUERY_OPTIONS}.`);
	const given = [stdin, sqlArg !== undefined, !!file].filter(Boolean).length;
	if (given > 1) fail('query: give the SQL one way only: piped in with -, as an argument, or with --file.');
	if (save && !/^data\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(save)) fail(`query: --save needs a path like data/<name>.json, got "${save}".`);
	if (limit && !/^\d+$/.test(limit)) fail(`query: --limit needs a whole number, got "${limit}".`);
	// No SQL named any way: piped in without the "-" (a common slip); runQuery looks at stdin.
	return { source, sqlArg, stdin, file, save, limit, named, implicit: given === 0 };
}

/** Stdin when something is already being piped in; '' when nothing arrives at once, so an idle stdin never hangs the call. */
function readPipedStdin(waitMs) {
	return new Promise(resolve => {
		if (process.stdin.isTTY) return resolve('');
		let data = '', started = false;
		const done = () => { clearTimeout(timer); process.stdin.pause(); resolve(data); };
		const timer = setTimeout(() => { if (!started) done(); }, waitMs);
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', c => { started = true; data += c; });
		process.stdin.on('end', done);
		process.stdin.on('error', done);
	});
}

async function runQuery(argv) {
	const q = parseQueryArgs(argv);
	let sql = q.sqlArg ?? '';
	if (q.stdin) {
		sql = await readStdin();
		if (!sql.trim()) fail(`query: no SQL on stdin. Usage: ${QUERY_USAGE}`);
	}
	if (q.implicit) {
		sql = await readPipedStdin(500);
		if (!sql.trim()) fail(`query: no SQL. Usage: ${QUERY_USAGE}`);
	}
	if (q.file) {
		try { sql = fs.readFileSync(q.file, 'utf8'); }
		catch (e) { fail(`query: cannot read --file ${q.file} (${e.code ?? e.message}).`); }
		if (!sql.trim()) fail(`query: ${q.file} is empty.`);
	}
	const params = [['source', q.source], ['sql', sql.replace(/^\ufeff/, '').trim()]];
	if (q.limit) params.push(['limit', q.limit]);
	if (Object.keys(q.named).length) params.push(['params', JSON.stringify(q.named)]);

	// First, before the query can take long: a still-running query must not look
	// like an empty result, and the agent needs the id to collect it later.
	const id = `q${String(Date.now()).slice(-5)}${process.pid}`;
	process.stdout.write(`query running (id ${id}) — results print below when it finishes. If this command returns before they do, run: tools/query --wait ${id}   Never re-run the query.\n`);
	recordAs(id);
	let body;
	try { body = await get('query', params); }
	catch (e) {
		if (e.code === 'TIMEOUT') fail('query: exceeded 300s and was cancelled — no rows were returned. Narrow the date window, aggregate in SQL, or filter harder. This is NOT an empty result.', 28);
		fail(`query: could not reach the data bridge (${e.message}).`, 7);
	}
	printQueryResult(body, q.save);
}

async function main() {
	const [tool, ...argv] = process.argv.slice(2);
	const spec = SPECS[tool];
	if (!spec) fail(`unknown tool "${tool}". Tools: ${Object.keys(SPECS).join(', ')}`);
	if (argv[0] === '-h' || argv[0] === '--help' || (tool === 'query' && !argv.length)) {
		process.stdout.write(spec.help.join('\n') + '\n');
		return;
	}
	if (tool === 'query' && argv[0] === '--wait') return waitQuery(argv[1]);
	if (!process.env.SA_BRIDGE_URL) fail(`${tool}: SA_BRIDGE_URL is not set — this run has no backend.`);
	if (tool === 'query') return runQuery(argv);
	let params = tool === 'semantic' ? semanticParams(argv) : paramsFor(spec, argv);
	if (tool === 'run-resolver') params = [['dashboard', dashboardInView()], ...resolverParams(argv)];
	let body;
	try { body = await get(tool, params); }
	catch (e) { fail(`${tool}: could not reach the data bridge (${e.message}).`, 7); }
	// Row results print like query: more than 25 rows go to a table file.
	if (spec.rows) printQueryResult(body);
	else process.stdout.write(body);
}

main().catch(e => fail(String(e?.stack ?? e), 1));
