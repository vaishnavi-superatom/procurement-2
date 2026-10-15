# Semantic Model Pipeline (implementation plan)

How the semantic model (`semantic-model.json`, per `SEMANTIC_MODEL_STRUCTURE.md`) flows from
Claude Code authoring → postgres → the agents/embeddings/UI. **General (all-client) change** —
validate in total-group-script, then port to the `scripts-flow` base.

```
add source → extractSchema → project_sources.schema (raw) + Chroma embed (raw, initial)
                                │
                                └─ export ──► analysis/data/<sourceId>/schema.json   (Claude Code input)
Claude Code (offline, agentic; samples live data)
                                ▼
              analysis/data/<sourceId>/semantic-model.json   (superset; reviewed in git)
                                ▼  applySemanticModel(id)        (ingest, no DB re-scan)
              project_sources.semantic_model (jsonb)  +  re-embed Chroma from it
                                ▼
runtime: MainAgent / SourceAgent / embeddings / platform-UI  → prefer semantic_model, fallback schema
```

Design choice (confirmed): the semantic model is a **self-contained superset** stored in a new
**`semantic_model` jsonb column** alongside the raw `schema` column. Runtime **prefers**
`semantic_model` when present; `schema` stays as the raw extraction (fingerprint anchor + fallback).

---

## Piece 1 — storage + types + read-preference

### 1a. DB column (`database/postgres/drizzle/schema.ts`, projectSources table ~line 170)
```ts
schema: jsonb(),                          // existing — raw extracted schema
semanticModel: jsonb("semantic_model"),   // NEW — Claude-authored superset (nullable)
```
Apply with Drizzle **push** (this repo's project-data DB): `pnpm --filter <db pkg> db:push`
(or the repo's existing push script). It's an additive nullable column — safe, no backfill.
⚠️ Confirm the repo's migration convention before running (some tables here are push-only with
empty journals — do not `db:migrate` those).

### 1b. Persist helper (`database/postgres/src/project-data-db/project-sources.ts`)
Mirror `updateSourceSchema`:
```ts
export async function updateSourceSemanticModel(id: string, semanticModel: Record<string, any> | null) {
  return db.update(projectSources)
    .set({ semanticModel, updatedAt: new Date().toISOString() })
    .where(eq(projectSources.id, id)).returning();
}
```
Ensure `getProjectSource(s)` `.select()` already returns the new column (it uses `.select()` with
no projection, so `semanticModel` flows automatically into `SourceConfig`).

### 1c. Types (`backend/src/sources/core/types.ts`)
Add optional `semantic` blocks to the existing schema types (backward-compatible — all optional),
and a `semanticModel` field on `SourceConfig`:
```ts
export interface EntitySemantic { summary: string; synonyms: string[]; embedText: string;
  joins?: { to: string; on: string; purpose?: string }[]; notes?: string; }
export interface FieldSemantic  { summary: string; synonyms?: string[]; valueVocabulary?: string[];
  unit?: string | null; notes?: string; }

// extend existing:
export interface SchemaEntity { /* …existing… */ semantic?: EntitySemantic; }
export interface SchemaField  { /* …existing… */ semantic?: FieldSemantic; }
export interface SourceSchema { /* …existing… */ schemaFingerprint?: string; glossary?: any[]; }
export interface SourceConfig { /* …existing… */ semanticModel?: SourceSchema | null; }
```
Because the semantic model is a superset, it reuses `SourceSchema` (now with optional `semantic`
fields) — no separate type needed.

### 1d. Read-preference (the one-line hook) — `backend/src/sources/core/base-source.ts` constructor (~line 51)
```ts
// before: this.schema = config.schema || null;
this.schema = (config.semanticModel as SourceSchema) || config.schema || null;
```
This makes the instance use the superset everywhere downstream (tool description, full schema,
tiering, embeddings via `embedSourceSchema` which reads `instance.getSchema()`) with **zero**
other call-site changes. Keep the raw `schema` available separately if any path needs it.

---

## Piece 2 — export schema (for Claude Code) + ingest semantic model

### 2a. Export hook — write the raw schema to a file Claude Code can read
After every successful `extractSchema()` + `updateSourceSchema()` (single shared spot:
`source-manager.ts` `embedSourceSchema` is already the post-extract fan-out; add an export
sibling, or do it in the create flow `project-sources.ts:232`):
```ts
import fs from 'fs'; import path from 'path';
function exportSchemaToAnalysis(sourceId: string, schema: SourceSchema) {
  const dir = path.join(process.env.SA_ANALYSIS_DIR || path.join(__dirname,'../../../analysis/data'), sourceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(schema, null, 2));
}
```
This is a dev/authoring convenience (gitignored or committed per client). Prod does **not** read it.

### 2b. Ingest / apply — `backend/src/collections/project-sources.ts` (new collection op)
Reuses the existing schema-embed manager; **no DB re-scan** — just load JSON, validate, persist, re-embed:
```ts
sdk.addCollection('project-sources', 'applySemanticModel', async (params: { id: string; model?: SourceSchema }) => {
  const { id } = params;
  const existing = await sourceService.getProjectSource({ id });
  if (!existing?.data) throw new Error(`Source ${id} not found`);

  // model from params, else read analysis/data/<id>/semantic-model.json
  const model = params.model ?? JSON.parse(fs.readFileSync(
    path.join(process.env.SA_ANALYSIS_DIR || '…', id, 'semantic-model.json'), 'utf8'));

  // drift guard: fingerprint must match the current raw schema
  const currentFp = computeSchemaFingerprint(existing.data.schema?.entities || []);
  if (model.schemaFingerprint && model.schemaFingerprint !== currentFp) {
    return { applied: false, reason: 'stale', expected: currentFp, got: model.schemaFingerprint };
  }

  await sourceService.updateSourceSemanticModel(id, model);

  // hot-swap the live instance + re-embed from the superset
  const mgr = getSourceManager();
  const inst = mgr?.getInstance(id);
  if (inst) { (inst as any).schema = model; await mgr!.reembedSource(id); } // reembed = thin wrapper over embedSourceSchema
  return { applied: true };
});
```
(`computeSchemaFingerprint` already exists in `schema-embeddings.ts`; export it. `reembedSource`
is a small public wrapper around the private `embedSourceSchema`.)

---

## Piece 3 — surface the new fields to embeddings + agents

The merged **`description`** flows automatically (formatters/embedder already read it). The *new*
fields (`synonyms`, `joins`, `embedText`, `valueVocabulary`) must be emitted:

### 3a. Embeddings — `backend/src/collections/schema-embeddings.ts` `buildTableDescription()`
```ts
function buildTableDescription(table: TableMetadata): string {
  const sem = (table as any).semantic;
  // Prefer the concise authored embedText when present — it's tuned for retrieval.
  if (sem?.embedText) {
    const syn = sem.synonyms?.length ? ` Synonyms: ${sem.synonyms.join(', ')}.` : '';
    return `${table.fullName} — ${sem.embedText}${syn}`;
  }
  // …existing name + description + columns fallback…
}
```
Also fold column `valueVocabulary` into the per-column text so literal values ("30 TON") embed.

### 3b. Agent views — `backend/src/sources/core/base-source.ts` `formatEntityForLLM()`
When `entity.semantic` is present, render: `summary`, `synonyms`, and the **join paths**
(`joins[]`) — the joins are what stop the SourceAgent rediscovering how to connect tables.
For fields, render `semantic.summary` + `valueVocabulary` instead of the generated description.
`buildToolDescription` (MainAgent summary) should include each table's `semantic.summary` +
top synonyms so routing improves too.

### 3c. Drift surfacing
Store `schemaFingerprint` on the model; on load, if it ≠ the raw schema's fingerprint, log a
warning and (optionally) fall back to raw `schema` so a stale model never feeds wrong identifiers.

---

## UI (platform)
`sa-platform-ui` `data-sources/*` reads `semantic_model` from the backend (same store the runtime
uses, so the view matches what the agent sees), falling back to `schema` when absent. Renders
`domain`, per-table `summary`/`synonyms`/`joins`, per-column `summary`/`valueVocabulary` — instead
of the raw schema overview.

## Order of operations to ship
1. Piece 1 (column + types + read-preference) — inert until a model exists.
2. Piece 3 (formatter/embedder emit semantic fields) — inert until a model exists.
3. Piece 2 (export + applySemanticModel) — wire the authoring loop.
4. Generate + review a model for total-group (RLogic), apply, verify retrieval/intents improve.
5. Port all of the above to `scripts-flow`.
