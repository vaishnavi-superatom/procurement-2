/**
 * The agent's workspace — one per dashboard, and it lasts.
 *
 * The old builder took a fresh directory per run, which was deliberate: an
 * ephemeral agent could not carry stale beliefs between builds. It also meant
 * nothing was remembered, so every change regenerated every panel — asking for
 * a dropdown rebuilt five panels in 140 seconds and touched four nobody had
 * mentioned.
 *
 * One durable workspace per dashboard is what makes a small change small. The
 * agent opens the same directory it used last time, with the files it wrote
 * still in it.
 *
 * ### Three rules keep that safe
 *
 * **The workspace mirrors the repository.** `dashboard-programs/<id>/` sits
 * under the workspace root with the contract at the same relative path it has
 * in the repo, so the import a resolver writes is the one that resolves after
 * publish. No rewriting on the way in, and therefore no way for the agent's code
 * and the deployed code to differ.
 *
 * **The published program is synced in when a session opens.** Otherwise the
 * working copy drifts from what readers see — someone deletes a dashboard from
 * the UI, or another session publishes, and the agent goes on editing a copy of
 * something that no longer exists.
 *
 * **`layout.json` never enters the workspace.** It is the reader's file. An
 * agent that cannot see it cannot destroy it, which is a stronger guarantee than
 * telling it not to.
 */
import * as fs from 'fs';
import * as path from 'path';
import { dashboardDir } from '../registry';
import { ensureLocations } from '../locations';

/** One directory per dashboard, keyed by its id, stable across restarts. */
export const WORKSPACE_ROOT = path.join(process.cwd(), '.dash-builder-runtime');

/** Where the contract lives in this repo — mirrored to the same path inside. */
export const CONTRACT_TYPES_REL = path.join('src', 'dashboard-builder', 'contract', 'types.ts');

/** The agent's program directory, workspace-relative. Mirrors the repo. */
export const programRel = (dashboardId: string) =>
	path.posix.join('dashboard-programs', dashboardId);

/**
 * The files that are the program: everything in the program directory.
 *
 * The published copy is the workspace copy, so whatever a view or resolver
 * imports — `lib/`, `panels/`, anything — is there after publish too. The only
 * files left out are the ones this program does not own: `layout.json` (the
 * reader's), and dot-files and dot-directories (`.build/`, `.verified.json`),
 * which the platform writes beside it.
 */
const isOwnSegment = (segment: string) => !segment.startsWith('.') && segment !== 'node_modules';

export const isProgramFile = (rel: string) =>
	rel !== 'layout.json' && rel.split('/').every(isOwnSegment);

export interface Workspace {
	/** `.dash-builder-runtime/<dashboardId>` — the agent's cwd. */
	root: string;
	/** Absolute path to `dashboard-programs/<dashboardId>` inside the workspace. */
	programDir: string;
	/** The same, workspace-relative, for anything the agent is told to type. */
	programRelPath: string;
}

function copyInto(from: string, to: string, keep: (rel: string) => boolean): string[] {
	const written: string[] = [];
	const walk = (dir: string, rel: string) => {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
			const src = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (isOwnSegment(entry.name)) walk(src, childRel);
				continue;
			}
			if (!keep(childRel)) continue;
			const dest = path.join(to, childRel);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(src, dest);
			written.push(childRel);
		}
	};
	walk(from, '');
	return written;
}

/**
 * Prepares the workspace and brings it level with what is published.
 *
 * Idempotent, and called every time a session opens rather than only when one is
 * created: a session can outlive several publishes, and a backend restart
 * rebuilds the session from disk without rebuilding what it believed.
 *
 * Files the agent wrote but never published are left alone. That is the point of
 * a durable workspace — an interrupted turn should be resumable — but it does
 * mean the working copy can be *ahead* of the dashboard, never behind it.
 */
export async function ensureWorkspace(dashboardId: string): Promise<Workspace> {
	const root = path.join(WORKSPACE_ROOT, dashboardId);
	const programDir = path.join(root, 'dashboard-programs', dashboardId);
	fs.mkdirSync(path.join(programDir, 'data'), { recursive: true });

	/* The contract, at the path a resolver's relative import resolves to both
	 * here and after publish. Read-only reference: publish copies only program
	 * files back, so an edit here reaches nothing. */
	const contractDest = path.join(root, CONTRACT_TYPES_REL);
	fs.mkdirSync(path.dirname(contractDest), { recursive: true });
	fs.copyFileSync(path.join(process.cwd(), CONTRACT_TYPES_REL), contractDest);

	/* Before any dashboardDir() call — it reads a cache a fresh process cannot
	 * assume is warm. */
	await ensureLocations();

	const published = dashboardDir(dashboardId);
	if (fs.existsSync(published)) {
		/* `layout.json` is not in the filter, so it cannot arrive here. */
		copyInto(published, programDir, isProgramFile);
	}

	return { root, programDir, programRelPath: programRel(dashboardId) };
}

/** Every program file currently in a program directory, relative to it. */
export function programFilesIn(programDir: string): string[] {
	const found: string[] = [];
	const walk = (dir: string, rel: string) => {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
			if (entry.isDirectory()) {
				if (isOwnSegment(entry.name)) walk(path.join(dir, entry.name), childRel);
				continue;
			}
			if (isProgramFile(childRel)) found.push(childRel);
		}
	};
	walk(programDir, '');
	return found.sort();
}
