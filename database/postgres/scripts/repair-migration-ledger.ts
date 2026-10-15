/**
 * Repairs `drizzle.__drizzle_migrations` when a branch merge reorders the
 * migration journal.
 *
 * The failure mode: two branches independently write the same migration under
 * different auto-generated filenames, or in a different order. The merge keeps
 * one branch's ordering in _journal.json wholesale, so on a database that
 * already ran the other branch's migrations the ledger's timestamps no longer
 * line up with the merged journal's `when` values. drizzle-orm's migrator only
 * compares MAX(created_at) in the ledger against each journal entry's `when` —
 * it never checks hashes — so entries that moved to a later `when` look
 * unapplied and get re-run, failing with "relation ... already exists".
 *
 * This matters most on the branch clients fork from: every client that merges
 * a batch of new migrations can hit it.
 *
 * Idempotent, and safe on a fresh database. For each migration file it only
 * backfills a ledger row at the CURRENT journal position when that exact file
 * content (by hash) was already recorded under some other timestamp — i.e.
 * only for migrations genuinely applied under a different name or slot. It
 * never runs SQL. For a migration whose hash the ledger has never seen (e.g.
 * one applied by hand with `psql -f` rather than db:migrate), it falls back to
 * checking whether that migration's own CREATE TABLE target already exists
 * before backfilling; if the table is absent it leaves the entry alone so
 * db:migrate runs it normally.
 *
 * Run once, before `pnpm db:migrate`, on any database that fails with
 * "relation ... already exists" after merging:
 *   cd database/postgres && pnpm db:repair-ledger
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

dotenv.config();

const MIGRATIONS_DIR = join(__dirname, '..', 'drizzle', 'migrations');
const JOURNAL_PATH = join(MIGRATIONS_DIR, 'meta', '_journal.json');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function main() {
  const connectionString = process.env.PROJECT_DATABASE_URL;
  if (!connectionString) {
    console.error('Error: PROJECT_DATABASE_URL not found in environment variables');
    process.exit(1);
  }

  const journal: { entries: JournalEntry[] } = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8'));

  const pool = new Pool({ connectionString });

  try {
    // Ensure the ledger table/schema exist (matches drizzle-orm's own migrator bootstrap).
    await pool.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await pool.query(
      `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`
    );

    const { rows: ledgerRows } = await pool.query<{ hash: string; created_at: string }>(
      'SELECT hash, created_at FROM "drizzle"."__drizzle_migrations"'
    );
    const knownHashes = new Set(ledgerRows.map((r) => r.hash));
    const knownTimestamps = new Set(ledgerRows.map((r) => r.created_at));

    let inserted = 0;
    for (const entry of journal.entries) {
      const filePath = join(MIGRATIONS_DIR, `${entry.tag}.sql`);
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        console.warn(`  skip ${entry.tag}: file not found on disk`);
        continue;
      }
      const hash = sha256(content);
      const whenStr = String(entry.when);

      if (knownTimestamps.has(whenStr)) {
        continue; // already recorded at this exact journal position — nothing to do
      }

      let alreadyApplied = knownHashes.has(hash);
      if (!alreadyApplied) {
        // Never applied via db:migrate under any hash — check whether this
        // migration's own CREATE TABLE target already exists (e.g. it was
        // applied by hand via psql -f, bypassing the ledger entirely).
        const createTableMatch = content.match(/CREATE TABLE\s+"?(\w+)"?/i);
        if (createTableMatch) {
          const { rows } = await pool.query<{ exists: string | null }>(
            'SELECT to_regclass($1) AS exists',
            [`public.${createTableMatch[1]}`]
          );
          if (rows[0]?.exists) {
            alreadyApplied = true;
          }
        }
      }
      if (!alreadyApplied) {
        continue; // genuinely not applied yet — let db:migrate run it normally
      }

      await pool.query(
        'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
        [hash, entry.when]
      );
      knownTimestamps.add(whenStr);
      inserted++;
      console.log(`  backfilled ledger row for ${entry.tag} (already-applied content, new journal slot)`);
    }

    if (inserted === 0) {
      console.log('Ledger already consistent with the journal — nothing to backfill.');
    } else {
      console.log(`\nBackfilled ${inserted} ledger row(s). Safe to run pnpm db:migrate now.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Repair failed:', err);
  process.exit(1);
});
