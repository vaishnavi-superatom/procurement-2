import * as fs from 'fs';
import * as path from 'path';
import { LLM } from '@superatomai/sdk-node';
import { typed, profile, checkOps, applyOps, type DataOps } from './chart-data';

/**
 * Turns the coding agent's graph spec into a chart component. The coding agent
 * says what to show; this picks the component and its config from the catalog.
 * Rows never pass through the model: it sees columns and a sample, and code binds
 * the real rows afterwards, so no number can be retyped or dropped.
 */

// Same model as the narrator: matched Haiku on component picks, cheaper. SA_UI_AGENT_MODEL overrides.
const MODEL = process.env.SA_UI_AGENT_MODEL || 'openrouter/deepseek/deepseek-v4.1-flash';
const TIMEOUT_MS = 20_000;
const PROMPT_FILE = path.join(process.cwd(), '.prompts', 'ui-agent', 'system.md');
/** A few rows show what values look like; the profile, not these, is the evidence. */
const SAMPLE_ROWS = 3;
/** Data-fetching props (the rows are already bound), styling the theme owns, and the chart's own title and description. */
const DATA_PROPS = new Set(['query', 'externalTool', 'categorySelector', 'data', 'SA_RUNTIME', 'colorPalette', 'title', 'description']);
/** Unit spellings that mean raw rupees, as the table assembler reads them. */
const INR = /^(inr|₹|rs\.?|rupees?)$/i;

export interface GraphSpec {
	name: string;
	description?: string;
	config: Record<string, unknown>;
	columns: Array<{ key: string; label: string; unit?: string }>;
	rows: Array<Record<string, unknown>>;
}

type CatalogEntry = { name?: string; description?: string; props?: Record<string, any> };

/** The chart components the catalog offers, with their documented config. */
export function chartCatalog(catalog: CatalogEntry[] | undefined): CatalogEntry[] {
	return (catalog ?? []).filter(c => typeof c?.name === 'string' && /Chart$/.test(c.name));
}

function catalogText(charts: CatalogEntry[]): string {
	return charts.map(c => {
		const { config = {}, ...top } = c.props ?? {};
		const keep = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([k]) => !DATA_PROPS.has(k)));
		return `### ${c.name}\n${c.description ?? ''}\nprops: ${JSON.stringify(keep(top))}\nconfig: ${JSON.stringify(keep(config))}`;
	}).join('\n\n');
}

/** Every *Key / *Keys prop must name a real column; anything else is the model guessing. */
function checkKeys(config: Record<string, unknown>, columns: Set<string>): string | null {
	for (const [k, v] of Object.entries(config)) {
		if (/Key$/.test(k) && v !== null && v !== undefined && v !== '' && !columns.has(String(v))) return `${k} "${v}" is not a column`;
		if (/Keys$/.test(k) && Array.isArray(v)) for (const x of v) if (!columns.has(String(x))) return `${k} has "${x}", not a column`;
	}
	return null;
}

function parseReply(reply: string): any {
	const json = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	return JSON.parse(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1));
}

async function ask(sys: string, user: string): Promise<string> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ui-agent timeout')), TIMEOUT_MS); });
	try {
		return await Promise.race([LLM.text({ sys, user }, { model: MODEL, maxTokens: 800, temperature: 0 }), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** The chart component for one graph, or throws with the reason (the caller falls back to a table). */
export async function renderGraph(spec: GraphSpec, catalog: CatalogEntry[] | undefined): Promise<{ name: string; props: Record<string, unknown> }> {
	const charts = chartCatalog(catalog);
	if (!charts.length) throw new Error('no chart components in the catalog');

	const { types, rows } = typed(spec.columns, spec.rows);
	const columnKeys = new Set(spec.columns.map(c => c.key));
	const request = JSON.stringify({
		name: spec.name, description: spec.description ?? '', config: spec.config,
		rowCount: rows.length, columns: profile(spec.columns, rows, types), exampleRows: rows.slice(0, SAMPLE_ROWS),
	}, null, 2);
	const sys = `${fs.readFileSync(PROMPT_FILE, 'utf-8').trim()}\n\n## Chart components\n\n${catalogText(charts)}`;

	/** The reply as a component, config and data choices — or why it cannot be used. */
	const accept = (reply: string): { chart: CatalogEntry; config: Record<string, unknown>; ops?: DataOps } | string => {
		let picked: any;
		try { picked = parseReply(reply); } catch { return 'the reply is not JSON'; }
		const chart = charts.find(c => c.name === picked?.component);
		if (!chart) return `"${picked?.component}" is not one of the chart components listed`;
		const config = picked?.config && typeof picked.config === 'object' ? { ...picked.config } : {};
		for (const k of DATA_PROPS) delete config[k];
		const bad = checkKeys(config, columnKeys) ?? checkOps(picked?.data, types);
		return bad ?? { chart, config, ops: picked?.data };
	};

	// One retry with the exact error: most bad picks are a wrong key, which the model fixes when told.
	let reply = await ask(sys, request);
	let result = accept(reply);
	if (typeof result === 'string') {
		const first = result;
		reply = await ask(sys, `${request}\n\nYour previous reply:\n${reply}\n\nIt was rejected: ${first}. Reply again with corrected JSON only.`);
		result = accept(reply);
		if (typeof result === 'string') throw new Error(`ui-agent: ${first}; retry: ${result}`);
	}
	const { chart, config, ops } = result;
	// Currency formatting reads values as raw rupees; on anything else (crores, counts) it shows wrong numbers.
	if (!spec.columns.some(c => c.unit && INR.test(c.unit.trim()))) { delete config.valueFormatter; delete config.compactAxisLabels; }

	return {
		name: chart.name!,
		props: {
			title: spec.name,
			...(spec.description ? { description: spec.description } : {}),
			config: { ...config, data: applyOps(rows, types, ops, typeof config.xAxisKey === 'string' ? config.xAxisKey : undefined) },
		},
	};
}
