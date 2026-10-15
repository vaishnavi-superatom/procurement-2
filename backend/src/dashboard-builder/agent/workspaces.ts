/**
 * Live agent workspaces, and what has actually been verified in each.
 *
 * Replaces `build-runs.ts`, which recorded the same two things for a build that
 * had a beginning and an end. A conversation has neither, so the record is keyed
 * by the workspace directory and lasts as long as the session.
 *
 * It does two jobs, and both are the kind that must not be delegated to the
 * agent:
 *
 * **It is the authority on grants.** `./run-resolver` and `./query` read the
 * source list from here, never from `manifest.ts` — a file the agent can edit.
 * The bridge refuses any directory that is not registered, so the reach of those
 * endpoints is exactly the set of open sessions and nothing else on the disk.
 *
 * **It records what ran.** A resolver is marked verified as a side effect of
 * actually executing and returning rows, so "I ran it" and "it ran" cannot come
 * apart. `publish` reads this and refuses anything unproven — which is the
 * deliverable contract from the old builder, moved rather than dropped: *a
 * dashboard is never the first place a query runs.*
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export interface WorkspaceRecord {
	dashboardId: string;
	programDir: string;
	/** The caller's decision, baked in when the session opened. */
	grants: readonly string[];
	/**
	 * Direct-tool ids `ctx.run` may reach, likewise the caller's decision.
	 *
	 * Kept beside `grants` rather than folded into it because they answer
	 * different questions — a source is data this dashboard may read, a tool is
	 * logic it may invoke, and a tool picks its own source when it runs.
	 */
	toolGrants?: readonly string[];
	/**
	 * Resolver name → what running it proved, and which source it proved it about.
	 *
	 * Columns rather than a boolean because they are knowledge the agent cannot
	 * invent: it has to have run the thing to know them.
	 *
	 * The hash is what stops the obvious way around the gate. Running a resolver
	 * and then editing it leaves a record that says "verified" about code nobody
	 * executed — an easy and entirely natural sequence for an agent fixing a
	 * column name after a successful run. Publish recomputes the hash and treats
	 * a mismatch as unverified, so the evidence is about *this* file rather than
	 * about a file that once had the same name.
	 */
	verified: Map<string, { columns: readonly string[]; hash: string }>;
}

/** Keyed by the normalised program directory — what the shims pass back. */
const open = new Map<string, WorkspaceRecord>();

const key = (dir: string) => path.resolve(dir).replace(/[\\/]+$/, '').toLowerCase();

/** Beside a published program: each resolver's hash and returned columns as of that publish. */
export const VERIFIED_FILE = '.verified.json';

/**
 * What the last publish proved, read from the published program.
 *
 * Every entry passed the run-before-publish gate when it was written. `isVerified`
 * still compares hashes, so an entry only counts while the workspace file is unchanged.
 */
function publishedVerification(publishedDir: string | undefined): WorkspaceRecord['verified'] {
	const verified: WorkspaceRecord['verified'] = new Map();
	if (!publishedDir) return verified;
	try {
		const saved = JSON.parse(fs.readFileSync(path.join(publishedDir, VERIFIED_FILE), 'utf-8')) as Record<
			string,
			{ hash?: unknown; columns?: unknown }
		>;
		for (const [name, entry] of Object.entries(saved)) {
			if (typeof entry?.hash === 'string' && Array.isArray(entry.columns)) {
				verified.set(name, { hash: entry.hash, columns: entry.columns.map(String) });
			}
		}
	} catch {
		/* Never published through the gate, or published before this record existed. */
	}
	return verified;
}

export function registerWorkspace(
	record: Omit<WorkspaceRecord, 'verified'>,
	publishedDir?: string,
): WorkspaceRecord {
	const existing = open.get(key(record.programDir));
	if (existing) {
		/* Re-opening keeps what was already verified: the session is the same conversation. */
		return existing;
	}
	const created: WorkspaceRecord = { ...record, verified: publishedVerification(publishedDir) };
	open.set(key(record.programDir), created);
	return created;
}

export function getWorkspace(dir: string | undefined): WorkspaceRecord | undefined {
	if (!dir) return undefined;
	return open.get(key(dir));
}

/**
 * The open session for a dashboard, by id rather than by directory.
 *
 * Keyed by directory everywhere else, because that is what a shim can prove it
 * is calling from. This one is for the endpoints that only know the dashboard —
 * `./inventory` in particular, which has to tell the agent what it can reach.
 */
export function findSessionFor(dashboardId: string): WorkspaceRecord | undefined {
	for (const record of open.values()) {
		if (record.dashboardId === dashboardId) return record;
	}
	return undefined;
}

export function closeWorkspace(dir: string): void {
	open.delete(key(dir));
}

/** Content hash of a resolver file, or `''` when it is not there. */
export function resolverHash(programDir: string, name: string): string {
	const file = path.join(programDir, 'data', `${name}.ts`);
	try {
		return createHash('sha1').update(fs.readFileSync(file)).digest('hex');
	} catch {
		return '';
	}
}

/**
 * Records a successful run. Called by the bridge, never by the agent.
 *
 * The hash is taken at the moment of the run, from the file that was run.
 */
export function recordVerified(dir: string, name: string, columns: readonly string[]): void {
	const record = open.get(key(dir));
	if (!record) return;
	record.verified.set(name, { columns, hash: resolverHash(record.programDir, name) });
}

/**
 * Has this resolver, as it stands on disk right now, been run in this session?
 *
 * The hash comparison is the whole point — see the note on `verified`.
 */
export function isVerified(record: WorkspaceRecord, name: string): boolean {
	const seen = record.verified.get(name);
	if (!seen) return false;
	return seen.hash !== '' && seen.hash === resolverHash(record.programDir, name);
}
