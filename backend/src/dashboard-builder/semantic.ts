/**
 * The semantic layer — governed metrics, instead of a metric per resolver.
 *
 * `ctx.sql` lets a resolver write whatever SQL it likes. That is the right
 * primitive and it is also how two dashboards end up disagreeing about revenue:
 * each one re-derives the definition, and the second author never sees the
 * first author's `WHERE`. The models under `dashboard-programs/semantic/models`
 * hold those definitions once — what a fact is, how facts join, which filter is
 * always applied — and compile them to SQL on demand.
 *
 * ### What lives where
 *
 *  - `dashboard-programs/semantic/lib` — the vendored `@f5/semantic` package.
 *    ESM, built to `dist/`, reached by dynamic import because this file
 *    compiles to CommonJS and the package uses `import.meta`.
 *  - `dashboard-programs/semantic/models` — the `*.osi.yaml` models.
 *
 * Both sit beside the program folders rather than inside `src/`, so a model and
 * the programs that query it are found in one place.
 *
 * ### It never opens a connection
 *
 * The layer is given an `executeSql` and has no other route to data. Here that
 * function is supplied by the caller — `createContext` in `query.ts` — so a
 * semantic query passes the same grant check, lands in the same `meta.queries`
 * list and obeys the same row cap as a statement the resolver wrote itself.
 * Nothing is reachable through a model that was not already reachable.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getSourceManager } from '../sources';
import { sourceTypeOf } from '../sources/source-type';
import { programsDir } from './locations';
import { registeredPrograms } from './semantic-programs';
import { PAGE_ROWS, SemanticError, currentRun, type SemanticRun } from './semantic-run';
import type { Rows, SemanticQuery } from './contract/types';

export { SemanticError } from './semantic-run';
export type { PageFn, SemanticRun } from './semantic-run';

/** Where the vendored package and the models sit, relative to the programs root. */
const LIB_ENTRY = () =>
	path.join(programsDir(), 'semantic', 'lib', 'dist', 'index.js');
const MODELS_DIR = () => path.join(programsDir(), 'semantic', 'models');

/**
 * The most rows one statement may return, across every page.
 *
 * The layer's contract says `executeSql` returns *every* row and the host
 * handles paging, and it means it: a program dataset asks for one row per
 * employee per week, which passes a thousand on a real subsidiary. Clamping to
 * one page instead of paging does not fail — it returns the first thousand rows
 * and lets the model average over them, which is the failure mode that never
 * gets noticed.
 *
 * A ceiling still exists, because a runaway join must stop somewhere, and the
 * caller is told when it was reached.
 */
const MAX_STATEMENT_ROWS = 50_000;

/** What `runSemanticQuery` is handed. */
export type SemanticRunOptions = SemanticRun;

/* ---------------------------------- schema ---------------------------------- */

/**
 * The physical columns of each table, lower-cased.
 *
 * Not optional in practice, whatever the package README says. Without it the
 * compiler emits every field expression verbatim and unqualified, and the first
 * join produces `Ambiguous column 'ID'` — the model knows a field is called
 * `id` but not which of the joined tables actually has one.
 *
 * Taken from the live source rather than from a checked-in dump, so a re-extract
 * is picked up on the next restart and there is no second copy to go stale.
 */
function schemaColumnsFor(sourceToolId: string): (table: string) => Set<string> {
	const manager = getSourceManager();
	const instance = manager
		?.getAllInstances()
		.find((i) => {
			try {
				return i.getTool().id === sourceToolId;
			} catch {
				return false;
			}
		});

	const byTable = new Map<string, Set<string>>();
	for (const entity of instance?.getSchema()?.entities ?? []) {
		byTable.set(
			String(entity.name).toLowerCase(),
			new Set((entity.fields ?? []).map((f) => String(f.name).toLowerCase())),
		);
	}

	if (!byTable.size) {
		console.warn(
			`[dash-semantic] no schema for "${sourceToolId}" — model queries will not disambiguate columns.`,
		);
	}

	return (table: string) => byTable.get(String(table).toLowerCase()) ?? new Set<string>();
}

/**
 * The connected source a model's queries belong to, or '' when that cannot be told.
 *
 * Every connected source lists every model, so the list says nothing. The dataset
 * tables do: the source whose schema holds the most of them. A model built only on
 * program datasets matches no schema, so it falls back to the source that holds
 * the most tables across all models.
 */
export function semanticSourceFor(connected: readonly string[], model?: string): string {
	if (connected.length < 2) return connected[0] ?? '';

	const tablesOf = (file: string): string[] => {
		try {
			const text = fs.readFileSync(file, 'utf-8');
			return [...text.matchAll(/^\s+source:\s*["']?([^"'\s#]+)/gm)].map((m) => m[1]!.toLowerCase());
		} catch {
			return [];
		}
	};

	const hits = (tables: string[]): Map<string, number> => {
		const counts = new Map<string, number>();
		for (const source of connected) {
			const columns = schemaColumnsFor(source);
			counts.set(
				source,
				tables.filter((t) => columns(t).size > 0 || columns(t.split(':').pop() ?? t).size > 0).length,
			);
		}
		return counts;
	};

	const best = (counts: Map<string, number>): string => {
		const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
		return ranked[0] && ranked[0][1] > 0 && ranked[0][1] !== ranked[1]?.[1] ? ranked[0][0] : '';
	};

	const dir = MODELS_DIR();
	if (model) {
		const chosen = best(hits(tablesOf(path.join(dir, `${model}.osi.yaml`))));
		if (chosen) return chosen;
	}

	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith('.osi.yaml'));
	} catch {
		return '';
	}
	return best(hits(files.flatMap((f) => tablesOf(path.join(dir, f)))));
}

/* --------------------------------- concepts --------------------------------- */

interface ConceptInfo {
	name: string;
	kind?: string;
	description?: string;
	body?: string;
	aliases?: string[];
	requires?: string[];
}

let conceptsByName: Map<string, ConceptInfo> | null = null;

/**
 * The concept text a manifest quotes beside a metric.
 *
 * The models name their concepts in a vendor extension, and without this the
 * manifest lists the names and none of the meaning — so the agent reads
 * "concepts: exempt hours" and has to go and fetch it separately, or does not.
 * The store on disk is the same one `./concept-catalog` serves, so a metric's
 * lineage and the catalogue cannot disagree.
 */
function conceptLookup(): (name: string) => ConceptInfo | undefined {
	if (!conceptsByName) {
		conceptsByName = new Map();
		try {
			const file = path.join(process.cwd(), 'entity-store', 'concepts.json');
			const all = JSON.parse(fs.readFileSync(file, 'utf-8')) as ConceptInfo[];
			for (const concept of all) {
				conceptsByName.set(concept.name.toLowerCase(), concept);
				for (const alias of concept.aliases ?? []) {
					if (!conceptsByName.has(alias.toLowerCase())) conceptsByName.set(alias.toLowerCase(), concept);
				}
			}
		} catch (err: any) {
			/* Lineage text is a nicety; a model still runs without it. */
			console.warn(`[dash-semantic] no concept text: ${err?.message ?? err}`);
		}
	}
	const index = conceptsByName;
	return (name: string) => index.get(String(name).toLowerCase());
}

/* ----------------------------------- layer ---------------------------------- */

/**
 * Imports the ESM package from CommonJS.
 *
 * `import()` written plainly is rewritten to `require()` by the compiler under
 * `module: CommonJS`, which cannot load an ESM entry point. Going through
 * `Function` keeps the real dynamic import in the emitted output.
 */
const importEsm: (specifier: string) => Promise<any> = new Function(
	'specifier',
	'return import(specifier)',
) as any;

/** One layer per source. Built on first use; the models are read once. */
const layers = new Map<string, Promise<any>>();

function layerFor(sourceToolId: string): Promise<any> {
	const existing = layers.get(sourceToolId);
	if (existing) return existing;

	const building = (async () => {
		const { createSemanticLayer } = await importEsm(
			/* A URL, not a Windows path: `import()` reads `C:` as a protocol. */
			new URL(`file://${LIB_ENTRY().replace(/\\/g, '/')}`).href,
		);

		const schemaColumns = schemaColumnsFor(sourceToolId);

		/* NetSuite speaks SuiteQL; SQL Server and Microsoft Fabric speak T-SQL. */
		const tsql = sourceTypeOf(sourceToolId) === 'mssql';

		const layer = createSemanticLayer({
			modelsDir: MODELS_DIR(),
			schemaColumns,
			dialect: tsql ? 'tsql' : 'suiteql',
			/**
			 * The datasets that are code rather than a query.
			 *
			 * Without these, any model with a program dataset loads and then
			 * refuses to run, reporting `registered: none` — utilisation,
			 * employee capacity and actual revenue all sit behind one.
			 */
			programs: registeredPrograms(),
			concepts: conceptLookup(),
			executeSql: async (sql: string, opts: { maxRows: number }) => {
				const run = currentRun.getStore();
				if (!run) throw new Error('A semantic query ran outside a resolver context.');

				const maxRows = Math.min(opts.maxRows || MAX_STATEMENT_ROWS, MAX_STATEMENT_ROWS);

				/* Only NetSuite pages by offset. SQL Server and Fabric ignore it, so a
				 * second page would be the first page again and every row past the
				 * first thousand would be counted twice. One request for the lot. */
				if (tsql) {
					if (run.signal.aborted) throw new SemanticError('Cancelled mid-statement.');
					const { rows } = await run.page(sql, maxRows, 0);
					if (rows.length >= maxRows) {
						console.warn(
							`[dash-semantic] statement hit the ${maxRows}-row ceiling; the model saw a partial fact.`,
						);
					}
					return rows;
				}

				/* Paged, not clamped — see MAX_STATEMENT_ROWS. The loop stops on the
				 * source saying there is no more, on reaching the ceiling, or on a
				 * short page, which is the same answer by a different route. */
				const all: Record<string, unknown>[] = [];
				for (let offset = 0; all.length < maxRows; offset += PAGE_ROWS) {
					if (run.signal.aborted) throw new SemanticError('Cancelled mid-statement.');
					const limit = Math.min(PAGE_ROWS, maxRows - all.length);
					const { rows, truncated } = await run.page(sql, limit, offset);
					all.push(...rows);
					if (!truncated || rows.length < limit) break;
				}

				if (all.length >= maxRows) {
					console.warn(
						`[dash-semantic] statement hit the ${MAX_STATEMENT_ROWS}-row ceiling; the model saw a partial fact.`,
					);
				}

				return all;
			},
		});

		for (const bad of layer.loadErrors ?? []) {
			console.warn(`[dash-semantic] ${bad.file}: ${bad.error}`);
		}
		return layer;
	})();

	layers.set(sourceToolId, building);
	/* A failed build must not be remembered as the answer — the next call should
	 * try again rather than repeat an import error forever. */
	building.catch(() => layers.delete(sourceToolId));
	return building;
}

/** Drops the cached layers, so an edited model is picked up without a restart. */
export function reloadSemanticModels(): void {
	layers.clear();
}

/* ------------------------------------ run ----------------------------------- */

/**
 * Metric values arrive as strings.
 *
 * NetSuite returns numerics as text and the layer passes them through
 * untouched, so a KPI card handed `"7310470.28"` renders it as a string and
 * every format setting is ignored. Metrics are numbers by definition, and the
 * result says which columns are metrics, so this is a conversion rather than a
 * guess.
 */
function coerceMetrics(result: any): Rows {
	const columns: any[] = result?.columns ?? [];
	const metricNames = new Set<string>(
		columns.filter((c) => c?.kind === 'metric').map((c) => String(c.name)),
	);

	/**
	 * Dimension columns arrive as `d0`, `d1`.
	 *
	 * Positional, because the compiler aliases them that way, and unusable in a
	 * resolver: `row.d1` says nothing about what it holds, and inserting a
	 * dimension silently renumbers every column after it. The result carries the
	 * ref each one came from, so they are renamed to the field's own name —
	 * `utilisation_week.employee_name` becomes `employee_name`.
	 *
	 * A collision keeps the qualified name rather than overwriting, which is the
	 * only case where two datasets contribute a field of the same name.
	 */
	const renamed = new Map<string, string>();
	const taken = new Set<string>(metricNames);
	for (const column of columns) {
		if (column?.kind !== 'dimension') continue;
		const ref = String(column.ref ?? column.name);
		const short = ref.split('.').pop() || ref;
		const name = taken.has(short) ? ref.replace(/\./g, '_') : short;
		taken.add(name);
		renamed.set(String(column.name), name);
	}

	return (result?.rows ?? []).map((row: Record<string, unknown>) => {
		const out: Record<string, any> = {};
		for (const [key, value] of Object.entries(row)) {
			if (metricNames.has(key) && typeof value === 'string' && value.trim() !== '') {
				const asNumber = Number(value);
				out[key] = Number.isFinite(asNumber) ? asNumber : value;
				continue;
			}
			out[renamed.get(key) ?? key] =
				value === undefined || typeof value === 'object' ? (value == null ? null : String(value)) : value;
		}
		return out;
	});
}

/**
 * Validates and runs one model query.
 *
 * A query the layer rejects throws with its own problem list rather than
 * returning nothing, for the reason `ctx.run` throws on `{ error }`: a
 * misspelled metric and a genuinely empty month must not look the same to the
 * person reading the panel.
 */
export async function runSemanticQuery(
	sourceToolId: string,
	query: SemanticQuery,
	opts: SemanticRunOptions,
): Promise<Rows> {
	const layer = await layerFor(sourceToolId);

	/* `compile()` reaches for `query.dimensions` without checking, so a metrics-
	 * only query throws inside the compiler unless the field is present. */
	const normalised = { ...query, dimensions: query.dimensions ?? [] };

	const response = await currentRun.run(opts, () =>
		layer.query(normalised),
	);

	if (!response?.ok) {
		const problems = (response?.problems ?? [])
			.map((p: any) => `${p.path ? `${p.path}: ` : ''}${p.message}`)
			.join('; ');
		throw new SemanticError(problems || 'The semantic layer rejected this query.');
	}

	return coerceMetrics(response.result);
}

/* ------------------------------- agent-facing ------------------------------- */

/** Every model, with its one-line description. */
export async function listSemanticModels(sourceToolId: string): Promise<unknown> {
	return (await layerFor(sourceToolId)).list();
}

/** Everything needed to write a query for one model, as prompt text. */
export async function semanticManifest(sourceToolId: string, model: string): Promise<string> {
	return (await layerFor(sourceToolId)).manifestText(model);
}

/** Problems with a query, without running it. */
export async function validateSemanticQuery(
	sourceToolId: string,
	query: SemanticQuery,
): Promise<unknown> {
	return (await layerFor(sourceToolId)).validate({ ...query, dimensions: query.dimensions ?? [] });
}

/** What a query would run — facts, joins, base filters and the compiled SQL. */
export async function explainSemanticQuery(
	sourceToolId: string,
	query: SemanticQuery,
): Promise<unknown> {
	return (await layerFor(sourceToolId)).explain({ ...query, dimensions: query.dimensions ?? [] });
}

/** Metrics and dimensions whose name, synonyms or description match some text. */
export async function suggestSemantic(sourceToolId: string, text: string): Promise<unknown> {
	return (await layerFor(sourceToolId)).suggest(text);
}

/** A metric, field or dataset in full, with its concept text. */
export async function describeSemantic(
	sourceToolId: string,
	model: string,
	name: string,
): Promise<unknown> {
	return (await layerFor(sourceToolId)).describe(model, name);
}
