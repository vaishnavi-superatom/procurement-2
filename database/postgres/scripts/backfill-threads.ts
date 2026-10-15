/**
 * One-off backfill: populate the new `threads` table from existing
 * `user_conversations` rows (grouped by threadid), reusing each thread's
 * existing threadid string as `threads.id` verbatim — no new ids are minted
 * for historical data, no mapping table needed.
 *
 * Run once, after the `threads` table migration has been applied, and before
 * cutting the getUserThreads read path over to it.
 *
 * Usage (run from database/postgres folder):
 *   tsx scripts/backfill-threads.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { db } from '../src/project-data-db/drizzle-db';
import { sql } from 'drizzle-orm';

async function backfillThreads() {
	console.log('🔎 Step 1/3: pre-backfill collision check...\n');

	// The old thread-id scheme (pre-nanoid) was only guaranteed unique WITHIN
	// a user, but `threads.id` is a global primary key — check for any
	// threadid reused across different users before inserting.
	const collisions = await db.execute(sql`
		SELECT threadid, COUNT(DISTINCT user_id) AS user_count
		FROM user_conversations
		WHERE threadid IS NOT NULL
		GROUP BY threadid
		HAVING COUNT(DISTINCT user_id) > 1
	`);
	const collisionRows = (collisions as any).rows ?? collisions;

	if (collisionRows.length > 0) {
		console.error(`❌ Found ${collisionRows.length} threadid(s) shared across multiple users — resolve manually before backfilling:`);
		console.error(collisionRows);
		process.exit(1);
	}
	console.log('✓ No cross-user threadid collisions found.\n');

	console.log('📥 Step 2/3: backfilling threads table...\n');
	const result = await db.execute(sql`
		INSERT INTO threads (id, user_id, title, created_at, updated_at, archived)
		SELECT threadid, user_id, (array_agg(userprompt ORDER BY created_at ASC))[1],
		       MIN(created_at), MAX(created_at), false
		FROM user_conversations
		WHERE threadid IS NOT NULL
		GROUP BY threadid, user_id
		ON CONFLICT (id) DO NOTHING
	`);
	console.log(`✓ Backfill insert complete (rowCount reported: ${(result as any).rowCount ?? 'n/a'}).\n`);

	console.log('🧮 Step 3/3: verifying counts...\n');
	const threadsCountRes = await db.execute(sql`SELECT COUNT(*)::int AS count FROM threads`);
	const distinctThreadIdRes = await db.execute(sql`
		SELECT COUNT(DISTINCT threadid)::int AS count
		FROM user_conversations
		WHERE threadid IS NOT NULL
	`);
	const threadsCount = ((threadsCountRes as any).rows ?? threadsCountRes)[0].count;
	const distinctThreadIdCount = ((distinctThreadIdRes as any).rows ?? distinctThreadIdRes)[0].count;

	console.log(`   threads table row count:                 ${threadsCount}`);
	console.log(`   distinct threadid in user_conversations:  ${distinctThreadIdCount}`);

	if (threadsCount !== distinctThreadIdCount) {
		console.error('\n⚠️  Counts do NOT match — investigate before proceeding to cut over getUserThreads.');
		process.exit(1);
	}

	console.log('\n✅ Backfill verified — counts match.');
}

if (require.main === module) {
	backfillThreads()
		.then(() => {
			console.log('Done!');
			process.exit(0);
		})
		.catch((error) => {
			console.error('Fatal error:', error);
			process.exit(1);
		});
}

export { backfillThreads };
