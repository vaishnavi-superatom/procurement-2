/**
 * The one SQLite file every cache in this backend writes to.
 *
 * Two stores share it:
 *  - `sources/core/query-cache.ts` — the result of each SQL statement, kept in
 *    front of every source.
 *  - `dashboard-builder/cache-store.ts` — a dashboard resolver's whole answer.
 *
 * Each store creates its own table through `ensureTable`.
 *
 * `node:sqlite` is built into the runtime and synchronous, so a read stays a
 * plain function call.
 *
 * A database that will not open disables caching with one warning; every caller
 * treats `null` as a miss.
 *
 * An entry nobody has read for `UNUSED_FOR_MS` is deleted; the next request for
 * it goes to the source and stores it again.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * How long a cached entry is served without a refresh.
 *
 * Past it the entry is still served, and a refresh runs behind it. Nothing
 * expires.
 */
export const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;

/** An entry not read for this long is deleted. */
export const UNUSED_FOR_MS = 30 * 24 * 60 * 60 * 1000;

/** How often unused entries are looked for. */
const CLEANUP_EVERY_MS = 60 * 60 * 1000;

/** Overridable so a test can point somewhere else, or use `:memory:`. */
const DB_PATH = process.env.SA_CACHE_DB || path.join(process.cwd(), '.sa-cache', 'cache.sqlite');

let db: DatabaseSync | null = null;
let opened = false;
const created = new Set<string>();

/** The open database, or `null` when it could not be opened. Opened once. */
export function cacheDb(): DatabaseSync | null {
	if (opened) return db;
	opened = true;
	try {
		if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
		const opening = new DatabaseSync(DB_PATH);
		/* WAL so a reader is never blocked by the writer; NORMAL because losing
		 * the last few writes on a hard kill costs a cache miss, not data. */
		opening.exec('PRAGMA journal_mode = WAL');
		opening.exec('PRAGMA synchronous = NORMAL');
		db = opening;
		deleteUnused();
		setInterval(deleteUnused, CLEANUP_EVERY_MS).unref();
	} catch (err: any) {
		console.warn(`[cache-db] disabled — could not open ${DB_PATH}: ${err?.message ?? err}`);
		db = null;
	}
	return db;
}

/**
 * Deletes every entry not read for `UNUSED_FOR_MS`, in every cache table.
 *
 * A cache table is any table with a `last_read_at` column, so a table created by
 * an earlier run is cleaned before this process first uses it.
 */
function deleteUnused(): void {
	if (!db) return;
	const cutoff = Date.now() - UNUSED_FOR_MS;
	try {
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
		for (const { name } of tables) {
			const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
			if (!columns.some((c) => c.name === 'last_read_at')) continue;

			const { changes } = db.prepare(`DELETE FROM "${name}" WHERE last_read_at < ?`).run(cutoff);
			if (Number(changes) > 0) {
				console.log(`[cache-db] deleted ${changes} ${name} entr${Number(changes) === 1 ? 'y' : 'ies'} unused for 30 days`);
			}
		}
	} catch (err: any) {
		console.warn(`[cache-db] cleanup failed: ${err?.message ?? err}`);
	}
}

/**
 * The database with `name`'s schema applied, or `null`.
 *
 * `ddl` runs once per table per process, on first use.
 */
export function ensureTable(name: string, ddl: string): DatabaseSync | null {
	const handle = cacheDb();
	if (!handle || created.has(name)) return handle;
	try {
		handle.exec(ddl);
		created.add(name);
		return handle;
	} catch (err: any) {
		console.warn(`[cache-db] could not create table ${name}: ${err?.message ?? err}`);
		return null;
	}
}
