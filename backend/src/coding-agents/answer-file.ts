import * as fs from 'fs';
import * as path from 'path';
import { makeFmt } from '@superatomai/sdk-node';
import { renderGraph, type GraphSpec } from './ui-agent';

type CatalogComponent = {
	name?: string;
	displayName?: string;
	type?: string;
	description?: string;
	category?: string;
	keywords?: string[];
};

interface TableColumn {
	key: string;
	label: string;
	unit?: string;
}

interface TableData {
	columns: TableColumn[];
	rows: Array<Record<string, unknown>>;
	/** Set when the query was cut off: the real row count, so the table is labelled partial. */
	total?: number;
}

export interface AssembledAnswerFile {
	/** Markdown-only fallback text, with directives removed. */
	text: string;
	/** A report container whose children retain the source document's order. */
	component: Record<string, unknown>;
}

// Quotes are OPTIONAL on purpose. The model drops them often enough that
// requiring them threw away whole correct answers over punctuation — our format,
// our parser, and a rejected answer is the worst outcome available.
// [ \t], never \s: \s spans the newline, so an untitled table took the next line of prose as its title.
const TABLE_DIRECTIVE = /^:::table[ \t]+(data\/[A-Za-z0-9][A-Za-z0-9._-]*\.json)(?:[ \t]+"([^"\r\n]+)"|[ \t]+([^\r\n]+?))?[ \t]*$/gm;
// Title, description and data live in the graph file, so the line carries no quoted text.
const GRAPH_DIRECTIVE = /^:::graph[ \t]+(data\/[A-Za-z0-9][A-Za-z0-9._-]*\.json)[ \t]*$/gm;
/** Tables and graphs in one scan, so they keep the order they were written in. */
const BLOCK_DIRECTIVE = new RegExp(`${TABLE_DIRECTIVE.source}|${GRAPH_DIRECTIVE.source}`, 'gm');
// An optional second quoted string is a note, e.g. that a default window was applied.
const TIME_DIRECTIVE = /^:::timeperiod[ \t]+(?:"([^"\r\n]+)"(?:[ \t]+"([^"\r\n]+)")?|([^"\r\n]+?))[ \t]*$/gm;
/** `:::findings` / `:::basis` open a section that runs to the next one or the end. */
const SECTION_DIRECTIVE = /^:::(findings|basis)[ \t]*$/gm;
const TITLE_LINE = /^#\s+(.+?)\s*#*\s*$/m;

/**
 * Money is formatted here, never by the model: converting rupees to lakh/crore in
 * its head put a total off by 10x (₹6.92 Cr for 692,119,607). The agent writes the
 * raw value as {{money:<n>}}; the deployment's locale and currency decide the units.
 */
const MONEY = /\{\{\s*money\s*:\s*([^}]*?)\s*\}\}/gi;
const fmt = makeFmt({ locale: process.env.SA_LOCALE, currency: process.env.SA_CURRENCY });
/** A figure the agent scaled itself: ₹ before it, or a lakh/crore unit after it. */
const HAND_AMOUNT = /₹\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:crores?|cr|lakhs?|lacs?|l)\b/gi;

export function renderMoney(text: string): string {
	return text.replace(MONEY, (all, raw: string) => {
		const n = Number(String(raw).replace(/[,\s₹]/g, ''));
		// Not a number: shown as written rather than dropped.
		return raw.trim() && Number.isFinite(n) ? fmt.money(n) : raw;
	});
}

/** Amounts written by hand instead of as markers: logged, so a slip is visible and countable. */
function handWrittenAmounts(text: string): string[] {
	return [...new Set((text.replace(MONEY, '').match(HAND_AMOUNT) ?? []).map(s => s.trim()))];
}

/** Column units to the table's own formats; money is formatted by the table, anything else is labelled. */
function tableColumn(column: TableColumn): Record<string, unknown> {
	const unit = column.unit?.trim();
	if (!unit) return { key: column.key, label: column.label };
	if (/^(inr|₹|rs\.?|rupees?)$/i.test(unit)) return { key: column.key, label: column.label, format: 'indian-currency' };
	// A count is already what the label says; "Bookings (count)" adds nothing.
	if (/^(counts?|number|nos?\.?|qty|#)$/i.test(unit)) return { key: column.key, label: column.label };
	const labelled = column.label.includes(`(${unit})`) ? column.label : `${column.label} (${unit})`;
	return { key: column.key, label: labelled };
}

/** "data/surat-july-2026-top-customers.json" -> "Surat july 2026 top customers" */
function titleFromPath(relativePath: string): string {
	const stem = relativePath.replace(/^data\//, '').replace(/\.json$/, '').replace(/[-_]+/g, ' ').trim();
	return stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : 'Table';
}

function template(catalog: CatalogComponent[] | undefined, name: string): CatalogComponent | undefined {
	return catalog?.find(component => component?.name === name);
}

function component(
	catalog: CatalogComponent[] | undefined,
	name: string,
	type: string,
	props: Record<string, unknown>,
	description: string,
): Record<string, unknown> {
	const found = template(catalog, name);
	return {
		id: `comp_${Math.random().toString(36).slice(2, 8)}`,
		name,
		displayName: found?.displayName,
		type: found?.type ?? type,
		description: found?.description ?? description,
		props,
		category: found?.category,
		keywords: found?.keywords,
	};
}

/** Column keys in first-seen order, labelled from the key: "freight_revenue" -> "Freight revenue". */
function columnsFromRows(rows: any[]): Array<{ key: string; label: string }> {
	const keys: string[] = [];
	for (const row of rows) {
		if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
		for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
	}
	return keys.map(key => {
		const words = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
		return { key, label: words.charAt(0).toUpperCase() + words.slice(1) };
	});
}

function readJson(workspaceDir: string, relativePath: string, what: string): unknown {
	const dataDir = path.resolve(workspaceDir, 'data');
	const absolutePath = path.resolve(workspaceDir, relativePath);
	if (!absolutePath.startsWith(dataDir + path.sep)) {
		throw new Error(`${what} path must stay under data/: ${relativePath}`);
	}
	let text: string;
	try {
		// Windows PowerShell's `Set-Content -Encoding utf8` writes a BOM, which JSON.parse rejects.
		text = fs.readFileSync(absolutePath, 'utf-8').replace(/^﻿/, '');
	} catch (err: any) {
		throw new Error(`cannot read ${what} ${relativePath}: ${err?.message ?? String(err)}`);
	}
	try { return JSON.parse(text); } catch (err: any) {
		// Python's json.dump writes NaN/Infinity for missing numbers; they are empty cells, not a broken file.
		try { return JSON.parse(text.replace(/(?<=[\[:,]\s*)-?(?:NaN|Infinity)(?=\s*[,}\]])/g, 'null')); }
		catch { throw new Error(`cannot read ${what} ${relativePath}: ${err?.message ?? String(err)}`); }
	}
}

function readTable(workspaceDir: string, relativePath: string): TableData {
	return shapeTable(readJson(workspaceDir, relativePath, 'table'), relativePath);
}

function shapeTable(parsed: unknown, relativePath: string): TableData {
	// The spec is {columns, rows}. A bare row array, or rows without columns, is
	// the same data missing only metadata that the rows themselves carry — so the
	// columns are derived rather than the table discarded. Measured: a run wrote
	// the right three rows as a bare array and lost the whole table for it.
	// {columns, rows}; a bare row array; or pandas' {columns, data} ("split") / {schema, data} ("table").
	const rawRows: unknown = Array.isArray(parsed) ? parsed
		: Array.isArray((parsed as any)?.rows) ? (parsed as any).rows
		: Array.isArray((parsed as any)?.data) ? (parsed as any).data : undefined;
	if (!Array.isArray(rawRows)) throw new Error(`table ${relativePath} must contain rows[]`);
	const declared: unknown = Array.isArray(parsed) ? undefined : (parsed as any)?.columns;
	const shaped = {
		rows: rawRows,
		columns: Array.isArray(declared) && declared.length ? declared : columnsFromRows(rawRows as any[]),
	};

	// Columns as {key,label,unit?} objects or as plain names (how Python writes them);
	// a missing label comes from the key. A label is never worth the answer.
	const humanize = (key: string) => {
		const w = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
		return w.charAt(0).toUpperCase() + w.slice(1);
	};
	const columns = shaped.columns.map((column: any, index: number): TableColumn => {
		const key = typeof column === 'string' ? column : typeof column?.key === 'string' ? column.key : '';
		if (!key.trim()) throw new Error(`table ${relativePath} column ${index + 1} has no key`);
		const label = typeof column?.label === 'string' && column.label.trim() ? column.label : humanize(key);
		const unit = typeof column?.unit === 'string' && column.unit.trim() ? column.unit : undefined;
		return { key, label, ...(unit ? { unit } : {}) };
	});
	if (new Set(columns.map(column => column.key)).size !== columns.length) {
		throw new Error(`table ${relativePath} has duplicate column keys`);
	}

	// Rows as objects, or as lists in column order (pandas' "split" shape); a missing cell is empty.
	const rows = shaped.rows.map((row: any, index: number): Record<string, unknown> => {
		if (Array.isArray(row)) return Object.fromEntries(columns.map((c, i) => [c.key, row[i] ?? null]));
		if (!row || typeof row !== 'object') throw new Error(`table ${relativePath} row ${index + 1} must be an object or a list`);
		for (const c of columns) if (!(c.key in row)) row[c.key] = null;
		return row;
	});
	// A file the tool marked cut off keeps its real total; the table then says it is partial.
	const total = !Array.isArray(parsed) && (parsed as any)?.truncated && Number((parsed as any).total) > rows.length
		? Number((parsed as any).total) : undefined;
	return { columns, rows, ...(total ? { total } : {}) };
}

/** A date-time at midnight is a date: shown as 2026-04-01, not 2026-04-01T00:00:00.000Z. */
const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})[T ]00:00:00(?:\.0+)?Z?$/;
function datesAsDates(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return rows.map(r => {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(r)) out[k] = typeof v === 'string' ? v.replace(MIDNIGHT, '$1') : v;
		return out;
	});
}

/**
 * The table a :::table line cites: either a table file {name, description?, data,
 * columns?} — the columns to show, in order, with labels and units, over a data file
 * the query tool saved — or, as before, a data file {columns, rows} shown whole.
 */
function readTableSpec(workspaceDir: string, relativePath: string): { name?: string; description?: string; table: TableData } {
	const parsed: any = readJson(workspaceDir, relativePath, 'table');
	if (Array.isArray(parsed) || Array.isArray(parsed?.rows) || typeof parsed?.data !== 'string') {
		return { table: shapeTable(parsed, relativePath) };
	}
	const data = readTable(workspaceDir, parsed.data.replace(/\\/g, '/'));
	const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined;
	const description = typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim() : undefined;
	if (!Array.isArray(parsed.columns) || !parsed.columns.length) return { name, description, table: data };

	const byKey = new Map(data.columns.map(c => [c.key.toLowerCase(), c]));
	const columns: TableColumn[] = [];
	for (const c of parsed.columns) {
		const key = typeof c === 'string' ? c : c?.key;
		const found = typeof key === 'string' ? byKey.get(key.toLowerCase()) : undefined;
		// A wrong key costs that column, never the answer.
		if (!found) { console.warn(`[answer-file] table ${relativePath}: column "${key}" is not in ${parsed.data}`); continue; }
		columns.push({
			key: found.key,
			label: typeof c?.label === 'string' && c.label.trim() ? c.label.trim() : found.label,
			...(typeof c?.unit === 'string' && c.unit.trim() ? { unit: c.unit.trim() } : found.unit ? { unit: found.unit } : {}),
		});
	}
	if (!columns.length) return { name, description, table: data };
	// Only the chosen columns travel with the answer: smaller, and no ids or helper totals in a download.
	const rows = data.rows.map(r => Object.fromEntries(columns.map(c => [c.key, r[c.key]])));
	return { name, description, table: { ...data, columns, rows } };
}

/** graph.json: {name, description, data, config}; data is a data/ file (the common case) or inline rows. */
export function readGraph(workspaceDir: string, relativePath: string): GraphSpec {
	const g: any = readJson(workspaceDir, relativePath, 'graph');
	if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error(`graph ${relativePath} must be an object`);
	const table = typeof g.data === 'string' ? readTable(workspaceDir, g.data.replace(/\\/g, '/'))
		: g.data && typeof g.data === 'object' ? shapeTable(g.data, relativePath)
		: null;
	if (!table) throw new Error(`graph ${relativePath} needs data: a data/<name>.json file`);
	if (!table.rows.length) throw new Error(`graph ${relativePath} has no rows`);
	return {
		name: renderMoney((typeof g.name === 'string' && g.name.trim()) || titleFromPath(relativePath)),
		...(typeof g.description === 'string' && g.description.trim() ? { description: renderMoney(g.description.trim()) } : {}),
		config: g.config && typeof g.config === 'object' && !Array.isArray(g.config) ? g.config : {},
		columns: table.columns,
		rows: table.rows,
	};
}

export type GraphRenderer = (spec: GraphSpec, catalog?: CatalogComponent[]) => Promise<{ name: string; props: Record<string, unknown> }>;

/** A header row followed by its `|---|` separator row. */
const MARKDOWN_TABLE = /^[ \t]*\|?.*\|.*\r?\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m;

/**
 * Converts answer.md into renderer-ready components in ONE fixed order — title,
 * time period, answer and its tables, key findings, then the basis collapsed —
 * whatever order the agent wrote them in. Measured: left to the agent, the time
 * period landed in a different place every run. `layout: vertical` keeps the
 * container from regrouping components by type.
 */
export async function assembleAnswerFile(
	workspaceDir: string,
	markdown: string,
	catalog?: CatalogComponent[],
	render: GraphRenderer = renderGraph,
	/** The last resort, after the recovery turn: a block that cannot be read becomes a note, never the whole answer. */
	opts: { lenient?: boolean } = {},
): Promise<AssembledAnswerFile> {
	const lenient = !!opts.lenient;
	if (lenient) {
		// A directive line that cannot be read (unknown name, bad path) is dropped rather than refused.
		const readable = (line: string) => [BLOCK_DIRECTIVE, TIME_DIRECTIVE, SECTION_DIRECTIVE].some(re => new RegExp(`^(?:${re.source})$`).test(line));
		markdown = markdown.replace(/^:::.*$/gm, line => readable(line) ? line : '');
	}
	// Rows typed into a Markdown table are numbers no query saved: rejected, so the recovery turn cites a data file.
	if (!lenient && MARKDOWN_TABLE.test(markdown)) {
		throw new Error('answer.md contains a Markdown table; save its rows with tools/query --save and cite them with :::table');
	}
	// Figures need their period; an answer without figures (a clarifying question) does not.
	const showsFigures = /^:::(table|graph)\b|\{\{money:/m.test(markdown);
	const handWritten = handWrittenAmounts(markdown);
	if (handWritten.length) console.warn(`[answer-file] amounts written by hand, not as {{money:}}: ${handWritten.join(', ')}`);
	markdown = renderMoney(markdown);

	// Sections first: everything before the first `:::findings`/`:::basis` is the answer.
	const sections: Record<string, string[]> = { findings: [], basis: [] };
	const parts = markdown.split(SECTION_DIRECTIVE);
	let body = parts[0];
	for (let i = 1; i < parts.length; i += 2) sections[parts[i]].push(parts[i + 1] ?? '');

	let timePeriod: string | undefined;
	let timeNote: string | undefined;
	body = body.replace(TIME_DIRECTIVE, (_all, quoted: string, note: string, bare: string) => {
		if (timePeriod !== undefined) {
			if (lenient) return '';
			throw new Error('answer.md may contain only one :::timeperiod directive');
		}
		timePeriod = (quoted ?? bare ?? '').trim();
		timeNote = note?.trim() || undefined;
		return '';
	});
	// A missing time period is a formatting slip, not a wrong answer (measured: correct answers
	// were once discarded over it). It gets the recovery turn; after that, the answer shows without it.
	if (!timePeriod && showsFigures && !lenient) {
		throw new Error('answer.md shows figures but has no :::timeperiod directive; add the period those figures cover');
	}
	if (!timePeriod) console.warn('[answer-file] no :::timeperiod directive — rendering without the component');

	// The first H1 is the title, wherever it was written. None is not invented.
	let title: string | undefined;
	body = body.replace(TITLE_LINE, (_all, text: string) => { title = text.trim(); return ''; });

	const children: Record<string, unknown>[] = [];
	const narrative: string[] = [];
	const addMarkdown = (text: string, label = 'Answer narrative') => {
		const content = text.trim();
		if (!content) return;
		children.push(component(catalog, 'DynamicMarkdownBlock', 'MarkdownBlock', { content, padding: 'compact' }, label));
		narrative.push(content);
	};
	const tableComponent = (tableTitle: string, table: TableData, description?: string) =>
		component(catalog, 'DynamicDataTable', 'DataTable', {
			...(description ? { description: renderMoney(description) } : {}),
			title: table.total
				? `${tableTitle} (first ${fmt.count(table.rows.length, 0)} of ${fmt.count(table.total, 0)} rows)`
				: tableTitle,
			config: {
				columns: table.columns.map(tableColumn),
				data: datesAsDates(table.rows),
				pageSize: 25,
				showPagination: true,
				sortable: true,
				striped: true,
				hoverable: true,
			},
		}, `Table: ${tableTitle}`);
	const addTable = (relativePath: string, rawTitle: string | undefined) => {
		let spec: ReturnType<typeof readTableSpec>;
		try { spec = readTableSpec(workspaceDir, relativePath); } catch (err: any) {
			if (!lenient) throw err;
			console.warn(`[answer-file] table shown as a note: ${err?.message ?? err}`);
			children.push(component(catalog, 'DynamicMarkdownBlock', 'MarkdownBlock', {
				content: `_${(rawTitle ?? '').trim() || titleFromPath(relativePath)}: this table could not be shown._`, padding: 'compact',
			}, 'Table not shown'));
			return;
		}
		// A missing title is not worth losing the table over: name it after the file.
		const title = renderMoney(spec.name ?? ((rawTitle ?? '').trim() || titleFromPath(relativePath)));
		children.push(tableComponent(title, spec.table, spec.description));
	};
	// Graphs are rendered after the scan, all at once; each holds its place with a slot.
	const graphs: Array<{ slot: Record<string, unknown>; file: string }> = [];
	const addGraph = (relativePath: string) => {
		const slot: Record<string, unknown> = {};
		children.push(slot);
		graphs.push({ slot, file: relativePath });
	};
	/** Prose, tables and graphs in their written order. */
	const addSegment = (text: string, label?: string) => {
		let cursor = 0;
		let match: RegExpExecArray | null;
		BLOCK_DIRECTIVE.lastIndex = 0;
		while ((match = BLOCK_DIRECTIVE.exec(text)) !== null) {
			addMarkdown(text.slice(cursor, match.index), label);
			if (match[4]) addGraph(match[4]);
			else addTable(match[1], match[2] ?? match[3]);
			cursor = match.index + match[0].length;
		}
		addMarkdown(text.slice(cursor), label);
	};
	// The section's own heading is the assembler's to write, not the agent's.
	const stripHeading = (text: string) => text.trim().replace(/^#{1,6}\s+[^\n]*\n?/, '');

	if (title) addMarkdown(`# ${title}`, 'Answer title');
	if (timePeriod) {
		children.push(component(catalog, 'TimePeriod', 'TimePeriod', { value: timePeriod, ...(timeNote ? { note: timeNote } : {}) }, 'Answer time period'));
		narrative.push(`**Time period:** ${timePeriod}${timeNote ? ` (${timeNote})` : ''}`);
	}
	addSegment(body);

	const findings = sections.findings.map(stripHeading).join('\n\n').trim();
	if (findings) addSegment(`### Key findings\n\n${findings}`, 'Key findings');

	// Basis is prose only; a table or graph written there is shown after it, never dropped.
	const basisBlocks: string[] = [];
	const basis = sections.basis.map(stripHeading).join('\n\n')
		.replace(BLOCK_DIRECTIVE, (all: string) => { basisBlocks.push(all); return ''; })
		.trim();
	if (basis) {
		children.push(component(catalog, 'DynamicMarkdownBlock', 'MarkdownBlock', {
			content: `<details>\n<summary style="cursor:pointer;font-weight:400;font-size:0.875em;opacity:0.6">How this was calculated</summary>\n\n${basis}\n\n</details>`,
			padding: 'compact',
		}, 'How this was calculated'));
		narrative.push(`**How this was calculated**\n\n${basis}`);
	}
	if (basisBlocks.length) addSegment(basisBlocks.join('\n'));

	// Every recognised directive is consumed above, so any `:::` left is unknown.
	const leftover = [body, findings, basis].join('\n').replace(BLOCK_DIRECTIVE, '');
	if (leftover.includes(':::')) throw new Error('answer.md contains an invalid directive');

	// A graph never costs the answer: unreadable → dropped, unrenderable → its data as a table.
	await Promise.all(graphs.map(async ({ slot, file }) => {
		let spec: GraphSpec;
		try { spec = readGraph(workspaceDir, file); }
		catch (err: any) { console.warn(`[answer-file] graph dropped: ${err?.message ?? err}`); return; }
		try {
			const chart = await render(spec, catalog);
			Object.assign(slot, component(catalog, chart.name, 'Chart', chart.props, `Chart: ${spec.name}`));
		} catch (err: any) {
			console.warn(`[answer-file] graph ${file} shown as a table: ${err?.message ?? err}`);
			Object.assign(slot, tableComponent(spec.name, { columns: spec.columns, rows: spec.rows }));
		}
		narrative.push(`**${spec.name}**${spec.description ? ` — ${spec.description}` : ''}`);
	}));
	for (let i = children.length - 1; i >= 0; i--) if (!Object.keys(children[i]).length) children.splice(i, 1);
	if (!children.length) throw new Error('answer.md has no renderable content');

	const container = component(catalog, 'MultiComponentContainer', 'Container', {
		// 16, not a custom value: the container maps it to gap-4, and Tailwind
		// never generates a class it cannot see written out, like gap-[12px].
		config: { layout: 'vertical', spacing: 16, compact: true, components: children },
	}, 'Structured answer');
	return { text: narrative.join('\n\n'), component: container };
}
