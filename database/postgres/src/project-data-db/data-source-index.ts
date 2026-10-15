import { db, schema } from './drizzle-db';
import { eq, and, sql } from 'drizzle-orm';

const { dataSourceIndex, projectSources } = schema;

/**
 * DATA SOURCE INDEX — the searchable catalog of source / table / column.
 *
 * One row per column, so a name can be FOUND without reading a schema file:
 * find-schema searches this, get-schema reads one table out of it. Storage and
 * search only; nothing here touches a customer database.
 *
 * Ported from fusion-5 `coding-agents` (af971079) WITHOUT its live re-extraction:
 * a projection of `project_sources` (semantic model, else raw schema), rebuilt
 * for a source whenever either is written (reindexSourceLater) and backfilled at
 * startup. `updated_at` and `indexed_from` say when and from what.
 */

/** The dotted natural key. One definition, so `id` can never drift from the parts. */
export function buildIndexId(sourceName: string, tableName: string, columnName: string): string {
	return `${sourceName}.${tableName}.${columnName}`;
}

// pg caps a statement at 65535 bind parameters. 500 rows keeps it far clear.
const INSERT_CHUNK = 500;

/** Soft-delete: keep the rows, take them out of every search. */
export async function disableSourceByName(sourceName: string): Promise<number> {
	const updated = await db
		.update(dataSourceIndex)
		.set({ status: 'disabled' })
		.where(eq(dataSourceIndex.sourceName, sourceName))
		.returning({ id: dataSourceIndex.id });
	return updated.length;
}

export interface SearchOptions {
	query?: string;
	sourceName?: string;
	tableName?: string;
	limit?: number;
	/** Include rows whose source was deleted/deactivated. Off by default. */
	includeDisabled?: boolean;
}

/**
 * Search by source / table / column name.
 *
 * Two tiers, because neither alone suffices: Postgres's parser already splits
 * `custentity_lead_source` into custentity/lead/source, so FTS covers whole
 * word, multi-word and prefix (`cust:*`) — but it cannot match inside a token
 * ('entity' within 'custentity') or split camelCase. The LIKE arm covers those
 * and rides the trigram index.
 */
export async function searchDataSourceIndex(opts: SearchOptions) {
	const { query, sourceName, tableName, limit = 50, includeDisabled = false } = opts;

	const filters = [
		includeDisabled ? undefined : eq(dataSourceIndex.status, 'active'),
		sourceName ? eq(dataSourceIndex.sourceName, sourceName) : undefined,
		tableName ? eq(dataSourceIndex.tableName, tableName) : undefined,
	].filter(Boolean) as any[];

	const terms = (query ?? '').trim().toLowerCase().split(/\s+/)
		.map(t => t.replace(/[^\w]/g, '')).filter(Boolean);

	if (terms.length) {
		// By hand rather than websearch_to_tsquery, which drops the prefix
		// wildcard that makes 'cust' -> 'cust:*' work.
		const tsquery = terms.map(t => `${t}:*`).join(' & ');
		const like = `%${query!.trim().toLowerCase()}%`;
		// Third arm: separators stripped on BOTH sides. "credit days" is two words
		// and the column is CreditDays — one token, so neither the word search nor
		// a spaced LIKE can reach it.
		const squashed = `%${terms.join('')}%`;
		filters.push(sql`(
			to_tsvector('simple', ${dataSourceIndex.sourceName} || ' ' || ${dataSourceIndex.tableName} || ' ' || ${dataSourceIndex.columnName})
				@@ to_tsquery('simple', ${tsquery})
			OR lower(${dataSourceIndex.sourceName} || ' ' || ${dataSourceIndex.tableName} || ' ' || ${dataSourceIndex.columnName}) LIKE ${like}
			OR regexp_replace(lower(${dataSourceIndex.tableName} || ${dataSourceIndex.columnName}), '[^a-z0-9]', '', 'g') LIKE ${squashed}
		)`);
	}

	// Relevance, not alphabet: ordering by name and truncating answered "job"
	// with creditmemo.job while the `job` table's own columns fell outside the
	// window. A table-name hit outranks a column-name hit. No terms, no score:
	// a constant here renders as ORDER BY 0, which Postgres reads as a position.
	const score = terms.length
		? sql.join(terms.map(t => sql`(
			CASE WHEN lower(${dataSourceIndex.tableName}) = ${t} THEN 10
			     WHEN lower(${dataSourceIndex.tableName}) LIKE ${'%' + t + '%'} THEN 5
			     ELSE 0 END
			+ CASE WHEN lower(${dataSourceIndex.columnName}) = ${t} THEN 3
			       WHEN lower(${dataSourceIndex.columnName}) LIKE ${'%' + t + '%'} THEN 1
			       ELSE 0 END
		)`), sql` + `)
		: null;

	return db
		.select({
			sourceName: dataSourceIndex.sourceName,
			tableName: dataSourceIndex.tableName,
			columnName: dataSourceIndex.columnName,
			dataType: dataSourceIndex.dataType,
			description: dataSourceIndex.description,
			rowCount: dataSourceIndex.rowCount,
		})
		.from(dataSourceIndex)
		.where(filters.length ? and(...filters) : undefined)
		.orderBy(...(score ? [sql`${score} DESC`] : []), dataSourceIndex.tableName, dataSourceIndex.columnName)
		.limit(limit);
}

/** Every column of one table, in full — what get-schema prints. */
export async function getIndexedTable(sourceName: string | null, tableName: string) {
	const filters = [
		eq(dataSourceIndex.status, 'active'),
		sql`lower(${dataSourceIndex.tableName}) = ${tableName.trim().toLowerCase()}`,
		sourceName ? eq(dataSourceIndex.sourceName, sourceName) : undefined,
	].filter(Boolean) as any[];

	return db.select().from(dataSourceIndex).where(and(...filters))
		.orderBy(dataSourceIndex.sourceName, dataSourceIndex.columnName);
}

/** Distinct tables matching a name — the disambiguation get-schema needs. */
export async function findIndexedTables(namePart: string, limit = 25) {
	const res: any = await db.execute(sql`
		SELECT source_name AS "sourceName", table_name AS "tableName",
		       COUNT(*)::int AS "columnCount", MAX(row_count) AS "rowCount"
		FROM data_source_index
		WHERE status = 'active' AND lower(table_name) LIKE ${'%' + namePart.trim().toLowerCase() + '%'}
		GROUP BY source_name, table_name
		ORDER BY CASE WHEN lower(table_name) = ${namePart.trim().toLowerCase()} THEN 0 ELSE 1 END, table_name
		LIMIT ${limit}
	`);
	return res.rows as Array<{ sourceName: string; tableName: string; columnCount: number; rowCount: number | null }>;
}

/** One column as the populator produces it. */
export interface IndexedColumn {
	tableName: string;
	columnName: string;
	dataType?: string | null;
	isNullable?: boolean | null;
	rowCount?: number | null;
	distinctCount?: number | null;
	nonNullCount?: number | null;
	cardinality?: string | null;
	sampleValues?: unknown[];
	statistics?: Record<string, unknown>;
	description?: string | null;
	isPrimaryKey?: boolean | null;
	/** What the TABLE is; identical on every column of that table. */
	tableMeta?: Record<string, unknown>;
}

/** Replace one source's rows wholesale: delete-then-insert, in a transaction. */
export async function replaceSourceColumns(
	sourceName: string,
	columns: IndexedColumn[],
	indexedFrom = 'semantic-model',
): Promise<number> {
	// A duplicate would fail the whole insert on the primary key; collapse first.
	const seen = new Set<string>();
	const rows = columns
		.map(c => ({
			id: buildIndexId(sourceName, c.tableName, c.columnName),
			sourceName,
			tableName: c.tableName,
			columnName: c.columnName,
			status: 'active',
			dataType: c.dataType ?? null,
			isNullable: c.isNullable ?? null,
			rowCount: c.rowCount ?? null,
			distinctCount: c.distinctCount ?? null,
			nonNullCount: c.nonNullCount ?? null,
			cardinality: c.cardinality ?? null,
			sampleValues: (c.sampleValues ?? []) as any,
			statistics: (c.statistics ?? {}) as any,
			description: c.description ?? null,
			isPrimaryKey: c.isPrimaryKey ?? null,
			tableMeta: (c.tableMeta ?? {}) as any,
			indexedFrom,
		}))
		.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));

	await db.transaction(async (tx) => {
		await tx.delete(dataSourceIndex).where(eq(dataSourceIndex.sourceName, sourceName));
		for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
			await tx.insert(dataSourceIndex).values(rows.slice(i, i + INSERT_CHUNK));
		}
	});
	return rows.length;
}

/** Per source: when it was indexed and how much of it — for reporting staleness. */
export async function getIndexFreshness() {
	const res: any = await db.execute(sql`
		SELECT source_name AS "sourceName", indexed_from AS "indexedFrom",
		       COUNT(DISTINCT table_name)::int AS "tables", COUNT(*)::int AS "columns",
		       MAX(updated_at) AS "indexedAt"
		FROM data_source_index WHERE status = 'active'
		GROUP BY source_name, indexed_from ORDER BY source_name
	`);
	return res.rows as Array<{ sourceName: string; indexedFrom: string | null; tables: number; columns: number; indexedAt: string }>;
}

// ── Projection from project_sources ──────────────────────────────────────────

/** Distinct sample values per column. */
const MAX_SAMPLES = 40;
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const parseJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

/**
 * What to index: the semantic model when the source has one — it is the curated
 * list of what exists, including views authored into it that extraction does
 * not return — and the raw schema otherwise. Raw tables missing from the model
 * are reported, not added: some are new since the model was written, others
 * were left out on purpose (scratch tables), and nothing records which.
 */
export function modelForIndex(raw: any, sem: any): { model: any; from: string; notInModel: string[] } | null {
	if (sem?.entities?.length) {
		const inModel = new Set<string>(sem.entities.map((e: any) => e.name));
		const notInModel: string[] = (raw?.entities ?? []).map((e: any) => e.name).filter((n: string) => !inModel.has(n));
		return { model: sem, from: 'semantic-model', notInModel };
	}
	if (raw?.entities?.length) return { model: raw, from: 'schema', notInModel: [] };
	return null;
}

/** One row per column, carrying its table's meaning so a column is placed by it. */
export function columnsFromModel(model: any): IndexedColumn[] {
	const out: IndexedColumn[] = [];
	for (const e of model?.entities ?? []) {
		const tableMeta = {
			...(e.description || e.semantic?.summary ? { description: e.description || e.semantic?.summary } : {}),
			...(e.primaryKey ? { primaryKey: e.primaryKey } : {}),
			...(e.semantic?.joins?.length ? { joins: e.semantic.joins } : {}),
			...(e.semantic?.synonyms?.length ? { synonyms: e.semantic.synonyms } : {}),
			...(e.semantic?.notes ? { notes: e.semantic.notes } : {}),
		};
		for (const f of e.fields ?? []) {
			out.push({
				tableName: e.name,
				columnName: f.name,
				dataType: f.nativeType || f.type || null,
				isNullable: typeof f.nullable === 'boolean' ? f.nullable : null,
				// Counts arrive as strings from some extractors; coerce, or every row
				// silently indexes with no row count.
				rowCount: num(e.rowCount),
				distinctCount: num(f.statistics?.distinct ?? f.statistics?.distinctCount),
				nonNullCount: num(f.statistics?.nonNullCount),
				cardinality: f.cardinality ?? null,
				sampleValues: (f.semantic?.valueVocabulary ?? []).slice(0, MAX_SAMPLES),
				statistics: f.statistics ?? {},
				description: f.description || f.semantic?.summary || null,
				isPrimaryKey: typeof f.isPrimaryKey === 'boolean' ? f.isPrimaryKey : null,
				tableMeta,
			});
		}
	}
	return out;
}

/**
 * Rebuild one source's rows from what project_sources holds now. Keyed by
 * source id, so a rename cannot orphan them. A deleted or inactive source is
 * disabled, never erased.
 */
export async function reindexSource(sourceId: string): Promise<{ tables: number; columns: number; from: string; notInModel: string[] } | null> {
	const [s] = await db
		.select({ id: projectSources.id, schema: projectSources.schema, semanticModel: projectSources.semanticModel, isActive: projectSources.isActive })
		.from(projectSources)
		.where(eq(projectSources.id, sourceId))
		.limit(1);
	if (!s || s.isActive === false) {
		await disableSourceByName(sourceId);
		return null;
	}
	const picked = modelForIndex(parseJson(s.schema), parseJson(s.semanticModel));
	if (!picked) return null;
	const columns = columnsFromModel(picked.model);
	const written = await replaceSourceColumns(s.id, columns, picked.from);
	return { tables: new Set(columns.map(c => c.tableName)).size, columns: written, from: picked.from, notInModel: picked.notInModel };
}

/** Raw tables the semantic model leaves out, for someone to add on purpose or ignore. */
export function notInModelLine(sourceId: string, names: string[]): string {
	return `[data-source-index] ${sourceId}: ${names.length} table(s) in the database are not in the semantic model, so not indexed: `
		+ `${names.slice(0, 20).join(', ')}${names.length > 20 ? `, … ${names.length - 20} more` : ''}`;
}

// One rebuild at a time per source: two at once both delete-then-insert the
// same ids and the second fails on the key. A rebuild already queued reads the
// latest state when it starts, so a burst of writes costs one rebuild.
const chains = new Map<string, Promise<void>>();
const queued = new Set<string>();

/** From a write path: never slows the write, and a failure is logged, not thrown. */
export function reindexSourceLater(sourceId: string, why: string): void {
	if (!sourceId || queued.has(sourceId)) return;
	queued.add(sourceId);
	const next = (chains.get(sourceId) ?? Promise.resolve())
		.then(async () => {
			queued.delete(sourceId);
			const r = await reindexSource(sourceId);
			console.log(r
				? `[data-source-index] ${sourceId}: ${r.tables} tables, ${r.columns} columns from ${r.from} (${why})`
				: `[data-source-index] ${sourceId}: nothing to index (${why})`);
			if (r?.notInModel.length) console.log(notInModelLine(sourceId, r.notInModel));
		})
		.catch(err => console.warn(`[data-source-index] ${sourceId}: reindex failed (${why}): ${err?.message ?? err}`))
		.finally(() => { if (chains.get(sourceId) === next) chains.delete(sourceId); });
	chains.set(sourceId, next);
}

/**
 * Startup: every active source of the project with no active rows gets built —
 * a new client's sources, and deployments from before indexing was automatic.
 */
export async function backfillDataSourceIndex(projectId: string): Promise<number> {
	const res: any = await db.execute(sql`
		SELECT ps.id FROM project_sources ps
		WHERE ps.project_id = ${projectId} AND COALESCE(ps.is_active, true)
		  AND NOT EXISTS (SELECT 1 FROM data_source_index d WHERE d.source_name = ps.id AND d.status = 'active')
	`);
	const ids = (res.rows as Array<{ id: string }>).map(r => r.id);
	for (const id of ids) reindexSourceLater(id, 'startup backfill');
	return ids.length;
}
