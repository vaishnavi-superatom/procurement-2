/**
 * Watermark ownership, migration, and advance-policy probe.
 *
 *   npx tsx src/coding-agents/_test_watermark.ts [workspaceDir]
 *
 * With no argument it builds its own fixtures. Pass a real workspace (e.g.
 * .coding-agent-runtime/concept-builder/_project) to dry-run the migration
 * against it — it copies first and never touches the original.
 */
import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	BATCH_FILE, MAX_BATCH_ATTEMPTS, SKIPPED_FILE, WATERMARK_FILE,
	advanceWatermark, migrateWatermarkOutOf, nextWatermark, readBatch, readWatermark, writeBatch, writeWatermark,
	type Batch,
} from './watermark';

const AGENT_LOG = 'memory/processed.json';

let failures = 0;
const check = (label: string, ok: boolean, extra?: unknown) => {
	if (!ok) failures++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`);
};

async function tmp(legacy?: Record<string, unknown>): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wm-'));
	if (legacy) {
		await fsp.mkdir(path.join(dir, 'memory'), { recursive: true });
		await fsp.writeFile(path.join(dir, AGENT_LOG), JSON.stringify(legacy, null, 2));
	}
	return dir;
}
const readFile = async (dir: string, f: string) => {
	try { return await fsp.readFile(path.join(dir, f), 'utf-8'); } catch { return null; }
};
const batch = (since: number, ids: number[], attempt = 1): Batch => ({ since, ids, attempt });

async function main() {
	console.log('── #2  ownership ──────────────────────────────────────────────');
	{
		const dir = await tmp({ conversations: { '4': { status: 'verified-match' } } });
		await writeWatermark(dir, 9);
		check('a run leaves the agent log untouched', !!JSON.parse((await readFile(dir, AGENT_LOG))!).conversations?.['4']);
		check('watermark lands at the root, outside memory/', (await readFile(dir, WATERMARK_FILE)) !== null);
		check('watermark reads back', (await readWatermark(dir)) === 9);
	}

	console.log('\n── #2  migration off the merged legacy file ───────────────────');
	{
		const dir = await tmp({
			lastConversationId: 4, batchSize: 1, at: '2026-08-31T16:18:45.296Z',
			conversations: { '4': { status: 'verified-match', eligibleRows: 186 } },
		});
		const r = await migrateWatermarkOutOf(dir, AGENT_LOG);
		const log = JSON.parse((await readFile(dir, AGENT_LOG))!);
		check('migration reports what it moved', r.migrated && r.from === 4, r);
		check('position preserved — no replay from 0', (await readWatermark(dir)) === 4);
		check("agent's findings survive", log.conversations?.['4']?.eligibleRows === 186);
		check('runner keys stripped from the agent log', !('lastConversationId' in log) && !('batchSize' in log) && !('at' in log));
		check('second call is a no-op', (await migrateWatermarkOutOf(dir, AGENT_LOG)).migrated === false);
	}
	{
		const dir = await tmp();
		check('no legacy file: nothing to do', (await migrateWatermarkOutOf(dir, AGENT_LOG)).migrated === false);
		check('  and no watermark invented', (await readFile(dir, WATERMARK_FILE)) === null);
	}
	{
		const dir = await tmp();
		await fsp.mkdir(path.join(dir, 'memory'), { recursive: true });
		await fsp.writeFile(path.join(dir, AGENT_LOG), '{ this is not json');
		check('unparseable log: no migration', (await migrateWatermarkOutOf(dir, AGENT_LOG)).migrated === false);
		check('  log left byte-for-byte', (await readFile(dir, AGENT_LOG)) === '{ this is not json');
	}
	{
		const dir = await tmp({ conversations: { '4': {} } });
		check('log with no watermark key: no migration', (await migrateWatermarkOutOf(dir, AGENT_LOG)).migrated === false);
		check('  agent log preserved', JSON.parse((await readFile(dir, AGENT_LOG))!).conversations?.['4'] !== undefined);
	}
	{
		const dir = await tmp({ lastConversationId: 12 });
		await writeWatermark(dir, 40);
		await migrateWatermarkOutOf(dir, AGENT_LOG);
		check('existing watermark wins over a stale legacy value', (await readWatermark(dir)) === 40);
	}
	{
		const dir = await tmp();
		check('missing watermark = 0', (await readWatermark(dir)) === 0);
		await fsp.writeFile(path.join(dir, WATERMARK_FILE), 'garbage');
		check('corrupt watermark = 0, no throw', (await readWatermark(dir)) === 0);
		await fsp.writeFile(path.join(dir, WATERMARK_FILE), JSON.stringify({ lastConversationId: 'nope' }));
		check('non-numeric watermark = 0', (await readWatermark(dir)) === 0);
	}

	console.log('\n── #3  advance policy (pure) ──────────────────────────────────');
	check('all covered -> batch end',        nextWatermark(batch(4, [5, 6, 7]), [5, 6, 7]).to === 7);
	check('none covered -> no movement',     nextWatermark(batch(4, [5, 6, 7]), []).to === 4);
	check('  and they are reported uncovered', JSON.stringify(nextWatermark(batch(4, [5, 6, 7]), []).uncovered) === '[5,6,7]');
	check('partial prefix -> stops at 6',    nextWatermark(batch(4, [5, 6, 7]), [5, 6]).to === 6);
	check('gap -> contiguous, never steps over 6', nextWatermark(batch(4, [5, 6, 7]), [5, 7]).to === 5);
	check('  the gap is reported',           JSON.stringify(nextWatermark(batch(4, [5, 6, 7]), [5, 7]).uncovered) === '[6]');
	check('unordered validations still work', nextWatermark(batch(4, [5, 6, 7]), [7, 5, 6]).to === 7);
	check('ids the agent invented are ignored', nextWatermark(batch(4, [5, 6]), [5, 6, 999]).to === 6);
	check('junk conversationIds ignored',    nextWatermark(batch(4, [5, 6]), [5, undefined, NaN as any]).to === 5);
	check('empty batch -> stays put',        nextWatermark(batch(4, []), []).to === 4);
	check('not forced before the limit',     nextWatermark(batch(4, [5, 6]), [], MAX_BATCH_ATTEMPTS - 1).forced === false);
	check('forced AT the limit',             nextWatermark({ ...batch(4, [5, 6]), attempt: MAX_BATCH_ATTEMPTS }, []).forced === true);
	check('  and it steps to the batch end', nextWatermark({ ...batch(4, [5, 6]), attempt: MAX_BATCH_ATTEMPTS }, []).to === 6);
	check('a fully covered batch is never "forced"', nextWatermark({ ...batch(4, [5, 6]), attempt: 9 }, [5, 6]).forced === false);

	console.log('\n── #3  attempt counting + the failure loop ────────────────────');
	{
		const dir = await tmp();
		const b1 = await writeBatch(dir, 0, [1, 2, 3]);
		check('first attempt is 1', b1.attempt === 1);
		check('same watermark -> attempt 2', (await writeBatch(dir, 0, [1, 2, 3])).attempt === 2);
		await writeWatermark(dir, 3);
		check('moving on resets the counter', (await writeBatch(dir, 3, [4, 5])).attempt === 1);
	}
	{
		// The bug this issue is about: a run that dies before apply() must not
		// cost the batch. prepare() runs, apply() never does.
		const dir = await tmp();
		await writeBatch(dir, 0, [1, 2, 3]);
		check('a run that never reaches apply() moves nothing', (await readWatermark(dir)) === 0);
	}
	{
		// Three failures, then the loud escape hatch — a stall is not the safe option.
		const dir = await tmp();
		for (let i = 1; i <= MAX_BATCH_ATTEMPTS; i++) {
			await writeBatch(dir, 0, [1, 2, 3]);
			const adv = await advanceWatermark(dir, []);
			if (i < MAX_BATCH_ATTEMPTS) check(`  attempt ${i}: held at 0`, adv!.to === 0 && !adv!.forced);
			else {
				check(`  attempt ${i}: stepped over, loudly`, adv!.forced === true && adv!.to === 3);
				const skipped = JSON.parse((await readFile(dir, SKIPPED_FILE))!);
				check('  skipped ids recorded durably', JSON.stringify(skipped.entries?.[0]?.ids) === '[1,2,3]', skipped.entries?.[0]);
			}
		}
		check('watermark past the poison batch', (await readWatermark(dir)) === 3);
	}
	{
		// Partial coverage: the rest come back next run rather than being lost.
		const dir = await tmp();
		await writeBatch(dir, 0, [1, 2, 3, 4, 5]);
		const adv = await advanceWatermark(dir, [1, 2, 3]);
		check('partial run advances only as far as it got', adv!.to === 3 && (await readWatermark(dir)) === 3);
		const next = await writeBatch(dir, 3, [4, 5]);
		check('  the remainder is a NEW batch, attempt 1', next.attempt === 1);
	}
	{
		const dir = await tmp();
		check('no batch on disk -> nothing to advance', (await advanceWatermark(dir, [1])) === null);
		await fsp.writeFile(path.join(dir, BATCH_FILE), 'garbage');
		check('corrupt batch -> nothing to advance, no throw', (await advanceWatermark(dir, [1])) === null);
		check('  and the watermark is untouched', (await readWatermark(dir)) === 0);
	}
	{
		// A watermark must never go backwards, whatever the agent reports.
		const dir = await tmp();
		await writeWatermark(dir, 50);
		await writeBatch(dir, 50, [51, 52]);
		await advanceWatermark(dir, []);
		check('never moves backwards', (await readWatermark(dir)) === 50);
	}
	{
		const dir = await tmp();
		await writeBatch(dir, 4, []);
		const adv = await advanceWatermark(dir, []);
		check('empty batch is a clean no-op', adv!.to === 4 && !adv!.forced && (await readBatch(dir))!.ids.length === 0);
	}

	const real = process.argv[2];
	if (real && fs.existsSync(real)) {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wm-real-'));
		await fsp.cp(real, dir, { recursive: true });
		const before = await readFile(dir, AGENT_LOG);
		const r = await migrateWatermarkOutOf(dir, AGENT_LOG);
		console.log(`\n-- dry run on a copy of ${real}`);
		console.log(`   migrated=${r.migrated} from=${r.from}  watermark=${await readWatermark(dir)}`);
		console.log(`   ${AGENT_LOG} before: ${before?.replace(/\s+/g, ' ').slice(0, 96)}...`);
		console.log(`   ${AGENT_LOG} after:  ${(await readFile(dir, AGENT_LOG))?.replace(/\s+/g, ' ').slice(0, 96)}...`);
	}

	console.log(failures ? `\n${failures} FAILED` : '\nall passed');
	process.exit(failures ? 1 : 0);
}

void main();
