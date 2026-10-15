/**
 * The server's answer store, on disk.
 *
 * One resolver run, one answer — so that opening a dashboard after lunch, or
 * being the second person to open it today, does not re-run a resolver that has
 * already run.
 *
 * This sits above the query cache (`sources/core/query-cache.ts`), which keeps
 * each SQL statement's rows. An answer is what a resolver computed from them.
 * Both live in the one SQLite file `services/cache-db.ts` opens.
 *
 * ### A cache that fails is not an outage
 *
 * Every operation here swallows its own errors. A database that will not open,
 * a row that will not parse, a disk that is full — all of them degrade to a
 * miss, never to a failed panel. The store exists to make things faster; it may
 * never be the reason something does not work.
 */
import * as crypto from 'crypto';
import { ensureTable, REFRESH_AFTER_MS } from '../services/cache-db';
import { resolvePolicies } from '../sources/core/policy-gate';
import type { DataResult, ParamValue, Rows } from './contract/types';
import { DEFAULT_MAX_ROWS } from './resolvers';

/* ---------------------------------- policy --------------------------------- */

/**
 * Whose rows an answer holds.
 *
 * The cache is shared, and that is what makes it worth having: the first reader
 * pays and everyone after does not. But a resolver's SQL is the same for every
 * reader while their rows are not — `prepareSql()` injects each reader's row
 * filters and readable tables inside the run, which a cache hit never reaches.
 * So the key carries the scope the run would have applied: readers with the same
 * access share an entry, readers with different access never do.
 *
 * `'global'` is no restriction on any granted source, which is every reader
 * today, so existing keys and hit rates do not change. A trusted `runAsSystem`
 * job has no policies and shares that entry. With no request context under
 * `enforce` this throws exactly as the run itself would, so an anonymous caller
 * can neither read nor fill an entry.
 */
const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') {
		const o = value as Record<string, unknown>;
		return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
};

export const policyFingerprint = (grants: readonly string[] = []): string => {
	const scopes: Record<string, unknown> = {};
	for (const id of [...grants].sort()) {
		/* A grant is the source's TOOL id (`<source>_query`); policies are written against
		 * the source id, which is what `prepareSql()` resolves them with. Asking with the
		 * tool id matches none of them, and every restricted reader shares the full entry. */
		const sourceId = id.replace(/_query$/, '');
		const { policies, readableTables } = resolvePolicies(sourceId, sourceId, { quiet: true });
		if (policies.length || readableTables.length) scopes[id] = { policies, readableTables: [...readableTables].sort() };
	}
	if (!Object.keys(scopes).length) return 'global';
	return `scoped:${crypto.createHash('sha256').update(stable(scopes)).digest('hex').slice(0, 16)}`;
};

/* ----------------------------------- keys ---------------------------------- */

export interface KeyParts {
	resolver: string;
	/** The resolver file's content hash — `ResolverSummary.version`. */
	version: string | undefined;
	params: Record<string, ParamValue>;
	/**
	 * The published manifest's source list.
	 *
	 * Publishing rewrites `manifest.grants` and can **narrow** it while every
	 * resolver hash stays identical. The resolver would then be refused a source
	 * it used to reach; that refusal is an error; errors are never cached — so
	 * without this the last successful answer stays reachable and the panel keeps
	 * showing rows from a source it may no longer read.
	 */
	grants?: readonly string[];
}

/** The label on an answer. All of it must match for the answer to be reused. */
export function cacheKey(parts: KeyParts): string {
	/* Sorted: `{a,b}` and `{b,a}` are the same question, and two spellings of one
	 * key would halve the hit rate for no reason. */
	const params = Object.keys(parts.params)
		.sort()
		.map((k) => `${k}=${JSON.stringify(parts.params[k])}`)
		.join('&');

	return [
		policyFingerprint(parts.grants),
		parts.resolver,
		parts.version ?? 'unversioned',
		/* The row cap changes the answer without moving the resolver hash. */
		DEFAULT_MAX_ROWS,
		parts.grants ? [...parts.grants].sort().join(',') : '-',
		params,
	].join('|');
}

/* ---------------------------------- policy --------------------------------- */

/**
 * How long an answer is trusted without checking.
 *
 * Inside it a reader gets the remembered answer and the source is not touched
 * at all. Past it the reader still gets the remembered answer — it arrives
 * instantly, which is the whole point — and a recompute starts behind it. When
 * that lands it replaces the entry and reaches the panel.
 *
 * So this is not an expiry. Nothing is ever thrown away for being old; the
 * number only decides whether a read is also a trigger. It is the query cache's
 * number too: a recompute goes to the source, so a shorter one here would
 * refresh statements more often than the query cache does.
 */
export const FRESH_MS = REFRESH_AFTER_MS;

/**
 * Nothing expires and nothing is evicted.
 *
 * An answer stays until its dashboard is deleted or something replaces it. That
 * is a deliberate trade: the table grows — publishing writes a new generation
 * under a new resolver hash, and every distinct filter combination is its own
 * row — in exchange for a dashboard that is never slow twice. Rows are JSON of
 * a capped result set, and SQLite is unbothered by a few hundred thousand of
 * them.
 *
 * The thing that would make this wrong is caching a failure, so failures are
 * never written. See `single`.
 */

/* ---------------------------------- store ---------------------------------- */

/** The shared cache database with the `answers` table in place, or `null`. */
function handle() {
	return ensureTable(
		'answers',
		`CREATE TABLE IF NOT EXISTS answers (
			dashboard_id TEXT NOT NULL,
			key          TEXT NOT NULL,
			result       TEXT NOT NULL,
			stored_at    INTEGER NOT NULL,
			last_read_at INTEGER NOT NULL,
			PRIMARY KEY (dashboard_id, key)
		);
		CREATE INDEX IF NOT EXISTS answers_lru ON answers (dashboard_id, last_read_at);`,
	);
}

/** A remembered answer and how old it is. */
export interface Remembered {
	result: DataResult<Rows>;
	/** True past `FRESH_MS` — serve it, and recompute behind it. */
	stale: boolean;
}

/**
 * A remembered answer, or `undefined`.
 *
 * `meta.cached` is set on the way out; `meta.computedAt` is passed through
 * untouched. It is when the query ran, and restamping it would turn an
 * hour-old answer into "as of just now" — a freshness indicator that lies is
 * worse than none.
 *
 * An old entry is still returned. Age is reported rather than acted on here,
 * because whether to recompute is the caller's decision and only the caller can
 * do anything with the result.
 */
export function read(dashboardId: string, key: string): Remembered | undefined {
	const handleOrNull = handle();
	if (!handleOrNull) return undefined;

	try {
		const row = handleOrNull
			.prepare('SELECT result, stored_at FROM answers WHERE dashboard_id = ? AND key = ?')
			.get(dashboardId, key) as { result?: string; stored_at?: number } | undefined;
		if (!row?.result) return undefined;

		/* `stored_at` says when the answer was computed and never moves;
		 * `last_read_at` is kept for a support query about what is actually used. */
		handleOrNull
			.prepare('UPDATE answers SET last_read_at = ? WHERE dashboard_id = ? AND key = ?')
			.run(Date.now(), dashboardId, key);

		const result = JSON.parse(row.result) as DataResult<Rows>;
		return {
			result: { ...result, meta: { ...result.meta, cached: true } },
			stale: Date.now() - Number(row.stored_at) > FRESH_MS,
		};
	} catch (err: any) {
		console.warn(`[dash-cache] read failed for ${dashboardId}: ${err?.message ?? err}`);
		return undefined;
	}
}

/** Remembers one answer. Errors are never remembered — see `single`. */
export function write(dashboardId: string, key: string, result: DataResult<Rows>): void {
	const handleOrNull = handle();
	if (!handleOrNull) return;

	try {
		const now = Date.now();
		handleOrNull
			.prepare(
				`INSERT INTO answers (dashboard_id, key, result, stored_at, last_read_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT (dashboard_id, key)
				 DO UPDATE SET result = excluded.result,
				               stored_at = excluded.stored_at,
				               last_read_at = excluded.last_read_at`,
			)
			.run(dashboardId, key, JSON.stringify(result), now, now);
	} catch (err: any) {
		console.warn(`[dash-cache] write failed for ${dashboardId}: ${err?.message ?? err}`);
	}
}

/**
 * Runs `execute`, or joins the run already happening for this key.
 *
 * Stays in memory, and must: this is about two promises in *this* process, not
 * about what has been stored. Without it, ten readers opening a dashboard the
 * moment an entry goes stale each start the same nine-second query — a stampede
 * at exactly the time load is highest. It is also what makes two panels over
 * one resolver cost one query, and what stops a burst of stale reads starting a
 * recompute each.
 *
 * A rejection is propagated and **never** stored. Nothing here expires, so a
 * cached failure would be permanent — the one way this file could stop being a
 * cache and start being a bug.
 */
const inFlight = new Map<string, Map<string, Promise<DataResult<Rows>>>>();

export function single(
	dashboardId: string,
	key: string,
	execute: () => Promise<DataResult<Rows>>,
): Promise<DataResult<Rows>> {
	let bucket = inFlight.get(dashboardId);
	if (!bucket) {
		bucket = new Map();
		inFlight.set(dashboardId, bucket);
	}

	const existing = bucket.get(key);
	if (existing) return existing;

	const run = execute()
		.then((result) => {
			write(dashboardId, key, result);
			return result;
		})
		.finally(() => {
			bucket!.delete(key);
			if (!bucket!.size) inFlight.delete(dashboardId);
		});

	bucket.set(key, run);
	return run;
}

/**
 * Starts a recompute behind an answer that has already been served.
 *
 * Fire and forget by design. The reader is not waiting — they have rows on
 * screen — so this must never delay a response and must never turn a failed
 * refresh into a failed panel. A failure leaves the previous answer in place,
 * which is the correct outcome: an old number beats no number, and the next
 * read will try again.
 *
 * `single` is what makes it safe to call on every stale read. Twenty panels
 * opening at once join one run.
 */
export function revalidate(
	dashboardId: string,
	key: string,
	execute: () => Promise<DataResult<Rows>>,
): void {
	if (inFlight.get(dashboardId)?.has(key)) return;
	void single(dashboardId, key, execute).catch((err: any) => {
		console.warn(
			`[dash-cache] background refresh failed for ${dashboardId}: ${err?.message ?? err}`,
		);
	});
}

/**
 * The run already happening for this key, if there is one.
 *
 * How a refreshed answer gets back to the panel that was served a stale one.
 * There is no server-to-client push on this path — `runResolver` is a request
 * and a response — so the panel asks a second time and that request waits here
 * instead of starting anything. If the recompute has already landed there is no
 * promise to wait for, and the caller reads the replaced entry.
 */
export const pending = (
	dashboardId: string,
	key: string,
): Promise<DataResult<Rows>> | undefined => inFlight.get(dashboardId)?.get(key);

/**
 * Everything remembered for one dashboard.
 *
 * Called when a dashboard is deleted. Dashboard ids come from SA-API and nothing
 * guarantees one can never be reissued — an answer surviving its dashboard is
 * rows from a deleted dashboard appearing in a new one, which is the sort of
 * thing nobody would think to look for. That matters more now the store is on
 * disk and outlives the process.
 */
export function clearDashboard(dashboardId: string): void {
	inFlight.delete(dashboardId);
	try {
		handle()?.prepare('DELETE FROM answers WHERE dashboard_id = ?').run(dashboardId);
	} catch (err: any) {
		console.warn(`[dash-cache] clear failed for ${dashboardId}: ${err?.message ?? err}`);
	}
}

/** For tests, and for a support command. */
export function clearAll(): void {
	inFlight.clear();
	try {
		handle()?.exec('DELETE FROM answers');
	} catch (err: any) {
		console.warn(`[dash-cache] clearAll failed: ${err?.message ?? err}`);
	}
}

/** What is held. For a debug endpoint or a test — never for a rendering decision. */
export const stats = () => {
	try {
		const row = handle()
			?.prepare('SELECT COUNT(DISTINCT dashboard_id) AS dashboards, COUNT(key) AS entries FROM answers')
			.get() as { dashboards?: number; entries?: number } | undefined;
		return {
			dashboards: Number(row?.dashboards ?? 0),
			entries: Number(row?.entries ?? 0),
			inFlight: [...inFlight.values()].reduce((n, b) => n + b.size, 0),
		};
	} catch {
		return { dashboards: 0, entries: 0, inFlight: 0 };
	}
};
