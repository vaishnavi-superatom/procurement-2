/**
 * Inject a semantic-model.json into project_sources.semantic_model for one source.
 *
 * - Ensures the semantic_model column exists (calls the same check as ensure-semantic-column).
 * - Validates the file is parseable JSON with entities.
 * - Warns if the model's schemaFingerprint no longer matches the source's live schema
 *   (i.e. the DB schema changed since the model was generated — regenerate to be safe).
 * - UPDATEs the column.
 *
 *   cd backend && npx ts-node scripts/apply-semantic-model.ts <sourceId> [path/to/semantic-model.json]
 *
 * Default path: <repo>/analysis/data/<sourceId>/semantic-model.json
 * (override the base dir with SA_ANALYSIS_DIR).
 *
 * AFTER running: restart the backend so it loads the semantic model as the source's
 * schema AND re-embeds the schema index (the embedText changes the embed fingerprint,
 * which triggers a re-embed on the next start).
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Client } from 'pg';

/**
 * Structural fingerprint of a raw schema — table names, row counts, and column
 * name:type. This is the value a freshly-generated semantic model stamps into
 * `schemaFingerprint`, used here only to detect schema drift (did the DB schema
 * change since the model was generated?). It deliberately does NOT include any
 * embed/semantic content — that's a separate concern handled by the runtime's
 * embed-skip fingerprint.
 */
function structuralFingerprint(entities: any[]): string {
  const norm = entities
    .map((e) => ({
      name: e.fullName || e.name,
      rows: e.rowCount || 0,
      cols: (e.fields || []).slice(0, 40).map((f: any) => `${f.name}:${f.type}`).sort().join(','),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha1').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

async function main() {
  const sourceId = process.argv[2];
  let file = process.argv[3];
  if (!sourceId) {
    console.error('usage: npx ts-node scripts/apply-semantic-model.ts <sourceId> [path/to/semantic-model.json]');
    process.exit(1);
  }
  if (!file) {
    const base = process.env.SA_ANALYSIS_DIR || path.join(__dirname, '..', '..', 'analysis', 'data');
    file = path.join(base, sourceId, 'semantic-model.json');
  }
  if (!fs.existsSync(file)) throw new Error(`semantic model file not found: ${file}`);

  const raw = fs.readFileSync(file, 'utf8');
  let model: any;
  try { model = JSON.parse(raw); } catch (e: any) { throw new Error(`invalid JSON in ${file}: ${e.message}`); }
  const n = (model.entities || []).length;
  if (!n) throw new Error('semantic model has no entities[]');

  const url = process.env.PROJECT_DATABASE_URL;
  if (!url) throw new Error('PROJECT_DATABASE_URL is not set');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // 1. ensure the column exists
    const col = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='project_sources' AND column_name='semantic_model'`
    );
    if (!col.rows.length) {
      await client.query(`ALTER TABLE project_sources ADD COLUMN semantic_model jsonb`);
      console.log('✓ created project_sources.semantic_model column');
    }

    // 2. verify the source exists + drift check
    const src = await client.query(`SELECT id, schema FROM project_sources WHERE id = $1`, [sourceId]);
    if (!src.rows.length) throw new Error(`source not found: ${sourceId}`);
    const liveSchema = src.rows[0].schema;
    if (liveSchema?.entities && model.schemaFingerprint) {
      const fp = structuralFingerprint(liveSchema.entities);
      if (fp !== model.schemaFingerprint) {
        console.warn(`⚠ schema drift: model fingerprint ${model.schemaFingerprint} != live schema ${fp}.`);
        console.warn('  The DB schema changed since this model was generated — regenerate to stay accurate. Applying anyway.');
      } else {
        console.log(`✓ fingerprint matches live schema (${fp})`);
      }
    }

    // 3. apply
    const r = await client.query(
      `UPDATE project_sources SET semantic_model = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING id`,
      [raw, sourceId]
    );
    console.log(`✓ applied semantic model to ${r.rows[0].id} (${n} entities) from ${file}`);
    console.log('→ Restart the backend so it loads the model and re-embeds the schema index.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
