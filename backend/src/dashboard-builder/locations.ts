/**
 * Where a dashboard program lives on disk.
 *
 * The folder used to *be* the identity — `dashboard-programs/<slug>`, with the
 * slug picked by the agent. That made a rename impossible (it would orphan
 * the conversation, the layout and the spec) and let two projects collide on
 * the same obvious name.
 *
 * Now identity comes from the `dashboards` table, keyed by the SA-API uuid the
 * platform already mints for every dashboard, and the row's `dashboard` jsonb
 * says where the files are:
 *
 *     { "kind": "program", "dir": "dashboard-programs/<uuid>" }
 *
 * `kind` is what separates these from the JSON-DSL dashboards sharing the
 * table. Their rows hold a DSL document in the same column; ours hold a
 * pointer. Nothing else about the two flows overlaps.
 *
 * **Cached, and deliberately synchronous to read.** `dashboardDir()` is called
 * from layout reads, compile paths and the resolver runtime — making it async
 * would turn a location lookup into an await in a dozen unrelated places. The
 * cache is refreshed on `invalidate()`, which already runs whenever a dashboard
 * changes.
 */
import * as path from 'path';
import { queryDashboards } from '../../../database/postgres/src/project-data-db/dashboards';

/** What a program dashboard's row carries in its `dashboard` column. */
export interface ProgramLocation {
	kind: 'program';
	/** Relative to the backend's working directory. */
	dir: string;
}

export const isProgramLocation = (value: unknown): value is ProgramLocation =>
	typeof value === 'object' &&
	value !== null &&
	(value as { kind?: unknown }).kind === 'program' &&
	typeof (value as { dir?: unknown }).dir === 'string';

/** Root for dashboard folders. Overridable so a test can point elsewhere. */
export function programsDir(): string {
	return process.env.DASH_PROGRAMS_DIR || path.join(process.cwd(), 'dashboard-programs');
}

/** The directory a newly created dashboard should use. */
export const defaultDirFor = (dashboardId: string): string =>
	path.posix.join('dashboard-programs', dashboardId);

interface Entry {
	dashboardId: string;
	dir: string;
	name?: string;
	description?: string;
	projectId?: string;
	/**
	 * From the row, not from the filesystem.
	 *
	 * The list used to report `updatedAt: new Date()` for every dashboard, so a
	 * card said "Updated today" forever regardless of when anything changed, and
	 * there was no created date at all. A timestamp that is always now is worse
	 * than none — it reads as information.
	 */
	createdAt?: string;
	updatedAt?: string;
}

let cache: Map<string, Entry> | null = null;

/** Drizzle hands back a Date for a timestamp column, a string for text. Either is fine. */
const iso = (value: unknown): string | undefined => {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
	if (typeof value === 'string' && value.trim()) return value;
	return undefined;
};

/**
 * Loads every program dashboard's row.
 *
 * Failure is not fatal. A backend with no database still serves whatever is on
 * disk — the folder-name fallback below — which is what keeps the runtime
 * smoke tests and a bare dev setup working without one.
 */
export async function refreshLocations(): Promise<Map<string, Entry>> {
	const next = new Map<string, Entry>();
	try {
		const rows = (await queryDashboards({ limit: 500 })).data ?? [];
		for (const row of rows as any[]) {
			if (!isProgramLocation(row?.dashboard)) continue;
			next.set(row.dashboardId, {
				dashboardId: row.dashboardId,
				dir: row.dashboard.dir,
				name: row.name ?? undefined,
				description: row.description ?? undefined,
				projectId: row.projectId ?? undefined,
				createdAt: iso(row.createdAt),
				updatedAt: iso(row.updatedAt),
			});
		}
	} catch (err: any) {
		console.warn(`[dash-builder] could not read dashboard locations: ${err?.message ?? err}`);
	}
	cache = next;
	return next;
}

/**
 * Loads the cache if it is not loaded, and returns it.
 *
 * Called at the top of the async entry points — `listDashboards`,
 * `getDashboard` — so that by the time anything reaches the synchronous
 * `resolveDir`, the answer is already in memory. That is the whole reason the
 * cache exists: a directory lookup is needed in a dozen synchronous places, and
 * making all of them async to reach a database would be a much larger change
 * than the problem deserves.
 */
export async function ensureLocations(): Promise<Map<string, Entry>> {
	if (cache) return cache;
	inFlight ??= refreshLocations().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

/** Deduplicates concurrent loads — several panels can ask at once on first paint. */
let inFlight: Promise<Map<string, Entry>> | null = null;

/** Drops the cache so the next `ensureLocations` re-queries. */
export function invalidateLocations(): void {
	cache = null;
}

/** Registered program dashboards, or null if the cache has not been loaded yet. */
export const cachedLocations = (): Map<string, Entry> | null => cache;

/**
 * The absolute directory for a dashboard.
 *
 * Falls back to `<programsDir>/<id>` when there is no row — which is what the
 * dashboards created before this existed still rely on, and what a database-less
 * dev setup uses for everything. A folder that happens to be named after its id
 * is still perfectly findable; the table simply removes the requirement.
 */
export function resolveDir(dashboardId: string): string {
	const entry = cache?.get(dashboardId);
	if (!entry) return path.join(programsDir(), dashboardId);
	return path.isAbsolute(entry.dir) ? entry.dir : path.join(process.cwd(), entry.dir);
}

/** Row metadata for a dashboard, when it has a row. */
export const locationEntry = (dashboardId: string): Entry | undefined =>
	cache?.get(dashboardId) ?? undefined;
