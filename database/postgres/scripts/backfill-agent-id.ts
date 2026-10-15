/**
 * Assign a chat agent to every thread and conversation saved before agents
 * were recorded (agent_id IS NULL). Rows that already have an agent are left
 * untouched.
 *
 * Usage (from database/postgres):
 *   npx tsx scripts/backfill-agent-id.ts <agentId>
 *
 * <agentId> is the chat agent's sa-api app id. Both tables are updated in one
 * transaction — either both are filled or neither is.
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ quiet: true });

async function main() {
	const agentId = process.argv[2]?.trim();
	if (!agentId) {
		console.error('Usage: npx tsx scripts/backfill-agent-id.ts <agentId>');
		process.exit(1);
	}

	const connectionString = process.env.PROJECT_DATABASE_URL;
	if (!connectionString) {
		console.error('Error: PROJECT_DATABASE_URL not found in environment variables');
		process.exit(1);
	}

	const pool = new Pool({ connectionString });
	const client = await pool.connect();
	let failed = false;

	try {
		await client.query('BEGIN');

		const threads = await client.query(
			'UPDATE threads SET agent_id = $1 WHERE agent_id IS NULL',
			[agentId],
		);
		const conversations = await client.query(
			'UPDATE user_conversations SET agent_id = $1 WHERE agent_id IS NULL',
			[agentId],
		);

		await client.query('COMMIT');

		console.log(`✓ agent_id set to ${agentId}`);
		console.log(`  threads:            ${threads.rowCount ?? 0} row(s)`);
		console.log(`  user_conversations: ${conversations.rowCount ?? 0} row(s)`);
	} catch (error) {
		await client.query('ROLLBACK').catch(() => {});
		console.error('❌ Backfill failed, nothing was changed:');
		console.error(error);
		failed = true;
	} finally {
		client.release();
		await pool.end();
	}

	if (failed) process.exitCode = 1;
}

main();
