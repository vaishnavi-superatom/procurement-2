/**
 * The registry — what dashboards exist, and whether each one is fit to mount.
 *
 * Scans `dashboard-programs/`, loads each manifest, compiles the view, lists the
 * resolvers, and holds the three content hashes. Nothing here runs a query.
 *
 * The three hashes are separate on purpose: editing a resolver must not
 * re-import the view, and rearranging panels must not re-run a query. Version
 * each artifact by its own content and both follow without any invalidation
 * protocol.
 *
 * A dashboard that fails to compile is **reported, not hidden**. An absent
 * dashboard and a broken one are different problems and have to look different
 * — otherwise the only symptom of a bad generation is something quietly missing.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { evict as evictResolver } from './compile';
import { loadManifestFrom, validateProgramDir } from './validate';
import { BUILD_DIR } from './build-cache';
import { contractVersion } from './contract/registered';
import {
	cachedLocations,
	ensureLocations,
	invalidateLocations,
	locationEntry,
	programsDir,
	resolveDir,
} from './locations';
import type {
	DashboardManifest,
	DashboardSummary,
	DashboardLayout,
} from './contract/types';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export { programsDir };

/**
 * Where a dashboard's files are — from its row when it has one, otherwise from
 * its folder name. See `locations.ts` for why identity moved off the folder.
 */
export const dashboardDir = (id: string) => resolveDir(id);

/**
 * Every dashboard, registered or not.
 *
 * The union of what the table knows and what is on disk, because both are real
 * and neither is authoritative alone. A folder with no row predates the table,
 * or had its row deleted — either way its code still works, and hiding it would
 * make it look destroyed rather than unregistered.
 */
export function listDashboardIds(): string[] {
	const ids = new Set<string>();

	for (const id of cachedLocations()?.keys() ?? []) ids.add(id);

	const root = programsDir();
	if (fs.existsSync(root)) {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
			/* A folder is a dashboard when it holds a manifest, not because of where
			 * it sits. The semantic layer's models and vendored library live beside
			 * the programs so their imports are short, and without this they would
			 * be listed as a dashboard called "semantic". */
			if (!fs.existsSync(path.join(root, entry.name, 'manifest.ts'))) continue;
			ids.add(entry.name);
		}
	}

	return [...ids].sort();
}

/* -------------------------------- manifest --------------------------------- */

export async function loadManifest(id: string): Promise<DashboardManifest> {
	try {
		return await loadManifestFrom(dashboardDir(id));
	} catch (err: any) {
		/* The dir-based loader has no id to name; callers here expect one. */
		throw new Error(`Dashboard "${id}": ${err?.message ?? err}`);
	}
}

/* --------------------------------- layout ---------------------------------- */

const layoutFile = (id: string) => path.join(dashboardDir(id), 'layout.json');

/**
 * The reader's arrangement. Absent is normal and means "nobody has rearranged
 * anything" — every panel then falls back to the size its code declares.
 */
export function loadLayout(id: string): DashboardLayout | null {
	const file = layoutFile(id);
	if (!fs.existsSync(file)) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as DashboardLayout;
		return Array.isArray(parsed?.panels) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Saves the reader's arrangement.
 *
 * Validated rather than trusted, but note what is *not* checked: there is no
 * position, so there is no overlap to detect. Spans fit in twelve columns,
 * heights are positive, and no panel appears twice — that is the whole surface.
 */
export function saveLayout(id: string, input: unknown): DashboardLayout {
	const body = input as { panels?: unknown };
	if (!Array.isArray(body?.panels)) throw new Error('Layout must have a "panels" array.');

	const seen = new Set<string>();
	const panels = body.panels.map((raw: any) => {
		if (!raw || typeof raw.i !== 'string' || !raw.i) throw new Error('Each panel entry needs an "i".');
		if (seen.has(raw.i)) throw new Error(`Duplicate entry for panel "${raw.i}".`);
		seen.add(raw.i);
		const whole = (v: unknown, label: string, max: number) => {
			if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
				throw new Error(`"${label}" must be a whole number between 1 and ${max}.`);
			}
			return v;
		};
		return {
			i: raw.i,
			span: whole(raw.span, 'span', 12),
			h: whole(raw.h, 'h', 100),
			...(raw.hidden ? { hidden: true as const } : {}),
		};
	});

	const layout: DashboardLayout = { version: 1, panels, updatedAt: new Date().toISOString() };
	fs.writeFileSync(layoutFile(id), JSON.stringify(layout, null, 2) + '\n');
	return layout;
}

/* -------------------------------- summaries -------------------------------- */

export interface DashboardState extends DashboardSummary {
	dir: string;
	manifest: DashboardManifest;
	/** Compiled view, when it compiles. Absent means `valid` is false. */
	view?: { code: string; version: string; bytes: number };
	layout: DashboardLayout | null;
}

/** Cached by the hash of everything that feeds a summary. */
const states = new Map<string, DashboardState>();

/**
 * Builds already running, so concurrent callers share one.
 *
 * A cold `getDashboard` costs a TypeScript program — seconds, not milliseconds
 * — and a page load fires several at once. Without this each one paid it
 * separately: three concurrent requests, three identical compiles. Same idea as
 * `single()` in `cache-store.ts`.
 */
const inFlight = new Map<string, Promise<DashboardState>>();

/**
 * Hash of every source file, so any edit invalidates the whole summary.
 *
 * The contract is in it too, and has to be. A cached state carries a compiled
 * view and a verdict on whether it typechecks, and both are answers about the
 * contract the browser is running — not just about these files. Without it, a
 * rebuilt frontend leaves every dashboard holding a verdict about a contract
 * that no longer exists, and there is nothing a reader can do about it: the
 * files have not changed, so the fingerprint never moves and the state is
 * served until someone restarts the process.
 */
function fingerprint(dir: string): string {
	const parts: string[] = [contractVersion()];
	const walk = (d: string) => {
		if (!fs.existsSync(d)) return;
		for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			/* The build output is downstream of these files, so counting it would
			 * change the fingerprint every time a build is written — and the next
			 * read would rebuild, forever. */
			if (entry.name === BUILD_DIR) continue;
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(ts|tsx|json)$/.test(entry.name)) {
				parts.push(entry.name, String(fs.statSync(full).mtimeMs));
			}
		}
	};
	walk(dir);
	return sha(parts.join('|'));
}

export interface GetDashboardOptions {
	fresh?: boolean;
	/**
	 * Skip the TypeScript pass. For callers that need metadata, not a verdict.
	 *
	 * The typecheck is what catches a wrong prop before a reader sees a page of
	 * broken panels, and it costs a `ts.Program` over React and the whole
	 * contract — seconds on a cold call. That is worth paying where it decides
	 * something: serving the compiled module, and publishing. It is not worth
	 * paying to draw a list of names, which is what `list` and `get` do.
	 *
	 * A state built this way is cached separately, so a later caller that does
	 * want the verdict is never handed one that skipped it.
	 */
	skipTypecheck?: boolean;
}

export async function getDashboard(
	id: string,
	opts: GetDashboardOptions = {},
): Promise<DashboardState> {
	/* Loaded before the synchronous dashboardDir() below needs it. */
	await ensureLocations();
	const dir = dashboardDir(id);
	/**
	 * The row, when there is one. Its name wins over the manifest's title:
	 * renaming updates the row, while the manifest is only regenerated on the
	 * next build and would otherwise keep showing the old name until then.
	 */
	const row = locationEntry(id);

	/**
	 * No program here yet.
	 *
	 * A real state, not an error. The folder appears on the first publish, so
	 * between naming a dashboard and building it there is one you can open and
	 * talk to with no code in it.
	 *
	 * It no longer requires a row either. SA-API is the registry now, and a
	 * dashboard exists there the moment it is created — the backend is not told,
	 * and has no way to distinguish "an id nobody has built" from "an id that is
	 * not a dashboard". Answering "I have no program for this" is the honest
	 * reply to both, and throwing made every newly created dashboard fail to
	 * open.
	 */
	if (!fs.existsSync(dir)) {
		return {
			id,
			dir,
			manifest: { id, title: row.name ?? id, grants: { sources: [] } },
			title: row.name ?? id,
			description: row.description,
			grants: { sources: [] },
			valid: false,
			empty: true,
			violations: [],
			viewVersion: '',
			layoutVersion: '',
			resolvers: [],
			layout: null,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	const print = fingerprint(dir);
	const cached = states.get(id);

	/* A cached state that skipped the typecheck does not satisfy a caller that
	 * wants one — otherwise the verdict would depend on who asked first. */
	const usable =
		cached &&
		cached.layoutVersion !== undefined &&
		(cached as any).__print === print &&
		(opts.skipTypecheck || (cached as any).__typechecked);

	if (!opts.fresh && usable) return cached!;

	/* Keyed so a metadata request and a verdict request do not share a build. */
	const key = `${id}:${opts.skipTypecheck ? 'meta' : 'full'}`;
	const running = inFlight.get(key);
	if (running && !opts.fresh) return running;

	const build = (async (): Promise<DashboardState> => {
		/**
		 * The same check the builder agent runs against its own workspace — see
		 * `validate.ts`. Shared rather than reimplemented, because the failure worth
		 * fearing is the one where the agent's check passes and this one does not.
		 */
		const { manifest, valid, violations, view, resolvers } = await validateProgramDir(dir, {
			skipTypecheck: opts.skipTypecheck,
		});
		const layout = loadLayout(id);

		const state: DashboardState = {
			id,
			dir,
			manifest,
			title: row?.name || manifest.title,
			description: row?.description ?? manifest.description,
			grants: manifest.grants,
			valid,
			violations,
			viewVersion: view?.version ?? '',
			layoutVersion: layout ? sha(JSON.stringify(layout.panels)) : '',
			resolvers,
			view,
			layout,
			createdAt: row?.createdAt,
			updatedAt: row?.updatedAt,
		};

		(state as any).__print = print;
		(state as any).__typechecked = !opts.skipTypecheck;

		/**
		 * A typechecked state supersedes a metadata-only one — but only while it is
		 * still current. Comparing the fingerprint too is what stops a stale verdict
		 * outranking a fresh read of files that have since changed.
		 */
		const held = states.get(id) as (DashboardState & { __print?: string; __typechecked?: boolean }) | undefined;
		const heldIsBetter = opts.skipTypecheck && held?.__typechecked && held.__print === print;
		if (!heldIsBetter) states.set(id, state);

		return state;
	})().finally(() => inFlight.delete(key));

	inFlight.set(key, build);
	return build;
}

/** Catalogue view: no compiled code, so this stays cheap to call. */
export async function listDashboards(): Promise<DashboardSummary[]> {
	await ensureLocations();
	const out: DashboardSummary[] = [];
	for (const id of listDashboardIds()) {
		try {
			/* Names and dates. A type error is not something this page renders. */
			const { dir: _d, manifest: _m, view: _v, layout: _l, ...summary } = await getDashboard(id, {
				skipTypecheck: true,
			});
			out.push(summary);
		} catch (err: any) {
			out.push({
				id,
				title: id,
				grants: { sources: [] },
				valid: false,
				violations: [{ file: 'manifest.ts', line: 0, rule: 'load', detail: err?.message ?? String(err) }],
				viewVersion: '',
				layoutVersion: '',
				resolvers: [],
				updatedAt: new Date().toISOString(),
			});
		}
	}
	return out;
}

/** Drops caches for one dashboard, or all. Called on file change. */
export function invalidate(id?: string): void {
	/* Locations too: a rename, a create or a delete changes where files are or
	 * what a dashboard is called, and both come from the same row. */
	invalidateLocations();
	if (id) {
		states.delete(id);
		evictResolver();
		return;
	}
	states.clear();
	evictResolver();
}
