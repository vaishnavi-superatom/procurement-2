/**
 * Ensure the `semantic_model` (jsonb) column exists on project_sources.
 *
 * Idempotent and safe to run on every client / deployment — checks first, only
 * adds the column when missing. Pairs with the Drizzle schema definition in
 * database/postgres/drizzle/schema.ts (this script applies it to a live DB
 * without a full `drizzle-kit push`).
 *
 *   cd backend && npx ts-node scripts/ensure-semantic-column.ts
 */
import 'dotenv/config';
import { Client } from 'pg';

async function main() {
  const url = process.env.PROJECT_DATABASE_URL;
  if (!url) throw new Error('PROJECT_DATABASE_URL is not set');

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'project_sources' AND column_name = 'semantic_model'`
    );
    if (rows.length) {
      console.log('✓ project_sources.semantic_model already exists — nothing to do');
      return;
    }
    await client.query(`ALTER TABLE project_sources ADD COLUMN semantic_model jsonb`);
    console.log('✓ Created project_sources.semantic_model (jsonb)');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
