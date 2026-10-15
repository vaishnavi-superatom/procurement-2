import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * How far a forward-reading agent has got, and — the point of this file — WHO
 * owns which file in its workspace.
 *
 * A persistent workspace has two writers: the runner, which sets up each run,
 * and the agent, which records what it learned. They shared `memory/` once, and
 * `prepare()` rewrote `memory/processed.json` wholesale every run — the exact
 * file system.md tells the agent to keep its findings in. The agent's "never
 * re-investigate the same question twice" memory was wiped on a cadence, and
 * silently, since the file still existed afterwards.
 *
 * The rule, stated once here and repeated to the agent in system.md:
 *
 *   memory/    the agent's. The runner never writes it.
 *   _*.json    the runner's, at the workspace root, next to the runner's own
 *              _state.json and _triggers.json. The agent is told not to.
 *   input/     the runner's, rebuilt every run.
 *
 * WHEN the position moves matters as much as where it lives. It used to move in
 * prepare(), before the agent had read a line, so a timeout, a missing
 * deliverable or a schema failure burned the batch permanently. It now moves in
 * apply(), which runs only after a validated deliverable — and it moves to the
 * work the agent actually reported, not to the rows it was handed.
 *
 * Directory-based rather than Workspace-based so both sides can reach it:
 * prepare() has a Workspace, apply() has only ctx.workspaceDir.
 */

export const WATERMARK_FILE = '_watermark.json';
export const BATCH_FILE = '_batch.json';
export const SKIPPED_FILE = '_skipped.json';

/**
 * Retries of one batch before it is stepped over.
 *
 * Retrying forever is not the safe option it looks like: a batch that can never
 * be completed would stall the whole pipeline silently, which is the bug this
 * file exists to fix wearing a different hat. Three attempts, then step over it
 * LOUDLY — the ids go to SKIPPED_FILE and into the run summary.
 */
export const MAX_BATCH_ATTEMPTS = 3;

export interface Watermark {
	/** Highest id already accounted for. The next batch starts after it. */
	lastConversationId: number;
	at?: string;
	migratedFrom?: string;
}

/** The batch handed to the current run, so apply() knows what it is answering for. */
export interface Batch {
	/** The watermark this batch was read from. Identifies a retry of the same batch. */
	since: number;
	/** Ids handed over, ascending. */
	ids: number[];
	/** 1 on the first go. Incremented while `since` stays put. */
	attempt: number;
	at?: string;
}

// ── plumbing ─────────────────────────────────────────────────────────────────

async function readJson<T>(dir: string, file: string): Promise<T | null> {
	try {
		const parsed = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf-8'));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
	} catch {
		return null;
	}
}

async function writeJson(dir: string, file: string, value: unknown): Promise<void> {
	const target = path.join(dir, file);
	// dirname, not dir — `file` may be nested (memory/processed.json).
	await fsp.mkdir(path.dirname(target), { recursive: true });
	await fsp.writeFile(target, JSON.stringify(value, null, 2), 'utf-8');
}

// ── watermark ────────────────────────────────────────────────────────────────

/** 0 when there is none or it is unreadable — which correctly means "start at the beginning". */
export async function readWatermark(dir: string): Promise<number> {
	const wm = await readJson<Watermark>(dir, WATERMARK_FILE);
	const n = Number(wm?.lastConversationId);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function writeWatermark(dir: string, lastConversationId: number): Promise<void> {
	await writeJson(dir, WATERMARK_FILE, { lastConversationId, at: new Date().toISOString() });
}

// ── the batch in flight ──────────────────────────────────────────────────────

export async function readBatch(dir: string): Promise<Batch | null> {
	const b = await readJson<Batch>(dir, BATCH_FILE);
	return b && Array.isArray(b.ids) && Number.isFinite(b.since) ? b : null;
}

/**
 * Record what this run was given. `attempt` counts consecutive runs served from
 * the SAME watermark: a batch that keeps failing is the same batch, whether it
 * failed by timing out or by coming back half-done.
 */
export async function writeBatch(dir: string, since: number, ids: number[]): Promise<Batch> {
	const prev = await readBatch(dir);
	const batch: Batch = {
		since,
		ids,
		attempt: prev && prev.since === since ? prev.attempt + 1 : 1,
		at: new Date().toISOString(),
	};
	await writeJson(dir, BATCH_FILE, batch);
	return batch;
}

// ── the decision ─────────────────────────────────────────────────────────────

export interface Advance {
	/** Where the watermark should now be. Never below `batch.since`. */
	to: number;
	/** Ids in the batch the agent did not report on. */
	uncovered: number[];
	/** True when we stepped over uncovered ids because the batch ran out of attempts. */
	forced: boolean;
}

/**
 * Where the watermark goes, given what the agent actually reported.
 *
 * Pure, so the policy can be tested without a workspace or a database.
 *
 * CONTIGUOUS, not highest: covering 1, 2, 4, 5 advances to 2, so 3 is re-fed
 * rather than stepped over. Re-reading a conversation is cheap and visible;
 * losing one is neither.
 */
export function nextWatermark(
	batch: Batch,
	coveredIds: Array<number | undefined>,
	maxAttempts = MAX_BATCH_ATTEMPTS
): Advance {
	const covered = new Set(coveredIds.filter((n): n is number => Number.isFinite(n)));
	const ids = [...batch.ids].filter(Number.isFinite).sort((a, b) => a - b);

	let to = batch.since;
	for (const id of ids) {
		if (!covered.has(id)) break;
		to = id;
	}

	const uncovered = ids.filter(id => !covered.has(id));
	if (uncovered.length && batch.attempt >= maxAttempts) {
		return { to: ids[ids.length - 1], uncovered, forced: true };
	}
	return { to, uncovered, forced: false };
}

/**
 * Apply that decision. Returns the advance so the caller can report it.
 *
 * Force-skipped ids are appended to SKIPPED_FILE before the watermark moves:
 * the whole point of the escape hatch is that it leaves a record, so it must
 * not be the thing that gets lost if the next write fails.
 */
export async function advanceWatermark(
	dir: string,
	coveredIds: Array<number | undefined>,
	maxAttempts = MAX_BATCH_ATTEMPTS
): Promise<(Advance & { batch: Batch }) | null> {
	const batch = await readBatch(dir);
	if (!batch) return null;

	const advance = nextWatermark(batch, coveredIds, maxAttempts);

	if (advance.forced) {
		const log = (await readJson<{ entries?: unknown[] }>(dir, SKIPPED_FILE))?.entries ?? [];
		await writeJson(dir, SKIPPED_FILE, {
			entries: [...log, { ids: advance.uncovered, afterAttempts: batch.attempt, at: new Date().toISOString() }],
		});
	}

	if (advance.to > batch.since) await writeWatermark(dir, advance.to);
	return { ...advance, batch };
}

// ── migration ────────────────────────────────────────────────────────────────

/**
 * One-time move of the watermark out of a file the agent also writes.
 *
 * The legacy file is a MERGE of both writers, so it can be neither renamed nor
 * deleted: our keys move out, everything the agent put there stays exactly as
 * it was.
 *
 * Every failure path leaves BOTH files untouched. That matters more than the
 * migration succeeding: a half-migration that loses the watermark restarts the
 * pass from zero and re-validates the entire history.
 */
export async function migrateWatermarkOutOf(
	dir: string,
	legacyFile: string
): Promise<{ migrated: boolean; from?: number }> {
	// Checked before the legacy file is read, so a watermark key the agent later
	// writes into its own log is ignored rather than becoming a second source of
	// truth.
	if ((await readJson(dir, WATERMARK_FILE)) !== null) return { migrated: false };

	const parsed = await readJson<Record<string, unknown>>(dir, legacyFile);
	if (!parsed) return { migrated: false };

	const { lastConversationId, batchSize, at, ...agentsOwn } = parsed;
	const last = Number(lastConversationId);
	if (!Number.isFinite(last) || last <= 0) return { migrated: false };
	void batchSize; void at;

	// Watermark first: if the second write fails, the worst case is a duplicated
	// key, not a lost position.
	await writeJson(dir, WATERMARK_FILE, { lastConversationId: last, at, migratedFrom: legacyFile });
	await writeJson(dir, legacyFile, agentsOwn);
	return { migrated: true, from: last };
}
