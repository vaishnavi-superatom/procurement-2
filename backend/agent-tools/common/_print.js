// _print.js — shared by query, run-resolver and semantic: prints a tool's result.
//
//   node _print.js <response-file> [data/<name>.json]
//
// With a second argument (query --save), every row goes to that file whatever the count.
//
// A result of more than 25 rows goes to data/<name>.json in the answer's table
// format, ready for :::table, and only the first 5 print — a long result printed
// in full flooded the agent's view, and it re-ran the query just to see it.
// Node, not python3: node is the backend's own runtime, so it is on every
// machine the tools run on, Git Bash on Windows included.
'use strict';
const fs = require('fs');

const FILE_THRESHOLD = 25;

const raw = fs.readFileSync(process.argv[2], 'utf8');
const save = process.argv[3] || '';
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');

let res;
try { res = JSON.parse(raw); } catch { out(raw); process.exit(0); }   // an error or usage message: as is

const rows = res && Array.isArray(res.rows) ? res.rows : null;
if (!rows || (rows.length <= FILE_THRESHOLD && !save)) { out(raw); process.exit(0); }
if (save && !/^data\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(save)) {
	out(`Not saved: --save needs a path like data/<name>.json, got ${save}.`); process.exit(2);
}
// A cut-off result saved for a chart would draw part of the data as all of it.
if (save && res.truncated) {
	out(`Not saved (the query finished): only ${rows.length} of ${res.count} rows came back, so ${save} would be incomplete. Aggregate or narrow in SQL until the result fits, then save again.`);
	process.exit(3);
}

const keys = [];
for (const r of rows) for (const k of Object.keys(r || {})) if (!keys.includes(k)) keys.push(k);
const label = (k) => {
	const w = k.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
	return w.charAt(0).toUpperCase() + w.slice(1);
};

const name = String(res.ref || res.panel || `query-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '-');
const file = save || `data/${name}.json`;
fs.mkdirSync('data', { recursive: true });
// A cut-off result says so in the file, so a table built from it is labelled partial.
fs.writeFileSync(file, JSON.stringify({ columns: keys.map((k) => ({ key: k, label: label(k) })), rows, ...(res.truncated ? { truncated: true, total: res.count } : {}) }), 'utf8');

const { rows: _all, ...rest } = res;
out(JSON.stringify({
	...rest,
	file,
	note: save ? `All ${rows.length} rows saved to ${file}; the first 5 are shown here.`
		: `All ${rows.length} returned rows are in ${file}, ready for a table or chart file; the first 5 are shown here.`,
	rows: rows.slice(0, 5),
}, null, 2));
