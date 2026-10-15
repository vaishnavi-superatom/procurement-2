/**
 * The data access a semantic program is given, and nothing else.
 *
 * A program dataset is business logic the models delegate to — weekly
 * utilisation, charge-deduplicated revenue — and it needs to issue its own
 * queries. In the system these were ported from, it did that by importing a
 * NetSuite client module directly. That cannot happen here: a resolver's reach
 * is decided by its dashboard's grants, and a program reaching around
 * `createContext` would be a second route to a source with no grant check on
 * it and nothing in `meta.queries` to show it ran.
 *
 * So the statement runner is not imported by a program. It is put in place for
 * the duration of one semantic query and read back out of async context, which
 * means a program can only ever reach the source the caller already proved it
 * was allowed to reach.
 *
 * This module is separate from `semantic.ts` only to keep the import graph
 * acyclic: `semantic.ts` builds the layer with the programs, and the programs
 * need the runner.
 */
import { AsyncLocalStorage } from 'async_hooks';

/** One page of a statement. `truncated` means the source has more rows. */
export type PageFn = (
	sql: string,
	limit: number,
	offset: number,
) => Promise<{ rows: Record<string, unknown>[]; truncated: boolean }>;

export interface SemanticRun {
	signal: AbortSignal;
	/**
	 * Grant-checked and recorded by the caller. The only data access there is.
	 *
	 * Each page goes through the source's query cache, so a program's statements
	 * and the ones the compiler emits are remembered alike.
	 */
	page: PageFn;
}

/**
 * Whose statement runner the current query should use.
 *
 * The layer is built once per source — loading eight models and building a set
 * of every column of 350-odd tables is not work to repeat per panel — but the
 * runner belongs to a single resolver run, and several panels run at once.
 * `AsyncLocalStorage` is what lets one cached layer serve concurrent callers
 * without any of them seeing another's grants.
 */
export const currentRun = new AsyncLocalStorage<SemanticRun>();

export class SemanticError extends Error {
	readonly code = 'SEMANTIC_QUERY_FAILED';
}

function activeRun(): SemanticRun {
	const run = currentRun.getStore();
	if (!run) throw new SemanticError('A semantic program ran outside a resolver context.');
	return run;
}

/** The largest page NetSuite will serve. A property of the source, not a model. */
export const PAGE_ROWS = 1000;

/**
 * One page, the shape the ported programs expect.
 *
 * `limit` is clamped rather than rejected: every call site here inherited a
 * literal from code that talked to NetSuite directly, and a program asking for
 * 2,000 rows should get the first 1,000 and carry on, not throw.
 */
export async function suiteql<T = Record<string, unknown>>(
	q: string,
	opts: { limit?: number; offset?: number } = {},
): Promise<{ items: T[]; count: number; hasMore: boolean; offset: number }> {
	const run = activeRun();
	const limit = Math.min(Math.max(opts.limit ?? PAGE_ROWS, 1), PAGE_ROWS);
	const offset = Math.max(opts.offset ?? 0, 0);

	const { rows, truncated } = await run.page(q, limit, offset);
	return { items: rows as T[], count: rows.length, hasMore: truncated, offset };
}

/**
 * Every row, paged.
 *
 * The reason this exists rather than one big `limit`: SuiteQL refuses a page
 * above a thousand rows, and a program asking for one row per employee per week
 * passes that on any real subsidiary. Clamping instead of paging would not
 * fail — it would return the first thousand rows and let the model average over
 * them, which is the kind of wrong nobody goes looking for.
 */
export async function suiteqlAll<T = Record<string, unknown>>(
	q: string,
	opts: { maxRows?: number } = {},
): Promise<T[]> {
	const run = activeRun();
	const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;

	const out: T[] = [];
	for (let offset = 0; out.length < maxRows; offset += PAGE_ROWS) {
		if (run.signal.aborted) throw new SemanticError('Cancelled mid-statement.');
		const limit = Math.min(PAGE_ROWS, maxRows - out.length);
		const { rows, truncated } = await run.page(q, limit, offset);
		out.push(...(rows as T[]));
		/* A short page is the same answer as "no more" by a different route. */
		if (!truncated || rows.length < limit) break;
	}

	return out;
}
