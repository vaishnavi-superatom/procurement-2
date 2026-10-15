/**
 * Source access — the only way a resolver reaches data.
 *
 * This is `ctx.sql`. It goes through the platform's existing source manager
 * rather than a driver the resolver imports, which is what makes two things
 * true at once: a resolver cannot open its own connection, and every statement
 * it issues is attributable to a dashboard and a grant.
 *
 * Deliberately NOT routed through the script bridge. That bridge exists for the
 * *agent's* bash shims and speaks HTTP on localhost; a resolver runs in this
 * process and has no business taking a network hop to reach a function it could
 * call directly.
 */
import { getAllTools } from '../tools';
import { getSourceManager } from '../sources';
import { withFreshReads } from '../sources/core/query-cache';
import { runSemanticQuery } from './semantic';
import type { ResolverContext, Rows, SemanticQuery } from './contract/types';

/** Cap on rows returned from one statement, before a resolver's own cap. */
export const DEFAULT_STATEMENT_ROW_CAP = 5_000;

export interface QueryRecord {
	source: string;
	elapsedMs: number;
	rows: number;
	truncated: boolean;
	/**
	 * The statement, as it was sent.
	 *
	 * Carried through to `meta.queries` so a panel can show what produced it.
	 * The text only — the parameter values are the dashboard's own filters and
	 * are already on screen beside the panel.
	 *
	 * Absent for a tool call, which is not a statement.
	 */
	sql?: string;
	/**
	 * True when this was a `ctx.run` call rather than a statement.
	 *
	 * Recorded in the same list on purpose. `meta.queries` is the evidence that a
	 * resolver actually reached for data, and a resolver doing all of its work
	 * through a tool has reached for data just as much as one that wrote SQL —
	 * counting only statements would call it inert.
	 */
	tool?: boolean;
}

export class GrantError extends Error {
	readonly code = 'FORBIDDEN_SOURCE';
}

export class QueryError extends Error {
	readonly code = 'RESOLVER_FAILED';
}

/**
 * Builds the `ctx` a resolver is handed.
 *
 * Everything it may do arrives here. There is no ambient capability to reach
 * around: a resolver that wants the filesystem has to import it, and the guard
 * refuses that before this code ever runs.
 */
export function createContext(opts: {
	/** Source tool ids from the dashboard's manifest. Nothing else is reachable. */
	grants: readonly string[];
	/** Direct-tool ids `ctx.run` may reach. Absent means none. */
	toolGrants?: readonly string[];
	signal: AbortSignal;
	/** Every statement goes to the source instead of the query cache; results are still stored. */
	fresh?: boolean;
	/** Per-statement row cap. */
	rowCap?: number;
	/** Collects timings, for the verification loop and the panel's debug view. */
	queries: QueryRecord[];
	/** Where `ctx.log` goes. */
	onLog?: (line: string) => void;
}): ResolverContext {
	const rowCap = opts.rowCap ?? DEFAULT_STATEMENT_ROW_CAP;

	/** A source or tool call, reading the query cache unless this run is fresh. */
	const throughCache = <T>(call: () => Promise<T>): Promise<T> =>
		opts.fresh ? withFreshReads(call) : call();

	/**
	 * One statement, grant-checked and recorded.
	 *
	 * Named rather than inlined into `sql` because `semantic` needs exactly the
	 * same thing for the SQL its models compile to. Two routes to a source would
	 * mean two places a grant has to be checked, and eventually only one of them
	 * would be right.
	 */
	async function runStatement(
		source: string,
		text: string,
		params: Record<string, unknown>,
		limit: number,
		offset?: number,
	): Promise<{ rows: any[]; truncated: boolean }> {
		/**
		 * The grant check is first and is not negotiable.
		 *
		 * A dashboard cannot widen its own reach at runtime: the manifest is
		 * read by the platform, and the resolver never sees a way to change it.
		 */
		if (!opts.grants.includes(source)) {
			throw new GrantError(
				`This dashboard is not granted "${source}". Granted: ${
					opts.grants.join(', ') || 'none'
				}`,
			);
		}

		if (opts.signal.aborted) throw new QueryError('Cancelled before the statement ran.');

		const tool = getAllTools().find((t: any) => t.id === source || t.name === source);
		if (!tool) {
			throw new QueryError(
				`Source "${source}" is granted but not connected in this environment.`,
			);
		}

		const bound = expandLists(text, params);

		const started = Date.now();
		let result: any;
		try {
			result = await throughCache(() =>
				(tool as any).fn({ sql: bound.text, params: bound.params, limit, offset }, opts.signal),
			);
		} catch (err: any) {
			/* The source's own message is the useful part — a wrapped "query
			 * failed" tells the author nothing about which column was wrong. */
			throw new QueryError(err?.message ?? String(err));
		}

		const rows: any[] = Array.isArray(result?.data)
			? result.data
			: Array.isArray(result)
				? result
				: result?.data != null
					? [result.data]
					: [];

		/**
		 * Truncation is recorded, never swallowed.
		 *
		 * A chart drawn from the first 10,000 of 4,000,000 rows is the most
		 * expensive kind of wrong, so this has to reach the caller and, in
		 * the end, the reader.
		 */
		const truncated = Boolean(result?.metadata?.truncated) || rows.length >= limit;

		opts.queries.push({
			source,
			elapsedMs: Date.now() - started,
			rows: rows.length,
			truncated,
			sql: bound.text,
		});

		return { rows, truncated };
	}

	return {
		sources: opts.grants,
		tools: opts.toolGrants ?? [],

		log(...args: unknown[]) {
			const line = args
				.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
				.join(' ');
			opts.onLog?.(line);
		},

		get signal() {
			return opts.signal;
		},

		async sql<T = Record<string, unknown>>(
			source: string,
			text: string,
			params: Record<string, unknown> = {},
		): Promise<T[]> {
			return (await runStatement(source, text, params, rowCap)).rows as T[];
		},

		/**
		 * A model query, compiled to SQL and run down the same path as `sql`.
		 *
		 * The grant is checked here as well as inside `runStatement`, so a
		 * refusal names the semantic call rather than surfacing as a statement
		 * failure from a query the author never wrote.
		 */
		async semantic(source: string, query: SemanticQuery): Promise<Rows> {
			if (!opts.grants.includes(source)) {
				throw new GrantError(
					`This dashboard is not granted "${source}". Granted: ${
						opts.grants.join(', ') || 'none'
					}`,
				);
			}
			if (opts.signal.aborted) throw new QueryError('Cancelled before the model query ran.');

			return runSemanticQuery(source, query, {
				signal: opts.signal,
				/**
				 * One page. The semantic module does the paging, because only it
				 * knows how many rows the model actually asked for.
				 */
				page: (text, limit, offset) => runStatement(source, text, {}, limit, offset),
			});
		},

		async run<T = unknown>(tool: string, params: Record<string, unknown> = {}): Promise<T> {
			/* Same treatment as a source, and for the same reason: a resolver may
			 * not widen its own reach by editing the file it lives in. */
			if (!(opts.toolGrants ?? []).includes(tool)) {
				throw new GrantError(
					`This dashboard is not granted the tool "${tool}". Granted: ${
						(opts.toolGrants ?? []).join(', ') || 'none'
					}`,
				);
			}

			if (opts.signal.aborted) throw new QueryError('Cancelled before the tool ran.');

			/**
			 * Direct tools only.
			 *
			 * A source's query tool is reachable through `sql`, which grant-checks
			 * against `sources`. Letting it through here as well would put one
			 * capability behind two different checks, and the looser one would
			 * eventually be the one that mattered.
			 */
			const found = getAllTools().find((t: any) => t.id === tool && t.toolType === 'direct');
			if (!found) {
				throw new QueryError(
					`Tool "${tool}" is granted but not registered in this environment.`,
				);
			}

			const started = Date.now();
			let result: any;
			try {
				result = await throughCache(() => (found as any).fn(params, opts.signal));
			} catch (err: any) {
				throw new QueryError(err?.message ?? String(err));
			}

			/**
			 * A reported error is thrown, never returned.
			 *
			 * Direct tools answer `{ error }` rather than rejecting — good for the
			 * agent, which reads the message and tries again, and wrong here: a
			 * resolver that got `{ error }` back as data would render it as a panel
			 * with no rows, which is indistinguishable from a query that genuinely
			 * matched nothing.
			 */
			if (result && typeof result === 'object' && typeof result.error === 'string') {
				throw new QueryError(`${tool}: ${result.error}`);
			}

			const data = result && typeof result === 'object' && 'data' in result ? result.data : result;

			opts.queries.push({
				source: tool,
				elapsedMs: Date.now() - started,
				rows: Array.isArray(data) ? data.length : data == null ? 0 : 1,
				truncated: false,
				tool: true,
			});

			return data as T;
		},
	};
}

/**
 * Turns each list parameter into one scalar parameter per item.
 *
 * Sources bind named scalars their own way and do not agree on a list, so
 * `IN ($pillars)` becomes `IN ($pillars__0, $pillars__1)` and every source sees
 * only scalars. An empty list becomes `NULL`, which matches nothing, and
 * `$pillars_count` is bound beside it for "nothing picked means no filter".
 */
export function expandLists(
	text: string,
	params: Record<string, unknown>,
): { text: string; params: Record<string, unknown> } {
	const lists = new Map<string, unknown[]>();
	const out: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(params)) {
		if (Array.isArray(value)) lists.set(name, value);
		else out[name] = value;
	}
	if (!lists.size) return { text, params };

	for (const [name, items] of lists) {
		items.forEach((item, i) => {
			out[`${name}__${i}`] = item;
		});
		if (!(`${name}_count` in out)) out[`${name}_count`] = items.length;
	}

	const expanded = text.replace(/\$(\w+)/g, (match, name: string) => {
		const items = lists.get(name);
		if (!items) return match;
		return items.length ? items.map((_, i) => `$${name}__${i}`).join(', ') : 'NULL';
	});

	return { text: expanded, params: out };
}

/**
 * Source tool ids a resolver can actually query.
 *
 * Used for two things and nothing else: the grants a conversation is given, and
 * the guard's check that a manifest names something real.
 *
 * **The filter is "can `ctx.sql` reach it", not "is it a tool".** A resolver's
 * only data call is `ctx.sql(sourceToolId, …)`, so anything that cannot answer
 * SQL does not belong in this list however tool-shaped it looks.
 *
 * ### Why the source manager and not a name pattern
 *
 * This used to read `getAllTools()` and keep the ids ending in `_query`, on the
 * reasoning that `_query` is the platform's convention for a queryable source.
 * It is the convention for *some* of them. NetSuite's tool is
 * `netsuite-…_suiteql` — see `sources/netsuite/instance.ts` — so a NetSuite
 * connection was filtered out of every dashboard's grants and the agent was
 * told, correctly from what it could see, that it had no access:
 *
 * > "NetSuite access is enforced outside the program files, so editing the
 * > generated manifest cannot grant it; the resolver cannot be run or published
 * > under the current dashboard permissions."
 *
 * It then deleted its own work rather than ship something unpublishable, which
 * is the right behaviour on a wrong premise. `data-tools.ts` had already been
 * bitten by this and says so in a comment — *"deliberately not filtered by an id
 * suffix: that is source-type specific… and a suffix guess silently offered this
 * project nothing"* — while this function went on guessing.
 *
 * `getSourceTools()` is the source manager's own list of connections, which is
 * the question actually being asked. `script_dataset` — a sentinel the other
 * flow uses for an in-memory dataset, with no connection behind it — is not in
 * it, so the case the suffix filter was added for is handled by asking the right
 * thing rather than by pattern-matching a name.
 */
export function connectedSourceIds(): string[] {
	try {
		return (getSourceManager()?.getSourceTools() ?? [])
			.filter((t: any) => t.toolType !== 'direct')
			.map((t: any) => t.id as string);
	} catch {
		return [];
	}
}

/**
 * Direct-tool ids a resolver can call through `ctx.run`.
 *
 * The mirror of `connectedSourceIds`, and asked of the same registry the agent's
 * `./run-tool` uses — so a tool the agent can test with is a tool the resolver
 * it writes can actually call. Those being different lists is how an agent ends
 * up proving a number it has no way to reproduce.
 *
 * `toolType: 'direct'` is the whole filter: source query tools belong to
 * `ctx.sql`, and a sentinel like `script_dataset` answers neither.
 */
export function directToolIds(): string[] {
	try {
		return getAllTools()
			.filter((t: any) => t.toolType === 'direct')
			.map((t: any) => t.id as string);
	} catch {
		return [];
	}
}
