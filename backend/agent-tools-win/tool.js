#!/usr/bin/env node
/**
 * The agent's tools on Windows, called from PowerShell through the <name>.ps1
 * launchers beside this file. Same bridge endpoints and the same output as the
 * bash tools in agent-tools/, which Linux keeps using unchanged.
 *
 * Node only (the backend's own runtime): no bash, curl or python3, which a
 * Windows server may not have and PowerShell cannot run directly.
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
		help: ['query — run read-only SQL against one source.', '',
			"  @'", '  SELECT ... WHERE PartyId = @p AND d >= \'2026-04-01\'',
			"  '@ | tools/query \"<source>\" - [--param p=<value>] [--limit N]", '',
			"The SQL is piped in as a literal here-string, so quotes, % and $ reach the database untouched;",
			"'@ must start its own line. SELECT/WITH only, one statement, 200 rows by default.",
			'More than 25 rows: all of them go to data/<ref>.json, ready for :::table, and the first 5 print.'],
	},
};

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

/** Above the threshold the rows go to a table file in the answer's format; a sample prints. */
function printQueryResult(raw) {
	let res;
	try { res = JSON.parse(raw); } catch { process.stdout.write(raw.endsWith('\n') ? raw : raw + '\n'); return; }
	const rows = res && Array.isArray(res.rows) ? res.rows : null;
	if (!rows || rows.length <= FILE_THRESHOLD) { process.stdout.write(raw.endsWith('\n') ? raw : raw + '\n'); return; }
	const keys = [];
	for (const r of rows) for (const k of Object.keys(r || {})) if (!keys.includes(k)) keys.push(k);
	const file = `data/${res.ref || `query-${Date.now()}`}.json`;
	fs.mkdirSync('data', { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ columns: keys.map(k => ({ key: k, label: label(k) })), rows }), 'utf8');
	const { rows: _all, ...rest } = res;
	process.stdout.write(JSON.stringify({
		...rest, file,
		note: `All ${rows.length} returned rows are in ${file}, ready for :::table; the first 5 are shown here.`,
		rows: rows.slice(0, 5),
	}, null, 2) + '\n');
}

async function runQuery(argv) {
	const [source, sqlArg, ...rest] = argv;
	if (!source) fail('usage: see tools/query -h');
	let sql = sqlArg ?? '';
	if (sql === '-') {
		sql = await readStdin();
		if (!sql.trim()) fail("query: no SQL on stdin. Pipe it in: @' (newline) SELECT ... (newline) '@ | tools/query \"<source>\" -");
	}
	const params = [['source', source], ['sql', sql.replace(/^﻿/, '').trim()]];
	const named = {};
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === '--limit') { params.push(['limit', rest[++i] ?? '']); continue; }
		if (a === '--param') {
			const kv = rest[++i] ?? '';
			const eq = kv.indexOf('=');
			if (eq < 1) fail(`query: --param needs name=value, got "${kv}"`);
			named[kv.slice(0, eq)] = kv.slice(eq + 1);
			continue;
		}
		// A JSON object, as the Linux tool takes it, still works when its quotes survive.
		if (/^\s*[[{]/.test(a)) {
			try {
				let v = JSON.parse(a);
				if (Array.isArray(v) && v.length <= 1) v = v[0] ?? {};   // [] is none; [{"p":1}] means {"p":1}
				if (v && typeof v === 'object' && !Array.isArray(v)) { Object.assign(named, v); continue; }
			} catch { /* fall through */ }
		}
		fail(`query: unexpected argument "${a}". Parameters go as --param name=value.`);
	}
	if (Object.keys(named).length) params.push(['params', JSON.stringify(named)]);

	// First, before the query can take long: a still-running query must not look
	// like an empty result when the harness stops waiting.
	process.stdout.write('query running — results print below when it finishes; if nothing follows yet, it is still running: wait for it, do not re-run it.\n');
	let body;
	try { body = await get('query', params); }
	catch (e) {
		if (e.code === 'TIMEOUT') fail('query: exceeded 300s and was cancelled — no rows were returned. Narrow the date window, aggregate in SQL, or filter harder. This is NOT an empty result.', 28);
		fail(`query: could not reach the data bridge (${e.message}).`, 7);
	}
	printQueryResult(body);
}

async function main() {
	const [tool, ...argv] = process.argv.slice(2);
	const spec = SPECS[tool];
	if (!spec) fail(`unknown tool "${tool}". Tools: ${Object.keys(SPECS).join(', ')}`);
	if (argv[0] === '-h' || argv[0] === '--help' || (tool === 'query' && !argv.length)) {
		process.stdout.write(spec.help.join('\n') + '\n');
		return;
	}
	if (!process.env.SA_BRIDGE_URL) fail(`${tool}: SA_BRIDGE_URL is not set — this run has no backend.`);
	if (tool === 'query') return runQuery(argv);
	try { process.stdout.write(await get(tool, paramsFor(spec, argv))); }
	catch (e) { fail(`${tool}: could not reach the data bridge (${e.message}).`, 7); }
}

main().catch(e => fail(String(e?.stack ?? e), 1));
