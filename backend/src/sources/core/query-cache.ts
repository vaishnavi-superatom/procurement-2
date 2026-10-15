/**
 * The query cache, in front of every source.
 *
 * Every read-only SQL statement a source runs for an answer comes through here:
 * a resolver's `ctx.sql` and semantic queries, the agents' `./query`, a chat
 * answer's components, `executeByQueryId`, scripts, and every SDK flow — they all
 * reach a source through its tool's `fn` or `BaseSource.cachedExecute`.
 *
 * So the same statement asked in another thread, by another agent or by another
 * dashboard is answered from here instead of the source.
 *
 * ### What an entry is
 *
 * One row per source and statement: the SQL, its params, its offset and any
 * other input except the row limit. The row limit is stored beside the result,
 * and an entry answers any request it holds enough rows for — a 250-row result
 * serves a 50-row request, and a complete result serves every request.
 *
 * ### Staleness
 *
 * Nothing expires. An entry older than `REFRESH_AFTER_MS` is still served, and a
 * refresh runs behind it. `withFreshReads` skips the read for a caller whose job
 * is to see what the source says now — a dashboard refresh, an agent verifying a
 * panel — and still writes what it gets.
 *
 * ### Never stored
 *
 * Errors, and anything that is not read-only SQL.
 */
import * as crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { ensureTable, REFRESH_AFTER_MS } from '../../services/cache-db';
import { isReadOnlySql } from './sql-guard';

/** Runs the statement against the source. */
export type RunQuery = (input: any, signal?: AbortSignal) => Promise<any>;

/* ---------------------------------- fresh ---------------------------------- */

const freshReads = new AsyncLocalStorage<true>();

/** Runs `fn` with every statement inside it going to the source. Results are still stored. */
export function withFreshReads<T>(fn: () => T): T {
	return freshReads.run(true, fn);
}

/* ---------------------------------- table ---------------------------------- */

const TABLE = 'queries';

function table() {
	return ensureTable(
		TABLE,
		`CREATE TABLE IF NOT EXISTS queries (
			source       TEXT NOT NULL,
			key          TEXT NOT NULL,
			result       TEXT NOT NULL,
			row_limit    INTEGER,
			stored_at    INTEGER NOT NULL,
			last_read_at INTEGER NOT NULL,
			PRIMARY KEY (source, key)
		);
		CREATE INDEX IF NOT EXISTS queries_last_read ON queries (last_read_at);`,
	);
}

interface Entry {
	result: any;
	/** The row limit the result was fetched under. `null` is the source's own default. */
	limit: number | null;
	storedAt: number;
}

function read(source: string, key: string): Entry | undefined {
	const db = table();
	if (!db) return undefined;
	try {
		const row = db
			.prepare('SELECT result, row_limit, stored_at FROM queries WHERE source = ? AND key = ?')
			.get(source, key) as { result?: string; row_limit?: number | null; stored_at?: number } | undefined;
		if (!row?.result) return undefined;

		db.prepare('UPDATE queries SET last_read_at = ? WHERE source = ? AND key = ?').run(Date.now(), source, key);

		return {
			result: JSON.parse(row.result),
			limit: row.row_limit == null ? null : Number(row.row_limit),
			storedAt: Number(row.stored_at),
		};
	} catch (err: any) {
		console.warn(`[query-cache] read failed for ${source}: ${err?.message ?? err}`);
		return undefined;
	}
}

function write(source: string, key: string, limit: number | null, result: any): void {
	const db = table();
	if (!db) return;
	try {
		const now = Date.now();
		db.prepare(
			`INSERT INTO queries (source, key, result, row_limit, stored_at, last_read_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (source, key)
			 DO UPDATE SET result = excluded.result,
			               row_limit = excluded.row_limit,
			               stored_at = excluded.stored_at,
			               last_read_at = excluded.last_read_at`,
		).run(source, key, JSON.stringify(result), limit, now, now);
	} catch (err: any) {
		console.warn(`[query-cache] write failed for ${source}: ${err?.message ?? err}`);
	}
}

/* ----------------------------------- keys ---------------------------------- */

/** JSON with object keys sorted, so two spellings of one input are one key. */
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object' && !(value instanceof Date)) {
		return `{${Object.keys(value as Record<string, unknown>)
			.filter((k) => (value as Record<string, unknown>)[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/**
 * The SQL as a key: every run of whitespace is one space, outside `'literals'`
 * and `"identifiers"`, with no leading or trailing whitespace or `;`. A query
 * formatted over many lines and the same query on one line are one entry.
 */
function normaliseSql(sql: string): string {
	let out = '';
	let quote: string | null = null;
	let space = false;

	for (const ch of sql) {
		if (quote) {
			out += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (/\s/.test(ch)) {
			space = true;
			continue;
		}
		if (space && out) out += ' ';
		space = false;
		out += ch;
		if (ch === "'" || ch === '"') quote = ch;
	}

	return out.replace(/[\s;]+$/, '');
}

/** Everything in the input except the row limit, hashed. */
function keyFor(input: Record<string, unknown>): string {
	const { limit: _limit, ...rest } = input;
	if (typeof rest.sql === 'string') rest.sql = normaliseSql(rest.sql);
	return crypto.createHash('sha256').update(stable(rest)).digest('hex');
}

/* --------------------------------- serving --------------------------------- */

function isStorable(result: any): boolean {
	return Boolean(result) && !result.error && Array.isArray(result.data);
}

/** Whether `entry` holds the rows a request under `limit` would get. */
function covers(entry: Entry, limit: number | null): boolean {
	const rows = entry.result.data.length;
	const complete = !entry.result.metadata?.truncated && (entry.limit == null || rows < entry.limit);
	if (complete) return true;
	if (limit == null) return entry.limit == null;
	return rows >= limit;
}

/** A copy of `result` cut to `limit`, so no caller can change what another receives. */
function served(result: any, limit: number | null, storedAt?: number): any {
	let data: any[] = result.data;
	let metadata = result.metadata;

	if (limit != null && data.length > limit) {
		metadata = { ...metadata, truncated: true, totalCount: metadata?.totalCount ?? data.length };
		data = data.slice(0, limit);
	} else {
		data = data.slice();
	}
	if (storedAt !== undefined) metadata = { ...metadata, cached: true, cachedAt: new Date(storedAt).toISOString() };

	return { ...result, data, count: data.length, ...(metadata ? { metadata } : {}) };
}

/* --------------------------------- in flight -------------------------------- */

/**
 * One statement running against the source.
 *
 * Callers asking for the same statement at the same limit wait on one run. The
 * run is cancelled only when every caller waiting on it has aborted.
 */
interface Flight {
	promise: Promise<any>;
	controller: AbortController;
	waiters: number;
}

const flights = new Map<string, Flight>();

function flightFor(source: string, key: string, limit: number | null, input: any, run: RunQuery): Flight {
	const id = `${source}\n${key}\n${limit ?? 'default'}`;
	const existing = flights.get(id);
	if (existing && !existing.controller.signal.aborted) return existing;

	const controller = new AbortController();
	const flight: Flight = { controller, waiters: 0, promise: Promise.resolve() };
	flight.promise = run(input, controller.signal)
		.then((result) => {
			if (isStorable(result)) write(source, key, limit, result);
			return result;
		})
		.finally(() => {
			if (flights.get(id) === flight) flights.delete(id);
		});
	/* A run every caller walked away from still settles; nobody is left to see it. */
	flight.promise.catch(() => {});

	flights.set(id, flight);
	return flight;
}

function waitFor(flight: Flight, signal?: AbortSignal): Promise<any> {
	if (signal?.aborted) return Promise.reject(new Error('Query aborted by user before it started'));

	flight.waiters++;
	return new Promise((resolve, reject) => {
		let settled = false;
		const leave = () => {
			settled = true;
			flight.waiters--;
			signal?.removeEventListener('abort', onAbort);
		};
		const onAbort = () => {
			if (settled) return;
			leave();
			if (flight.waiters === 0) flight.controller.abort();
			reject(new Error('Query aborted by user'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });

		flight.promise.then(
			(result) => {
				if (settled) return;
				leave();
				resolve(result);
			},
			(error) => {
				if (settled) return;
				leave();
				reject(error);
			},
		);
	});
}

/** Re-runs a served entry behind the reader, at the limit it was stored under. */
function refresh(source: string, key: string, entry: Entry, input: any, run: RunQuery): void {
	const { limit: _limit, ...rest } = input;
	const refreshInput = entry.limit == null ? rest : { ...rest, limit: entry.limit };
	const flight = flightFor(source, key, entry.limit, refreshInput, run);
	/* A refresh never aborts, so the run is never cancelled under it. */
	flight.waiters++;
	flight.promise
		.catch((err: any) => console.warn(`[query-cache] refresh failed for ${source}: ${err?.message ?? err}`))
		.finally(() => flight.waiters--);
}

/* ----------------------------------- entry ---------------------------------- */

/**
 * Runs one statement through the cache.
 *
 * @param source The source tool id — the namespace of the entry.
 * @param input  What the source's `execute` takes: `sql`, `params`, `limit`, `offset`.
 * @param run    Runs the statement against the source.
 * @param cap    The row limit `run` applies when the input has none; `null` when it applies none.
 */
export async function cachedQuery(
	source: string,
	input: any,
	signal: AbortSignal | undefined,
	run: RunQuery,
	cap: number | null,
): Promise<any> {
	if (!input || typeof input.sql !== 'string' || !isReadOnlySql(input.sql)) return run(input, signal);

	const key = keyFor(input);
	const limit = typeof input.limit === 'number' ? input.limit : cap;

	if (!freshReads.getStore()) {
		const entry = read(source, key);
		if (entry && covers(entry, limit)) {
			const age = Date.now() - entry.storedAt;
			console.log(`[query-cache] hit ${source} (${Math.round(age / 60000)} min old)`);
			if (age > REFRESH_AFTER_MS) refresh(source, key, entry, input, run);
			return served(entry.result, limit, entry.storedAt);
		}
	}

	const result = await waitFor(flightFor(source, key, limit, input, run), signal);
	return isStorable(result) ? served(result, limit) : result;
}
