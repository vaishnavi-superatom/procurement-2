import http from 'http';
import { searchConcepts, getConceptCatalog, resolveConcepts, getInvariants } from '../../../database/postgres/src/project-data-db/concepts';
import type { ConceptRecord } from '../../../database/postgres/src/project-data-db/concepts';
import { getProjectSources } from '../../../database/postgres/src/project-data-db/project-sources';
import {
	resolveEntities, getEntityTypes, countMatchesByType, getEntityById, recognizePatterns,
} from '../../../database/postgres/src/project-data-db/entity-search';
import {
	searchDataSourceIndex, getIndexedTable, findIndexedTables, getIndexFreshness,
} from '../../../database/postgres/src/project-data-db/data-source-index';
import { getAllKbNodes, getKbNode, searchKbNodes } from '../../../database/postgres/src/project-data-db/kb-nodes';
import { getSourceManager } from '../sources';
import { getAllTools } from '../tools';
import { assertReadOnlySql } from '../sources/core/sql-guard';
import { resolveContextToken, withCapturedContext } from '@superatomai/sdk-node';
import { registerQueryRef } from './script-bridge';
import { noteUsage, noteQuery } from './run-usage';
import { renderConcept, loadedConcepts } from '../graph/compose';
import { runResolverForAgent, semanticForAgent } from '../agent/dashboard-tools';

/**
 * HTTP behind the agent's tools (`backend/agent-tools/*`).
 *
 * The tools are thin shell scripts; everything they know lives here. That split
 * is deliberate: the shell script is what every client can read and edit, while
 * the matching rules and output format stay in one typed place instead of being
 * reimplemented per deployment. Changing what a tool PRINTS needs no tool edit.
 *
 * Responses are text/plain, already laid out for a terminal — whatever a tool
 * prints lands in the agent's context, so the layout is part of the contract.
 */

const PAD = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function sendText(res: http.ServerResponse, status: number, body: string): void {
	res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
	res.end(body.endsWith('\n') ? body : body + '\n');
}

/** name + kind + aliases, one per line — the fallback when a search finds nothing. */
async function renderCatalog(kind: string | null): Promise<string> {
	const all = (await getConceptCatalog()).data.filter(c => !kind || c.kind === kind);
    const width = Math.min(Math.max(...all.map(c => c.name.length), 4) + 2, 40);
	const lines = all.map(c =>
		`${PAD(c.name, width)}${PAD(c.kind, 12)}${c.description || (c.aliases ?? []).join(', ')}`.trimEnd());
	return [
		`${all.length} concept(s)${kind ? ` of kind "${kind}"` : ''}:`,
		'',
		...lines,
		'',
		'get-concept "<name>" prints the full body.',
	].join('\n');
}

async function renderSearch(terms: string[], kind: string | null, limit: number, token?: string): Promise<string> {
	const out: string[] = [];
	for (const term of terms) {
		const r = await searchConcepts({ term, limit, kind });
		if (!r.data.length) {
			noteUsage(token, 'conceptMisses', [term]);
			// The count is the point: "nothing matched" and "nothing exists" are
			// different problems, and only one of them is the agent's to fix.
			out.push(`"${term}" — 0 of ${r.total} concepts matched. Run find-concept with no arguments to list them all.`);
			out.push('');
			continue;
		}
		const width = Math.min(Math.max(...r.data.map(c => c.name.length), 4) + 2, 40);
		out.push(`"${term}" — ${r.count} of ${r.total} concepts matched:`);
		for (const c of r.data) {
			// The description is what makes a hit decidable without fetching the
			// body; aliases only matter when there is no description yet.
			const tail = c.description || ((c.aliases ?? []).length ? `aliases: ${(c.aliases ?? []).join(', ')}` : '');
			out.push(`  ${PAD(c.name, width)}${PAD(c.kind, 12)}${PAD(c.matchedOn, 12)}${tail}`.trimEnd());
		}
		out.push('');
	}
	out.push('Searches names, aliases and one-line descriptions. A miss does not mean the rule is absent — list them all with no arguments.');
	out.push('get-concept "<name>" prints the full body.');
	return out.join('\n');
}

/**
 * Bodies for named concepts, plus everything they REQUIRE.
 *
 * The transitive pull is the point: a formula handed over without the filter it
 * depends on is a correct formula over the wrong rows, and the caller cannot know
 * what it never saw. Names are matched on aliases too, and a clear typo is
 * corrected out loud rather than silently.
 */
async function renderGetConcept(names: string[], invariantsOnly: boolean, token?: string): Promise<string> {
	if (invariantsOnly) {
		const inv = (await getInvariants()).data;
		if (!inv.length) return 'No invariants in this project.';
		const loaded = loadedConcepts(inv);
		return ['Project-wide rules — apply to every question:', '',
			...inv.map(c => renderConcept(c, loaded))].join('\n');
	}
	if (!names.length) return 'get-concept "<name>" ... — names come from find-concept. --invariants prints the always-on rules.';

	const r = await resolveConcepts({ names, includeInvariants: false });
	// What was asked for, not what came along as a requirement.
	const implied = new Set(r.implied.map(n => n.toLowerCase()));
	noteUsage(token, 'concepts', r.resolved.map((c: any) => c.name).filter((n: string) => !implied.has(n.toLowerCase())));
	noteUsage(token, 'conceptMisses', r.unmatched);
	const out: string[] = [];
	for (const c of r.corrected) out.push(`note: "${c.asked}" resolved to "${c.matched}".`);
	for (const s of r.suggestions) {
		// Deliberately resolves NOTHING here: binding to whichever sorted first
		// would swap one formula for another without saying so.
		out.push(`"${s.asked}" is too close to several concepts to choose: ${s.candidates.map(c => c.name).join(', ')}. Ask for one by name.`);
	}
	for (const n of r.unmatched) out.push(`"${n}" is not a concept. find-concept lists what exists.`);
	for (const d of r.danglingRequires) out.push(`warning: "${d.concept}" requires "${d.missing}", which does not exist — report this rather than working around it.`);
	if (out.length) out.push('');

	if (r.resolved.length) {
		const impliedSet = new Set(r.implied.map(n => n.toLowerCase()));
		const loaded = loadedConcepts(r.resolved);
		out.push('Apply as written; every filter stated is required.', '');
		for (const c of r.resolved) out.push(renderConcept(c, loaded, impliedSet.has(c.name.toLowerCase()) ? '  (required by another concept)' : ''));
	}
	return out.join('\n');
}

/**
 * The sources this run can query, with the exact toolId `query` needs.
 *
 * Read live from the source manager, not from a file written at prepare time: a
 * source that failed to connect, or one added since, would otherwise be listed
 * as available. `type` decides the SQL dialect, so it is part of the answer.
 */
async function renderSources(hasIdentity: boolean): Promise<string> {
	const tools = getSourceManager()?.getSourceTools() ?? [];
	if (!tools.length) return 'No data sources are connected for this run. You cannot query anything: say so rather than guessing.';
	// Without an identity every query is refused at the data seam. That is a
	// configuration fault, not missing data, and saying so is the honest answer.
	const identity = hasIdentity ? [] : ['',
		'WARNING: this run carries no identity, so every query will be refused. Report that as a',
		'configuration problem rather than as missing data, and return no components.'];

	const projectId = process.env.SUPERATOM_PROJECT_ID || '';
	const byId = new Map<string, any>();
	try {
		for (const s of (await getProjectSources(projectId)).data as any[]) byId.set(s.id, s);
	} catch { /* type is a nicety; the toolId is what matters */ }

	const out = [`${tools.length} source(s) you can query:`, ''];
	for (const t of tools) {
		const sourceId = t.id.replace(/_query$|_suiteql$/, '');
		const meta = byId.get(sourceId);
		// The tool description is written for the old flow and embeds the whole
		// table list — 16k tokens for one source. Cut it at that list: the tables
		// come from find-schema / get-schema on demand.
		const full = String(t.description ?? '').replace(/\s+/g, ' ').trim();
		const desc = full.split(/Available tables:/i)[0].trim().slice(0, 400);
		out.push(`toolId:  ${t.id}`);
		out.push(`name:    ${t.name}${meta?.type ? `  (${meta.type})` : ''}`);
		out.push(`about:   ${desc}`);
		out.push('');
	}
	out.push('Use the source EXACTLY as printed: tools/query "<source>" "<sql>". Never guess one.');
	out.push('Tables, columns and joins: tools/find-schema "<term>", then tools/get-schema "<table>".');
	return [...out, ...identity].join('\n');
}

/**
 * Rows one query returns to the TOOL. The agent never sees more than 25 printed rows
 * (larger results go to a data/ file with a 5-row sample), so this bounds the answer's
 * size, not the agent's context; a cut-off result is never saved or shown as complete.
 */
const QUERY_MAX_ROWS = 5000;

/**
 * Resolve what the agent typed to a real source tool: the exact toolId, the
 * source id without its suffix, or the source's name. Asking it to remember an
 * id like `mssql-722b94971107_query` exactly is a needless way to fail.
 */
function resolveSourceTool(wanted: string): { tool: any } | { error: string } {
	const tools = getSourceManager()?.getSourceTools() ?? [];
	if (!tools.length) return { error: 'No data sources are connected for this run.' };
	const w = wanted.trim().toLowerCase();
	const exact = tools.find((t: any) => t.id.toLowerCase() === w);
	if (exact) return { tool: exact };
	const byId = tools.filter((t: any) => t.id.toLowerCase().replace(/_query$|_suiteql$/, '') === w);
	if (byId.length === 1) return { tool: byId[0] };
	const byName = tools.filter((t: any) => String(t.name ?? '').toLowerCase().includes(w));
	if (byName.length === 1) return { tool: byName[0] };
	if (byName.length > 1) return { error: `"${wanted}" matches ${byName.length} sources: ${byName.map((t: any) => t.id).join(', ')}. Use one toolId.` };
	return { error: `"${wanted}" is not a source. Run tools/sources for the list.` };
}

/**
 * Run read-only SQL and print the rows, capped.
 *
 * The read-only assertion happens HERE, not only inside the source: the source
 * applies its own configured write mode, which a deployment may set to allow
 * writes. Agent SQL is read-only regardless of how the source is configured,
 * and that guarantee has to live on this path.
 */
/** The SQL as it arrived, capped: the agent never sees what its shell did to it otherwise. */
const asReceived = (sql: string, params?: Record<string, any>) =>
	`\n\nSQL as the database received it:\n${sql.length > 2000 ? `${sql.slice(0, 2000)} …` : sql}`
	+ (params && Object.keys(params).length ? `\n\nParams as received: ${JSON.stringify(params)}` : '');

const PARAMS_HELP = `Params are ONE JSON object of name → value, e.g. '{"p":"51778","from":"2025-04-01"}', `
	+ `each used in the SQL as @name.`;

/** Params the driver would misread are refused here, by what is wrong, not left to a database error. */
function checkParams(raw: string): { params?: Record<string, any>; error?: string } {
	let v: any;
	try { v = JSON.parse(raw); }
	catch { return { error: `params are not valid JSON: ${raw.slice(0, 200)}. ${PARAMS_HELP}` }; }
	// [] means none; [{"p":1}] means {"p":1} — the driver would read the array as positional p0.
	if (Array.isArray(v) && v.length === 0) return { params: undefined };
	if (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) v = v[0];
	if (!v || typeof v !== 'object' || Array.isArray(v)) {
		return { error: `params must be a JSON object, got ${Array.isArray(v) ? 'an array' : v === null ? 'null' : typeof v}: ${raw.slice(0, 200)}. ${PARAMS_HELP}` };
	}
	const bad = Object.entries(v).filter(([, x]) => x !== null && typeof x === 'object').map(([k]) => k);
	if (bad.length) return { error: `param ${bad.map(k => `"${k}"`).join(', ')} holds a list or object; each param is one value. ${PARAMS_HELP}` };
	return { params: v };
}

/**
 * A date literal with no quotes around it is never intended: the shell stripped
 * them (single-quoted SQL that itself contains single quotes). SQL Server reads
 * 2026-04-01 as 2021 — an error on datetime2, but on datetime a SILENT 1905
 * date that matches every row. Literals and comments are blanked before looking.
 */
function unquotedDate(sql: string): string | null {
	const code = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
	return code.match(/(?<![\w.'-])\d{4}-\d{1,2}-\d{1,2}(?![\w'-])/)?.[0] ?? null;
}

async function runQuery(req: http.IncomingMessage, params: URLSearchParams): Promise<string> {
	const wanted = params.get('source') ?? '';
	const sql = params.get('sql') ?? '';
	if (!wanted || !sql.trim()) return 'usage: query "<source>" "<sql>" [params-json]. Run tools/sources for the sources.';

	const found = resolveSourceTool(wanted);
	if ('error' in found) return found.error;

	try {
		assertReadOnlySql(sql, found.tool.name);
	} catch (err: any) {
		return `Refused: ${err?.message ?? 'not a single read-only statement'}`;
	}

	let queryParams: Record<string, any> | undefined;
	const rawParams = params.get('params');
	if (rawParams) {
		const checked = checkParams(rawParams);
		if (checked.error) return `Refused before running: ${checked.error}`;
		queryParams = checked.params;
	}

	const bareDate = unquotedDate(sql);
	if (bareDate) {
		return `Refused: ${bareDate} has no quotes around it, so it would be read as arithmetic, not a date. `
			+ `The shell removed them: the SQL was wrapped in single quotes and contains single quotes. `
			+ `Pass the SQL on stdin instead: tools/query "<source>" - <<'SQL' … SQL` + asReceived(sql);
	}

	const limit = Math.min(Number(params.get('limit')) || QUERY_MAX_ROWS, QUERY_MAX_ROWS);
	const ctx = resolveContextToken(req.headers['x-sa-context'] as string | undefined);
	let result: any;
	try {
		result = await withCapturedContext(ctx, () => found.tool.fn({ sql, params: queryParams, limit }));
	} catch (err: any) {
		// The statement beside the error: a database error about SQL the agent did
		// not write (its shell changed it) sent it rewriting correct logic nine times.
		console.error('[AgentTools] query failed:', err?.message ?? err);
		noteQuery(req.headers['x-sa-context'] as string | undefined, sql, String(err?.message ?? err).split('\n')[0].slice(0, 300));
		return `Tool failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 300)}` + asReceived(sql, queryParams);
	}

	noteQuery(req.headers['x-sa-context'] as string | undefined, sql);
	const rows: any[] = Array.isArray(result?.data) ? result.data : (Array.isArray(result) ? result : []);
	const meta = result?.metadata ?? {};
	const shown = rows.slice(0, limit);
	const total = meta.totalCount ?? result?.count ?? rows.length;
	const truncated = !!meta.truncated || total > shown.length;
	const ref = registerQueryRef(req.headers['x-sa-context'] as string | undefined, found.tool.id, sql, {
		data: rows, count: result?.count, metadata: meta,
	});

	return JSON.stringify({
		...(ref ? { ref } : {}),
		count: total,
		returned: shown.length,
		truncated,
		...(truncated ? { warning: `INCOMPLETE: only the first ${shown.length} of ${total} rows are shown. ` +
			`Do not compute totals, counts, shares or rankings from these rows — aggregate in SQL instead. ` +
			`Do not page through the rest with ROW_NUMBER() either: pick a top-N by the measure that matters, ` +
			`run one query, and report what is left out as coverage.` } : {}),
		...(meta.appliedPolicies?.length ? { restrictedBy: meta.appliedPolicies } : {}),
		rows: shown,
	}, null, 2);
}

/**
 * Date expressions are not entities. Refused rather than searched: a date
 * fuzzy-matches town names, and the agent cannot tell that from a real hit.
 * Deliberately not a bare month name — a party can be called "MARCH".
 */
const DATE_EXPRESSION = /^(?:(?:last|this|next|previous|past|current)\s+\w+|q[1-4](?:\s*(?:fy)?\s*\d{2,4})?|(?:fy|ytd|mtd|qtd)\s*\d{0,4}|yesterday|today|tomorrow|\d{4}|\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{4}-\d{2}(?:-\d{2})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4})$/i;

/** Permissive on purpose: a coding agent can weigh labelled candidates and query to disambiguate. */
const ENTITY_LIMIT = 10;
const ENTITY_MIN_SCORE = 0.05;

const holdsValues = (t: any) => t.resolution?.indexed && (t.resolution?.indexedCount ?? 0) > 0;

/**
 * With nothing indexed, "no match" is not evidence of absence: a new project
 * has no entity store yet, and an agent read the miss as "no such branch".
 */
const NO_ENTITIES = 'No names are indexed for this project, so find-entity cannot resolve them. '
	+ "Find the value in the data with a query instead (SELECT DISTINCT <column> FROM <table> WHERE <column> LIKE '%<text>%'); "
	+ 'a miss here says nothing about whether it exists.';

/** The types, what each resolves against, and whether it holds any values. */
async function renderEntityTypes(): Promise<string> {
	const all = (await getEntityTypes()).data;
	const indexed = all.filter(holdsValues);
	if (!indexed.length) return NO_ENTITIES;
	const out = [`${indexed.length} entity type(s) hold values you can resolve against` +
		(all.length > indexed.length ? `; ${all.length - indexed.length} more are mapping-only (no values indexed).` : '.'), ''];
	for (const t of indexed) {
		const r = t.resolution as any;
		out.push(`${t.entityType}  —  ${r.indexedCount} value(s)`);
		if (r.idField) out.push(`   id column:    ${r.idField}`);
		if (r.valueField) out.push(`   value column: ${r.valueField}`);
	}
	out.push('', 'find-entity --type "<type>" "<text>" to search one; get-entity --type "<type>" for how to filter on it.');
	return out.join('\n');
}

/** Shape-recognised values (PAN, vehicle, GCN numbers): not indexed, but locatable. */
function renderRecognized(recognized: any[]): string[] {
	const out: string[] = [];
	for (const r of recognized) {
		out.push(`"${r.mention}" — NOT INDEXED, recognised by shape as [${r.entityType}]`);
		if (r.field) out.push(`   field: ${r.field}`);
		if (r.searchSql) out.push(`   find it with:\n${String(r.searchSql).split('\n').map(l => '     ' + l).join('\n')}`);
	}
	return out;
}

/** "branch" asks for the indexed type "branch name": the same kind, spelled shorter. */
function sameEntityType(real: string, asked: string): boolean {
	const a = real.trim().toLowerCase(), b = asked.trim().toLowerCase();
	return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

interface EntityType { name: string; idField?: string; indexed: boolean }

async function entityTypeList(): Promise<EntityType[]> {
	return ((await getEntityTypes()).data as any[]).map(t => ({
		name: t.entityType, idField: t.resolution?.idField, indexed: !!holdsValues(t),
	}));
}

/**
 * The types an asked-for type means: the same name, its short form ("branch"
 * → "branch name"), a word of it ("broker" → "vehicle broker name"), or the
 * table it lives in ("location" → branch name, region name). The labels are
 * not guessable: an exact-name rule failed 21% of the agent's lookups.
 */
function matchTypes(asked: string, types: EntityType[]): EntityType[] {
	const a = asked.trim().toLowerCase();
	const tiers = [
		(t: EntityType) => t.name.toLowerCase() === a,
		(t: EntityType) => sameEntityType(t.name, asked),
		(t: EntityType) => t.name.toLowerCase().split(/\s+/).includes(a),
		(t: EntityType) => (t.idField ?? '').toLowerCase().split('.')[0].split('_').includes(a),
	];
	for (const tier of tiers) {
		const hit = types.filter(tier);
		if (hit.length) return hit;
	}
	return [];
}

interface Candidate { type: string; id: string; name: string; score: number; matchType: string; scope?: string }

const isExact = (c: Candidate) => c.matchType === 'exact' || c.matchType === 'exact_normalized' || c.score >= 0.999;

/** Top hit plus every labelled alternative, one per type+id. */
function candidatesOf(hit: any): Candidate[] {
	if (!hit) return [];
	const all = [hit, ...(hit.alternatives ?? [])].map((h: any) => ({
		type: h.entityType, id: String(h.instanceId), name: h.displayName, score: Number(h.score), matchType: h.matchType ?? '',
		scope: h.attrs?.scopeSql ? String(h.attrs.scopeSql) : undefined,
	}));
	const seen = new Set<string>();
	return all.filter(c => (seen.has(`${c.type}|${c.id}`) ? false : (seen.add(`${c.type}|${c.id}`), true)));
}

/**
 * The answer, not an overview: each candidate with its type, id and the column
 * to filter on, so no get-entity follow-up is needed. Exact names first;
 * partial matches of other types are summarised, not presented as rivals —
 * listing them as alternatives made a certain match read as AMBIGUOUS.
 */
function renderCandidates(term: string, primary: Candidate[], others: Candidate[], types: EntityType[], note?: string, guided = false): string[] {
	const filterOf = new Map(types.map(t => [t.name, t.idField]));
	// One line per name within a type: 178 records called "SUNIL KUMAR" are one line.
	const groups = new Map<string, Candidate[]>();
	for (const c of primary) {
		const k = `${c.type}|${c.name.toUpperCase().replace(/\s+/g, ' ').trim()}`;
		groups.set(k, [...(groups.get(k) ?? []), c]);
	}
	const shown = [...groups.values()].slice(0, 8);
	const width = Math.min(Math.max(...shown.map(g => g[0].type.length)) + 2, 26);
	const out = [note ? `"${term}" — ${note}` : `"${term}"`];
	for (const g of shown) {
		const c = g[0];
		const col = filterOf.get(c.type);
		const more = g.length > 1 ? `  (${g.length} records with this name: ids ${g.slice(0, 6).map(x => x.id).join(', ')}${g.length > 6 ? ', …' : ''})` : '';
		out.push(`   ${PAD(c.type, width)}${c.name}  id=${c.id}${col ? `   filter: ${col} = ${c.id}` : ''}${more}`);
		if (c.scope) out.push(`      scope (service networks of ${c.name}, as a WHERE on trp_mst_servicenetwork): ${c.scope}`);
	}
	if (groups.size > shown.length) out.push(`   … and ${groups.size - shown.length} more name(s)`);

	const types_ = new Set([...groups.values()].map(g => g[0].type));
	// The resolver's own note for this data says what to do; a generic line would contradict it.
	if (guided) { /* the NOTE below decides */ }
	else if (types_.size > 1) out.push(`   → the name exists as ${types_.size} kinds of thing: use the one the question means.`);
	else if (groups.size > 1) out.push(`   → several [${[...types_][0]}] match: choose by the question's other details; do not combine them.`);
	else if ([...groups.values()][0]?.length > 1) out.push('   → different records share this name: they are different entities; do not combine them without saying so.');

	if (others.length) {
		const byType = new Map<string, number>();
		for (const c of others) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
		out.push(`   other partial matches: ${[...byType].map(([t, n]) => `${t} (${n})`).join(', ')}`);
	}
	return out;
}

/**
 * Unscoped is the normal form: the agent cannot know what a name IS (a broker
 * is not a customer), and a guessed type failed or misled. Scoped narrows, and
 * an unknown or wrong type falls back to what the name actually is.
 */
async function renderFindEntity(terms: string[], type: string | null, limit: number): Promise<string> {
	const out: string[] = [];
	const dates = terms.filter(t => DATE_EXPRESSION.test(t.trim()));
	terms = terms.filter(t => !DATE_EXPRESSION.test(t.trim()));
	for (const d of dates) out.push(`"${d}" is a date, not an entity — use it directly in the query.`, '');
	if (!terms.length) return out.join('\n').trim();
	const types = await entityTypeList();
	if (!types.some(t => t.indexed)) return [...out, NO_ENTITIES].join('\n').trim();

	const wanted = type ? matchTypes(type, types.filter(t => t.indexed)) : [];
	const wantedNames = new Set(wanted.map(t => t.name));
	if (type && !wanted.length) {
		out.push(`"${type}" is not an entity type here (types: ${types.filter(t => t.indexed).map(t => t.name).join(', ')}). Searched every type instead.`, '');
	}

	for (const term of terms) {
		// One known type: a scoped search reaches deeper into it. Otherwise all types.
		const r: any = await resolveEntities({
			mentions: [{ text: term, ...(wanted.length === 1 ? { entityType: wanted[0].name } : {}) }],
			limit: Math.max(limit, 25), minScore: ENTITY_MIN_SCORE, perTypeCap: 5,
		});
		const hit = (r.resolved ?? [])[0];
		const cands = candidatesOf(hit);
		if (!cands.length) {
			const recognized = r.recognized?.length ? r.recognized : await recognizePatterns([term]);
			if (recognized.length) { out.push(...renderRecognized(recognized), ''); continue; }
			out.push(`"${term}" — no match in any entity type. Look for it in the data with a query (LIKE on the name column).`, '');
			continue;
		}

		let primary: Candidate[], others: Candidate[], note: string | undefined;
		if (wantedNames.size) {
			primary = cands.filter(c => wantedNames.has(c.type));
			others = cands.filter(c => !wantedNames.has(c.type));
			if (!primary.length) {
				// The guess was wrong: say so and show what the name actually is.
				note = `no [${type}] matches; it is:`;
				primary = others.filter(isExact).length ? others.filter(isExact) : others.slice(0, 5);
				others = others.filter(c => !primary.includes(c));
			} else if (primary.some(isExact)) {
				// An exact name of the asked type outranks its partial namesakes.
				others = [...others, ...primary.filter(c => !isExact(c))];
				primary = primary.filter(isExact);
			}
		} else {
			const exact = cands.filter(isExact);
			primary = exact.length ? exact : cands.filter(c => c.score >= 0.85).slice(0, 5);
			if (!primary.length) { primary = cands.slice(0, 5); note = 'no exact match; closest:'; }
			others = cands.filter(c => !primary.includes(c));
		}
		out.push(...renderCandidates(term, primary, others, types, note, !!hit?.guidance));
		// Load-bearing: says which id to filter on and forbids combining them.
		if (hit?.guidance) out.push(`   NOTE: ${hit.guidance}`);
		out.push('');
		if (r.recognized?.length) out.push(...renderRecognized(r.recognized), '');
		if (r.warning) out.push(`warning: ${r.warning}`, '');
	}
	out.push('An id identifies a ROW, not necessarily the whole entity: where a concept names a grouping key, use that key.');
	return out.join('\n');
}

/** One entity: its id, its values, and HOW to filter on it. */
async function renderGetEntity(type: string, id: string | null, name: string | null): Promise<string> {
	const types = (await getEntityTypes()).data;
	const list = await entityTypeList();
	const matched = matchTypes(type, list);
	if (!matched.length) return `"${type}" is not an entity type here (types: ${list.filter(x => x.indexed).map(x => x.name).join(', ')}).`;
	// Several types share a table ("location"): the one holding this id is meant.
	let t = types.find(x => x.entityType === matched[0].name)!;
	if (matched.length > 1 && id) {
		for (const m of matched) {
			if (await getEntityById({ entityType: m.name, instanceId: String(id) })) { t = types.find(x => x.entityType === m.name)!; break; }
		}
	}
	const r: any = t.resolution ?? {};
	const mapping = [
		`type:  ${t.entityType}${r.indexedCount ? `  (${r.indexedCount} values indexed)` : '  (mapping only, no values indexed)'}`,
		...(r.idField ? [`id column:    ${r.idField}   ← filter on this with the id above`] : []),
		...(r.valueField ? [`value column: ${r.valueField}`] : []),
		...(r.mapping ? ['', String(r.mapping).trim()] : []),
	];

	if (!id && !name) return [...mapping, '', 'get-entity --type "' + t.entityType + '" <id> for one record.'].join('\n');

	let resolvedId = id;
	if (!resolvedId && name) {
		const r2: any = await resolveEntities({
			mentions: [{ text: name, entityType: t.entityType }], limit: 5, minScore: ENTITY_MIN_SCORE,
		});
		const hit = (r2.resolved ?? [])[0];
		if (!hit) return `"${name}" does not resolve under [${t.entityType}]. Try find-entity --type "${t.entityType}" "${name}".`;
		resolvedId = hit.instanceId;
	}

	const rec = await getEntityById({ entityType: t.entityType, instanceId: String(resolvedId) });
	if (!rec) return `No [${t.entityType}] record with id ${resolvedId}. Find one with find-entity --type "${t.entityType}" "<text>".`;

	const out = [`id:    ${rec.instanceId}`, ...mapping, ''];
	for (const v of rec.values) {
		const attrs = v.attrs && Object.keys(v.attrs).length ? `  attrs: ${JSON.stringify(v.attrs)}` : '';
		out.push(`${v.kind}: ${v.value}${attrs}`);
	}
	if (rec.sameNameIds.length) {
		out.push('', `WARNING: ${rec.sameNameIds.length + 1} records share this name (also ${rec.sameNameIds.slice(0, 10).join(', ')}` +
			`${rec.sameNameIds.length > 10 ? ', …' : ''}). They are DIFFERENT entities: do not treat this id as "the" one, and do not sum across them without saying so.`);
	}
	return out.join('\n');
}

const SCHEMA_LIMIT = 25;
/** Counts follow the deployment's locale, as every other formatted number does. */
const LOCALE = process.env.SA_LOCALE || undefined;
/** Below this the index is quietly trusted; above it, every answer says its age. */
const INDEX_STALE_DAYS = 7;

const nfmt = (n: unknown) => (n == null ? '' : Number(n).toLocaleString(LOCALE));
/** Everything a tool prints costs context; long prose is trimmed, not dropped. */
const clip = (v: unknown, max: number) => {
	const t = String(v ?? '').replace(/\s+/g, ' ').trim();
	return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + ' …' : t;
};

/** One line, only when the index is old enough that a wrong column is plausible. */
async function stalenessNote(): Promise<string[]> {
	try {
		const [f] = await getIndexFreshness();
		if (!f?.indexedAt) return [];
		const days = (Date.now() - new Date(f.indexedAt).getTime()) / 86_400_000;
		return days > INDEX_STALE_DAYS
			? ['', `NOTE: this index was built ${Math.round(days)} days ago from a cached schema — confirm a column with a query before relying on it.`]
			: [];
	} catch { return []; }
}

/** [dbo].[t], "t", `t` -> dbo.t: the agent copies identifiers as SQL writes them. */
const unquoteIdent = (s: string) => s.replace(/[[\]"`]/g, '').trim();

/** Where a name lives: paths, with the type and description that make one decidable. */
async function renderFindSchema(terms: string[], table: string | null, limit: number): Promise<string> {
	const out: string[] = [];
	if (table) table = unquoteIdent(table);
	for (const term of terms.length ? terms : ['']) {
		let rows = await searchDataSourceIndex({ query: term || undefined, tableName: table || undefined, limit });
		// "dbo.table" names the same table: the index stores it without the schema.
		if (!rows.length && table?.includes('.')) {
			const bare = table.split('.').pop()!;
			rows = await searchDataSourceIndex({ query: term || undefined, tableName: bare, limit });
			if (rows.length) table = bare;
		}
		if (!rows.length) {
			out.push(`"${term}" — no column matches. Try a shorter term, or find-schema --table "<table>".`, '');
			continue;
		}
		const tables = new Set(rows.map(r => r.tableName));
		out.push(`"${term}"${table ? ` in ${table}` : ''} — ${rows.length} column(s) across ${tables.size} table(s)`);
		const width = Math.min(Math.max(...rows.map(r => `${r.tableName}.${r.columnName}`.length)) + 2, 52);
		for (const r of rows) {
			const desc = String(r.description ?? '').replace(/\s+/g, ' ').slice(0, 70);
			out.push(`  ${PAD(`${r.tableName}.${r.columnName}`, width)}${PAD(String(r.dataType ?? ''), 11)}${desc}`.trimEnd());
		}
		if (rows.length >= limit) out.push(`  … capped at ${limit}; narrow the term or use --table`);
		out.push('');
	}
	out.push('get-schema "<table>" for every column of a table, or "<table>.<column>" for one.');
	return [...out, ...(await stalenessNote())].join('\n');
}

/** A whole table, or one column, at whatever depth the path was given. */
async function renderGetSchema(paths: string[], asJson: boolean): Promise<string> {
	const blocks: string[] = [];
	const json: any[] = [];

	for (const raw of paths) {
		let parts = unquoteIdent(raw).split('.').map(p => p.trim()).filter(Boolean);
		// 3 = source.table.column, 2 = table.column, 1 = table. A source id holds
		// a hyphen and no dot, so the 2-part case is never ambiguous in practice.
		const split = (ps: string[]): [string | null, string, string | null] => ps.length >= 3
			? [ps[0], ps[1], ps.slice(2).join('.')]
			: ps.length === 2 ? [null, ps[0], ps[1]] : [null, ps[0], null];
		let [sourceName, tableName, columnName] = split(parts);

		let cols: any[] = await getIndexedTable(sourceName, tableName);
		// A SQL schema prefix ("dbo.trp_trn_booking", as every concept writes it)
		// is not part of the indexed name: retry without the leading segment.
		if (!cols.length && parts.length >= 2) {
			const [s2, t2, c2] = split(parts.slice(1));
			const retry = await getIndexedTable(s2, t2);
			if (retry.length) { parts = parts.slice(1); [sourceName, tableName, columnName] = [s2, t2, c2]; cols = retry; }
		}
		if (!cols.length) {
			const near = await findIndexedTables(tableName, 8);
			blocks.push(near.length
				? `"${raw}" — no such table. Close: ${near.map(n => n.tableName).join(', ')}`
				: `"${raw}" — no such table. find-schema "<term>" locates one.`, '');
			continue;
		}
		// Same table name in two sources: resolve nothing, show the addresses.
		const sources = new Set(cols.map(c => c.sourceName));
		if (sources.size > 1 && !sourceName) {
			blocks.push(`"${raw}" exists in ${sources.size} sources: ${[...sources].map(s => `${s}.${tableName}`).join(', ')}. Name one.`, '');
			continue;
		}
		if (columnName) {
			const hit = cols.find(c => c.columnName.toLowerCase() === columnName.toLowerCase());
			if (!hit) {
				blocks.push(`"${raw}" — ${tableName} has no column ${columnName}. It has: ${cols.slice(0, 12).map(c => c.columnName).join(', ')}${cols.length > 12 ? `, … ${cols.length - 12} more` : ''}`, '');
				continue;
			}
			cols = [hit];
		}

		if (asJson) { json.push(...cols.map(c => ({ ...c, path: `${c.sourceName}.${c.tableName}.${c.columnName}` }))); continue; }

		const meta: any = cols[0].tableMeta ?? {};
		const head = [columnName
			? `${cols[0].tableName}.${cols[0].columnName}  [${cols[0].sourceName}]` + (cols[0].rowCount ? ` · table has ${nfmt(cols[0].rowCount)} rows` : '')
			: `${cols[0].tableName}  [${cols[0].sourceName}]  ${cols.length} column(s)` + (cols[0].rowCount ? ` · ${nfmt(cols[0].rowCount)} rows` : '')];
		if (meta.description) head.push(`what it is: ${clip(meta.description, 600)}`);
		if (meta.primaryKey) head.push(`primary key: ${Array.isArray(meta.primaryKey) ? meta.primaryKey.join(', ') : meta.primaryKey}`);
		// Asking about one column? Only the joins that USE it are relevant; asking
		// about the table, they all are. `purpose` is the part worth printing —
		// it says which join answers which kind of question.
		const joins: any[] = (meta.joins ?? []).filter((j: any) =>
			!columnName || String(j.on ?? '').toLowerCase().includes(columnName.toLowerCase()));
		if (joins.length) {
			head.push('joins:');
			for (const j of joins) {
				head.push(`  -> ${j.to ?? j.table ?? j.entity ?? '?'}  ON ${j.on ?? ''}` + (j.purpose ? `\n     ${clip(j.purpose, 150)}` : ''));
			}
		}
		if (meta.synonyms?.length) head.push(`also called: ${meta.synonyms.join(', ')}`);
		if (meta.notes) head.push(`notes: ${clip(meta.notes, 600)}`);
		blocks.push(head.join('\n'), '');

		const w = Math.min(Math.max(...cols.map(c => c.columnName.length)) + 2, 40);
		blocks.push(`${PAD('column', w)}${PAD('type', 12)}${PAD('null', 6)}${PAD('card', 9)}${PAD('distinct', 12)}description`);
		for (const c of cols) {
			const flags = `${c.isPrimaryKey ? 'PK ' : ''}`;
			blocks.push(`${PAD(flags + c.columnName, w)}${PAD(String(c.dataType ?? ''), 12)}${PAD(c.isNullable === false ? 'no' : c.isNullable ? 'yes' : '', 6)}` +
				`${PAD(String(c.cardinality ?? ''), 9)}${PAD(nfmt(c.distinctCount), 12)}${String(c.description ?? '').replace(/\s+/g, ' ').slice(0, 80)}`.trimEnd());
			const samples = (c.sampleValues ?? []) as unknown[];
			if (columnName && samples.length) blocks.push(`  values: ${samples.slice(0, 15).map(v => JSON.stringify(v)).join(', ')}`);
		}
		blocks.push('');
	}

	if (asJson) return JSON.stringify(json, null, 2);
	return [...blocks, ...(await stalenessNote())].join('\n');
}

/* ------------------------------ knowledge base ------------------------------ */

/**
 * Every knowledge node, one line each — a LIST, not a search.
 *
 * The corpus is small (tens of nodes, one short title each), and a search
 * misses what the agent would never think to ask for: a note like "never sum
 * across forecast versions" is found by reading the list, not by querying for
 * the question in hand. get-kb returns a node's full content.
 */
async function renderFindKb(): Promise<string> {
	const nodes = (await getAllKbNodes(500)).data as any[];
	if (!nodes.length) return 'The knowledge base is empty in this project.';
	const lines = nodes.map((n) => `${PAD(String(n.id), 6)}${PAD(`[${n.type ?? ''}${n.category ? `/${n.category}` : ''}]`, 24)}${n.title}`);
	return [`${nodes.length} knowledge node(s):`, '', ...lines, '', 'get-kb <id> ... prints a node in full.'].join('\n');
}

/**
 * Knowledge nodes in full, by id — plus every `global` node, which applies to
 * whatever the question is and so is exactly what the agent cannot know to ask
 * for. Labelled, so what it asked for stays distinguishable from what it was
 * handed.
 */
async function renderGetKb(ids: number[]): Promise<string> {
	if (!ids.length) return 'usage: get-kb <id> ... — ids come from find-kb.';
	const out: string[] = [];
	const shown = new Set<number>();
	const block = (n: any, auto: boolean) =>
		[`=== ${n.id}  ${n.title}${auto ? '  (global — applies to every question)' : ''}`,
			`[${n.type ?? ''}${n.category ? `/${n.category}` : ''}]${(n.tags ?? []).length ? `  tags: ${(n.tags ?? []).join(', ')}` : ''}`,
			'', String(n.content ?? '').trim(), ''].join('\n');

	for (const id of ids) {
		try {
			const node = (await getKbNode({ id })).data as any;
			out.push(block(node, false));
			shown.add(node.id);
		} catch {
			out.push(`${id}: no such knowledge node. find-kb lists them.`, '');
		}
	}
	const globals = ((await searchKbNodes({ type: 'global', limit: 100 })).data as any[]).filter((n) => !shown.has(n.id));
	for (const g of globals) out.push(block(g, true));
	return out.join('\n');
}

/* ------------------------------- direct tools ------------------------------- */

/**
 * Pre-built business-logic tools (`toolType: 'direct'`). With no tool given,
 * lists them with their parameters; with one, runs it as the caller — the same
 * identity the bridge's /run-tool uses, so a tool that queries is policed as
 * that user.
 */
async function runDirectTool(req: http.IncomingMessage, params: URLSearchParams): Promise<string> {
	const tools = getAllTools().filter((t: any) => t.toolType === 'direct');
	const wanted = params.get('tool');
	if (!wanted) {
		if (!tools.length) return 'No direct tools in this project.';
		return [`${tools.length} direct tool(s):`, '',
			...tools.map((t: any) => {
				const ps = Object.entries(t.params ?? {}).map(([k, v]) => `    ${k}: ${v}`);
				return [`${t.id}  — ${String(t.description ?? '').replace(/\s+/g, ' ').slice(0, 300)}`, ...ps].join('\n');
			}),
			'', 'run-tool "<id>" \'{"param":"value"}\' runs one.'].join('\n');
	}

	const tool: any = tools.find((t: any) => t.id === wanted || t.name === wanted);
	if (!tool) return `No direct tool "${wanted}". run-tool with no arguments lists them.`;

	let input: Record<string, any> = {};
	const raw = params.get('params');
	if (raw) {
		try { input = JSON.parse(raw); }
		catch { return 'params must be a JSON object, e.g. \'{"from":"2026-04-01"}\'.'; }
	}
	const ctx = resolveContextToken(req.headers['x-sa-context'] as string | undefined);
	const result = await withCapturedContext(ctx, () => tool.fn(input));
	return JSON.stringify(result, null, 2);
}

/* -------------------------------- dashboards -------------------------------- */

/**
 * One panel of the dashboard the question was asked from, run with the filter
 * values given — the same call the panel makes, with its published grants. A
 * follow-up the panel answers at other filters is one run, not a rebuild of its
 * logic in SQL. Printed like `query`, so a long result spills to data/ the same way.
 */
async function runPanel(req: http.IncomingMessage, params: URLSearchParams): Promise<string> {
	const dashboardId = params.get('dashboard') ?? '';
	const name = params.get('name') ?? '';
	if (!dashboardId) return 'No dashboard is in view: run-resolver works only on the dashboard the question was asked from.';
	if (!name) return 'usage: run-resolver "<panel>" [\'{"filter":"value"}\']. The panels are the files in dashboard/data/.';

	let input: Record<string, unknown> = {};
	const raw = params.get('params');
	if (raw) {
		try { input = JSON.parse(raw); }
		catch { return 'params must be a JSON object of the panel\'s filters, e.g. \'{"from":"2026-04-01"}\'.'; }
	}

	const ctx = resolveContextToken(req.headers['x-sa-context'] as string | undefined);
	const out = await withCapturedContext(ctx, () => runResolverForAgent({ dashboardId, name, params: input }));
	if (!out.success) return `Panel failed: ${out.error}`;

	const rows: any[] = Array.isArray(out.result?.data) ? out.result.data : [];
	const meta = out.result?.meta ?? {};
	const shown = rows.slice(0, QUERY_MAX_ROWS);
	const total = meta.totalRows ?? rows.length;
	const truncated = !!meta.truncated || total > shown.length;
	return JSON.stringify({
		panel: meta.resolver ?? name,
		count: total,
		returned: shown.length,
		truncated,
		...(truncated ? { warning: `INCOMPLETE: only ${shown.length} of ${total} rows are shown. Do not compute totals or rankings from them.` } : {}),
		...(out.result?.columns ? { columns: out.result.columns } : {}),
		rows: shown,
	}, null, 2);
}

/**
 * The project's semantic models — governed metrics, one verb at a time. A text
 * result prints as is; `run` prints like `query`.
 */
async function runSemantic(req: http.IncomingMessage, params: URLSearchParams): Promise<string> {
	let query: unknown;
	const raw = params.get('query');
	if (raw) {
		try { query = JSON.parse(raw); }
		catch { return 'The query is not valid JSON: { "model", "metrics": [], "dimensions": [], "filters": [] }.'; }
	}
	const body = {
		verb: params.get('verb') ?? '',
		model: params.get('model') ?? undefined,
		name: params.get('name') ?? undefined,
		text: params.get('text') ?? undefined,
		source: params.get('source') ?? undefined,
		dashboardId: params.get('dashboard') ?? undefined,
		query,
	};

	const ctx = resolveContextToken(req.headers['x-sa-context'] as string | undefined);
	const out: any = await withCapturedContext(ctx, () => semanticForAgent(body));
	if (out?.error) return String(out.error);

	const r = out?.result;
	// No models is a normal state, not an error: there is simply nothing to run.
	if (body.verb === 'models' && Array.isArray(r) && r.length === 0) {
		return 'This project has no semantic models — nothing to run. Use tools/query.';
	}
	if (typeof r?.text === 'string') return r.text;
	if (Array.isArray(r?.rows)) {
		const truncated = r.rowCount > r.shown;
		return JSON.stringify({
			count: r.rowCount,
			returned: r.shown,
			truncated,
			...(truncated ? { warning: `INCOMPLETE: only ${r.shown} of ${r.rowCount} rows are shown. Group in the query, or count first.` } : {}),
			sql: r.sql,
			rows: r.rows,
		}, null, 2);
	}
	return JSON.stringify(r, null, 2);
}

/** "dbo.t", "t.col" and "source.t.col" all name table t. */
function tableOf(path: string): string {
	const parts = path.replace(/^dbo\./i, '').split('.');
	return (parts.length >= 3 ? parts[parts.length - 2] : parts[0]).toLowerCase();
}

/**
 * Routes every `/tools/*` request. Returns false when the path is not ours, so
 * the bridge can go on to its own routes.
 */
export async function handleAgentToolRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
	const url = new URL(req.url || '/', 'http://localhost');
	if (!url.pathname.startsWith('/tools/')) return false;

	try {
		if (url.pathname === '/tools/find-concept') {
			const terms = url.searchParams.getAll('q').map(t => t.trim()).filter(Boolean);
			const kind = url.searchParams.get('kind');
			const limit = Number(url.searchParams.get('limit')) || 10;
			const token = req.headers['x-sa-context'] as string | undefined;
			sendText(res, 200, terms.length ? await renderSearch(terms, kind, limit, token) : await renderCatalog(kind));
			return true;
		}

		if (url.pathname === '/tools/get-concept') {
			const names = url.searchParams.getAll('name').map(n => n.trim()).filter(Boolean);
			sendText(res, 200, await renderGetConcept(names, url.searchParams.get('invariants') === '1', req.headers['x-sa-context'] as string | undefined));
			return true;
		}

		if (url.pathname === '/tools/sources') {
			sendText(res, 200, await renderSources(!!req.headers['x-sa-context']));
			return true;
		}

		if (url.pathname === '/tools/query') {
			sendText(res, 200, await runQuery(req, url.searchParams));
			return true;
		}

		if (url.pathname === '/tools/find-entity') {
			if (url.searchParams.get('types') === '1') { sendText(res, 200, await renderEntityTypes()); return true; }
			const terms = url.searchParams.getAll('q').map(t => t.trim()).filter(Boolean);
			if (!terms.length) { sendText(res, 200, 'usage: find-entity [--type "<type>"] [--limit N] "<text>" ... | --types'); return true; }
			const limit = Math.min(Number(url.searchParams.get('limit')) || ENTITY_LIMIT, 50);
			sendText(res, 200, await renderFindEntity(terms, url.searchParams.get('type'), limit));
			return true;
		}

		if (url.pathname === '/tools/get-entity') {
			const type = url.searchParams.get('type');
			if (!type) { sendText(res, 200, 'usage: get-entity --type "<type>" [<id> | --name "<name>"]'); return true; }
			sendText(res, 200, await renderGetEntity(type, url.searchParams.get('id'), url.searchParams.get('name')));
			return true;
		}

		if (url.pathname === '/tools/find-schema') {
			const terms = url.searchParams.getAll('q').map(t => t.trim()).filter(Boolean);
			const table = url.searchParams.get('table');
			if (!terms.length && !table) { sendText(res, 200, 'usage: find-schema "<term>" ... | --table "<table>"'); return true; }
			const limit = Math.min(Number(url.searchParams.get('limit')) || SCHEMA_LIMIT, 100);
			if (table) noteUsage(req.headers['x-sa-context'] as string | undefined, 'tables', [tableOf(table)]);
			sendText(res, 200, await renderFindSchema(terms, table, limit));
			return true;
		}

		if (url.pathname === '/tools/get-schema') {
			const paths = url.searchParams.getAll('path').map(p => p.trim()).filter(Boolean);
			if (!paths.length) { sendText(res, 200, 'usage: get-schema "<table>" | "<table>.<column>" | "<source>.<table>.<column>" ... [--json]'); return true; }
			noteUsage(req.headers['x-sa-context'] as string | undefined, 'tables', paths.map(tableOf));
			sendText(res, 200, await renderGetSchema(paths, url.searchParams.get('json') === '1'));
			return true;
		}

		if (url.pathname === '/tools/find-kb') {
			sendText(res, 200, await renderFindKb());
			return true;
		}

		if (url.pathname === '/tools/get-kb') {
			const ids = url.searchParams.getAll('id').map(Number).filter(Number.isFinite);
			sendText(res, 200, await renderGetKb(ids));
			return true;
		}

		if (url.pathname === '/tools/run-tool') {
			sendText(res, 200, await runDirectTool(req, url.searchParams));
			return true;
		}

		if (url.pathname === '/tools/run-resolver') {
			sendText(res, 200, await runPanel(req, url.searchParams));
			return true;
		}

		if (url.pathname === '/tools/semantic') {
			sendText(res, 200, await runSemantic(req, url.searchParams));
			return true;
		}

		sendText(res, 404, `No such tool endpoint: ${url.pathname}`);
		return true;
	} catch (err: any) {
		// Full detail to our log; one line to the tool. A driver error can carry
		// the whole failed statement, and everything a tool prints costs context.
		console.error('[AgentTools] request failed:', err?.stack ?? err);
		const one = String(err?.message ?? err).split('\n')[0].slice(0, 200);
		sendText(res, 500, `Tool failed: ${one}`);
		return true;
	}
}
