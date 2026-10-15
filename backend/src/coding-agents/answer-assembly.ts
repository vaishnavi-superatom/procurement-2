import * as fs from 'fs';
import * as path from 'path';
import {
	queryCache, inferColumns, validateComponentSpec, makeFmt, answerComponents,
	type Component, type SpecToValidate, type ValidationFinding,
} from '@superatomai/sdk-node';
import type { AnswerOutput, CoverageStats } from './answer-agent';
import type { QueryRef } from '../services/script-bridge';

const MARKDOWN = 'DynamicMarkdownBlock';

/**
 * An attachment's bytes travel as a base64 data: URI embedded directly in its
 * markdown link — there's no external file storage to stream from (the
 * workspace is local disk, per-user, and nothing proxies it to the browser),
 * so this caps what can reasonably sit in a chat message as inline text:
 * ~26.7 MB of base64 for a 20 MB file.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
	csv: 'text/csv',
	pdf: 'application/pdf',
	json: 'application/json',
	txt: 'text/plain',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	zip: 'application/zip',
};

function guessContentType(fileName: string): string {
	const ext = fileName.split('.').pop()?.toLowerCase();
	return (ext && CONTENT_TYPES[ext]) || 'application/octet-stream';
}

/**
 * Resolves an attachment's workspace-relative `path` to an absolute path,
 * refusing anything that doesn't stay inside `<workspaceDir>/outputs/` — the
 * one place system.md tells the agent to write a downloadable file. Blocks
 * both a bare filename (outside outputs/ entirely) and a `../` traversal.
 */
function resolveOutputFile(workspaceDir: string, relPath: unknown): string | null {
	if (typeof relPath !== 'string' || !relPath) return null;
	const outputsDir = path.join(workspaceDir, 'outputs');
	const resolved = path.resolve(workspaceDir, relPath);
	if (!resolved.startsWith(outputsDir + path.sep)) return null;
	return resolved;
}

/**
 * Turn the answer-agent's deliverable into the same shape the built-in flow
 * returns, so everything downstream is unchanged.
 *
 * Three things happen here and all three are deliberate:
 *   - each component's rows are the bridge's own result for the query it cites,
 *     registered in the queryCache WITH its SQL — the same path the built-in flow
 *     uses, so the agent never retypes rows and a refresh re-runs the real SQL;
 *   - every component spec is checked against the REAL columns of that result,
 *     by the same validator MainAgent's write_components uses;
 *   - specs that fail are DROPPED, not fixed. A wrong binding renders a chart of
 *     the wrong thing, which is worse than one fewer chart.
 */

export interface AssembledAnswer {
	text: string;
	component: Component | null;
	droppedComponents: Array<{ componentType: string; sourceRef?: string; reasons: string[] }>;
}

/** Components whose marks are one-per-row: a repeated category is correct. */
const RENDER_CAP = 100;


/**
 * Formatting comes from the deployment's locale/currency, not from here. The
 * first version of this hardcoded ₹ and Cr/L, which is one market's convention
 * and would render wrongly for any other — and it duplicated logic the SDK
 * already has, including the rounding carry (99,99,960 is "1.00 Cr", not
 * "100.00 L").
 */
const fmt = makeFmt({ locale: process.env.SA_LOCALE, currency: process.env.SA_CURRENCY });
const fmtMeasure = (n: number, measure: 'amount' | 'count'): string =>
	measure === 'amount' ? fmt.money(n) : fmt.count(n, 0);

/**
 * Build the coverage sentence from the numbers.
 *
 * Every share is computed HERE, so none can be forgotten, rounded oddly, or
 * quoted against the wrong denominator — which is exactly what happened while
 * this was prose: an excluded figure was reported as "483 bookings" with no
 * amount, and the amount turned out to be half the month.
 */
function renderCoverage(coverage: AnswerOutput['coverage']): string {
	if (!coverage) return '';
	if (typeof coverage === 'string') return coverage.trim();

	const c = coverage as CoverageStats;
	// Nothing left out means nothing to disclose: coverage exists to say what is
	// MISSING, and "100.0%" only adds a sentence the reader has to check.
	if (!(Number(c.excluded) > 0) && Number(c.shown) >= Number(c.total)) return '';

	const pct = (n: number) => (c.total > 0 ? `${((n / c.total) * 100).toFixed(1)}%` : 'n/a');
	// The sentence supplies "total"; a label that repeats it reads "total total".
	const label = String(c.measureLabel ?? '').replace(/^total\s+/i, '').trim();
	const parts = [
		`These rows account for ${fmtMeasure(c.shown, c.measure)} of ${fmtMeasure(c.total, c.measure)} ` +
		`total ${label} (${pct(c.shown)}).`,
	];
	if (Number(c.excluded) > 0) {
		const rows = c.excludedRows ? ` across ${fmt.count(Math.round(c.excludedRows), 0)} row(s)` : '';
		parts.push(
			`Excluded: ${fmtMeasure(Number(c.excluded), c.measure)} (${pct(Number(c.excluded))})${rows}` +
			`${c.excludedReason ? ` — ${c.excludedReason}` : ''}.`
		);
	}
	return parts.join(' ');
}

/** What a component renders: resolved from a query handle, or a legacy dataset. */
interface Binding { toolId: string; sql: string; rows: any[]; count: number; truncated: boolean }

export function assembleAnswer(
	out: AnswerOutput,
	availableComponents: Component[],
	question?: string,
	workspaceDir?: string,
	resolveQuery?: (ref: string) => QueryRef | undefined,
): AssembledAnswer {
	const legacy = new Map((out.datasets ?? []).map(d => [d.id, d]));
	const bindings = new Map<string, Binding>();
	const bind = (spec: AnswerOutput['components'][number]): [string, Binding | undefined] => {
		const key = spec.query ?? spec.sourceRef ?? '';
		if (!bindings.has(key)) {
			const q = spec.query ? resolveQuery?.(spec.query) : undefined;
			const d = !spec.query && spec.sourceRef ? legacy.get(spec.sourceRef) : undefined;
			const b: Binding | undefined = q ? { toolId: q.toolId, sql: q.sql, rows: q.data, count: q.count, truncated: q.truncated }
				: d ? { toolId: d.toolId, sql: d.sql, rows: d.rows, count: d.count ?? d.rows.length, truncated: false }
				: undefined;
			if (b) bindings.set(key, b);
		}
		return [key, bindings.get(key)];
	};
	for (const spec of out.components) bind(spec);
	const availableSourceRefs = [...bindings.keys()];
	// Narrowed to the components that can ANSWER a question: the registered
	// catalog also holds filters, forms and whole pages, and binding one of those
	// to a dataset renders nothing useful. answerComponents() is the same filter
	// the built-in flow applies.
	const templates = new Map(answerComponents(availableComponents).map(c => [c.name, c]));

	// queryId per result, registered NOW so the cache TTL starts when the answer
	// ships, not when the query ran; two components on one result share an entry.
	const queryIds = new Map<string, string>();
	for (const [key, b] of bindings) {
		queryIds.set(key, queryCache.storeQuery(b.sql, {
			data: b.rows,
			count: b.rows.length,
			...(b.truncated ? { metadata: { truncated: true, totalCount: b.count } } : {}),
		}));
	}

	// `coverage` follows the answer because it qualifies the numbers in it; a
	// reader who stops before the method note still sees what was left out.
	// Computed up here (not after `built`, where this used to live) because
	// the markdown block below needs `text` before the component loop runs.
	const coverageText = renderCoverage(out.coverage);
	const text = [out.answer, coverageText ? `\n\n**Coverage.** ${coverageText}` : '', out.method ? `\n\n**Method & filters.** ${out.method}` : '']
		.join('').trim();

	const built: Component[] = [];
	const dropped: AssembledAnswer['droppedComponents'] = [];
	const queryMap: Record<string, string> = {};

	// The written answer always leads the container, with any chart/table
	// following it — never the other way around, and never silently absent
	// just because a real component also exists. Unconditional on `text`
	// alone, not on whether `out.components` produced anything: a table with
	// no narrative above it forces the reader to infer what they're looking
	// at from column headers.
	if (text) {
		const template = templates.get(MARKDOWN);
		built.push({
			id: `comp_${Math.random().toString(36).substring(2, 8)}`,
			name: MARKDOWN,
			displayName: (template as any)?.displayName,
			type: (template as any)?.type ?? 'MarkdownBlock',
			description: (template as any)?.description ?? 'Text response rendered as markdown',
			props: { content: text },
			category: (template as any)?.category,
			keywords: (template as any)?.keywords,
		} as Component);
	}

	for (const spec of out.components) {
		const [key, d] = bind(spec);
		if (!d) {
			dropped.push({ componentType: spec.componentType, sourceRef: key, reasons: [spec.query ? `query "${spec.query}" is not a result from this run` : 'names no query result'] });
			continue;
		}
		const template = templates.get(spec.componentType);
		if (!template) {
			dropped.push({ componentType: spec.componentType, sourceRef: key, reasons: ['not in the registered component catalog'] });
			continue;
		}

		const toValidate: SpecToValidate = {
			componentType: spec.componentType,
			sourceRef: key,
			title: spec.title,
			description: spec.description,
			config: spec.config || {},
		};
		const findings: ValidationFinding[] = validateComponentSpec(toValidate, {
			cols: inferColumns(d.rows),
			// UNCAPPED count: the cap is applied at render, so validating on a
			// capped number would hide the truncation the checks look for.
			rowCount: d.count,
			rows: d.rows,
			availableSourceRefs,
			renderCap: RENDER_CAP,
		});
		const errors = findings.filter(f => f.severity === 'error');
		if (errors.length) {
			dropped.push({ componentType: spec.componentType, sourceRef: key, reasons: errors.map(e => `${e.code}: ${e.message}`) });
			continue;
		}

		const queryId = queryIds.get(key)!;
		queryMap[queryId] = d.sql;
		// A partial result must say so where it is shown, not only in a log.
		const partial = d.truncated ? ` (first ${fmt.count(d.rows.length, 0)} of ${fmt.count(d.count, 0)} rows)` : '';
		built.push({
			id: `comp_${Math.random().toString(36).substring(2, 8)}`,
			name: template.name,
			displayName: (template as any).displayName,
			type: template.type,
			description: spec.description || template.description,
			props: {
				title: spec.title ?? '',
				description: `${spec.description ?? ''}${partial}`.trim(),
				config: { ...(spec.config || {}) },
				externalTool: { toolId: d.toolId, toolName: d.toolId, parameters: { queryId } },
			},
			category: (template as any).category,
			keywords: (template as any).keywords,
		} as Component);
	}

	/* A download is rendered as an ordinary markdown link inside a
	 * DynamicMarkdownBlock, not a bespoke component — reuses rendering that
	 * already exists everywhere. The href is the file's own data: URI (its
	 * bytes, base64-encoded), and the title carries the filename so the
	 * frontend's link renderer can set a `download` attribute on it. No
	 * workspaceDir means the caller can't resolve a file at all — skip
	 * quietly rather than dropping every attachment as a "problem" for
	 * something the caller, not the agent, is responsible for. */
	if (workspaceDir) {
		const template = templates.get(MARKDOWN);
		for (const att of out.attachments ?? []) {
			const filePath = resolveOutputFile(workspaceDir, att?.path);
			if (!filePath) {
				dropped.push({ componentType: MARKDOWN, sourceRef: att?.path, reasons: ['path must be under outputs/, e.g. "outputs/report.csv"'] });
				continue;
			}
			if (!fs.existsSync(filePath)) {
				dropped.push({ componentType: MARKDOWN, sourceRef: att.path, reasons: [`${att.path} was not found — write the file before referencing it in out/answer.json`] });
				continue;
			}
			const size = fs.statSync(filePath).size;
			if (size > MAX_ATTACHMENT_BYTES) {
				dropped.push({
					componentType: MARKDOWN,
					sourceRef: att.path,
					reasons: [`file is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB download limit`],
				});
				continue;
			}
			const fileName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_');
			const buffer = fs.readFileSync(filePath);
			const dataUri = `data:${guessContentType(fileName)};base64,${buffer.toString('base64')}`;
			const label = att.title?.trim() || fileName;
			built.push({
				id: `comp_${Math.random().toString(36).substring(2, 8)}`,
				name: MARKDOWN,
				displayName: (template as any)?.displayName,
				type: (template as any)?.type ?? 'MarkdownBlock',
				description: (template as any)?.description ?? 'Text response rendered as markdown',
				props: { content: `📥 [Download ${label}](${dataUri} "${fileName}")` },
				category: (template as any)?.category,
				keywords: (template as any)?.keywords,
			} as Component);
		}
	}

	const component: Component | null = built.length
		? {
			id: `container_${Date.now()}`,
			name: 'MultiComponentContainer',
			type: 'Container',
			description: out.method || 'Answer',
			props: {
				config: {
					// The agent authors these; the question is a better fallback than a
					// generic "Dashboard", which tells the reader nothing.
					title: out.layoutTitle?.trim() || question?.trim() || 'Dashboard',
					description: out.layoutDescription?.trim() || '',
					components: built,
					...(Object.keys(queryMap).length ? { _queryMap: queryMap } : {}),
				},
			},
		} as Component
		: null;

	return { text, component, droppedComponents: dropped };
}
