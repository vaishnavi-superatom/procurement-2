Trace 1: Creating a multi-CSV source

1. Request arrives — the browser has already uploaded all 3 files straight to R2 (frontend, not backend) and sends one DATA_REQ WebSocket message: { collection: 'project-sources', op: 'create', params: { type: 'csv', config: { files: [{r2Key, fileName}, ...] } } }.

2. sdk-nodejs routes it — handleDataRequest() (in the SDK, unchanged by us) looks up collections['project-sources']['create'] and calls it with params.

3. project-sources.ts:248 addSourceOp('create', ...) — our handler runs:
- project-sources.ts:279 — fails fast if config.files.length > MAX_FILES_PER_SOURCE (20), before touching R2.
- project-sources.ts:301 — fingerprints the whole file list (joined filenames) for the deterministic source id, instead of one filename.
- project-sources.ts:318 — the download loop: for each entry in config.files, calls downloadFileFromR2(r2Key, projectId, id, fileName, String(i)) (file-storage.ts — the String(i) is the fix I added so two files named data.csv don't collide on the same local disk path) and writes the resolved local path back onto entry.filePath.
- project-sources.ts:404 (hasMultiFiles) — the PII gate branches: builds one deduped table name per file via table-naming.ts's dedupeTableName/baseTableName, samples each file with sampleMultipleCsvs() (pii-sampler.ts, new), and calls detectPII() once over the combined multi-entity sample — same as Excel already does per-sheet. If PII is found, returns pii_review here and stops (nothing built yet).
- sourceRegistry.createInstance(sourceConfig) → because type: 'csv', this constructs a CSVInstance.

4. CSVInstance.connect() — csv/instance.ts:166 — this is where the actual DuckDB build happens:
- resolveFileEntries() (csv/instance.ts:96) — resolves config.files (re-downloading from R2 per-file if a file went missing, e.g. after a restart).
- Checks the combined fingerprint of all files against the cached .duckdb — if every file is byte-identical to last time, reuses the cached DB and returns early.
- Otherwise, the load loop (csv/instance.ts:224) — for each file: assigns/reuses a deduped table name, applies any PII redact/drop policy scoped to that table name, runs CREATE TABLE "<name>" AS SELECT * FROM read_csv(...). One DuckDB file (duckdb/{projectId}/{sourceId}.duckdb) ends up holding N tables — same pattern ExcelInstance already used for sheets.
- entry.tableName gets written back onto the same config.files array object create is about to persist (confirmed BaseSource holds config by reference, not a copy) — so table names land in Postgres without an extra round-trip.

5. Back in create — connection tested + healthy → sourceService.createProjectSource() persists the row to project_sources (Postgres) → fire-and-forget: instance.extractSchema() (one SchemaEntity per table) → sdk.setTools() refreshes the LLM's tool list, so the new multi-table source is now queryable in chat.

6. Federation (cross-source joins) — inside manager.addSource(), source-manager.ts:303 now calls federation.loadCSVTables() (plural — federation/instance.ts:270, the method I renamed/rewrote from the old hardcoded-to-one-table loadCSVTable). It loops every entity, mapping each to its file via config.files[i].filePath, and creates one DuckDB VIEW per table in the shared federation database — this is what lets the "Cross-Source Query" tool JOIN across all 3 files (and across other sources).

Trace 2: Add/remove/replace a file on an existing multi-CSV source

1. Request arrives — DATA_REQ, { collection: 'project-sources', op: 'refreshSource', params: { id, filesToAdd?, filesToRemove?, filesToReplace? } }.

2. project-sources.ts:1263 addSourceOp('refreshSource', ...):
- project-sources.ts:1321 (if (hasBatchOp)) — new branch, separate from the old whole-file-swap path (which still exists untouched below it for excel/legacy single-file csv).
- Reads the source's current config.files (or upgrades a legacy single-file source into a one-entry list on its first batch op).
- Applies removes → replaces → adds in order, downloading any new/replaced file via downloadFileFromR2, tracking R2 keys to delete-on-success vs. clean-up-on-failure.
- Runs a cheap sampleCsvEntity() read on just the changed files as a validity check, then (if piiDetection requested) the same sampleMultipleCsvs() + detectPII() PII gate — but scoped to only the new/changed files, not the whole batch.
- Persists the new config.files to Postgres, mutates the live instance.config.config in place, then calls instance.refresh().

3. CSVInstance.refresh() — literally just calls connect() again (this was already true before my changes, for both CSV and Excel). Since the fingerprint no longer matches (files changed), it runs the same full-rebuild load loop from Trace 1 step 4 — no separate "incremental" code path exists; add/remove/replace works by mutating the file list, then letting the existing rebuild-from-list logic do its normal thing.

4. Same tail as Trace 1 — schema re-extracted, computeSchemaDrift() (pre-existing, untouched — it already compared schemas by entity/table name, so it "just worked" for add/remove/replace without any changes), sdk.setTools() refreshed.

Everything else I touched, and why

- csv/index.ts — validateConfig now also accepts files[]; exports MAX_FILES_PER_SOURCE (imported by project-sources.ts for the cap check).
- table-naming.ts (new file) — the one place dedupeTableName/baseTableName live, used by both CSVInstance and the PII gate in project-sources.ts so a PII finding's entity tag always matches the table DuckDB actually ends up with.
- delete handler (project-sources.ts) — found while reviewing: it only ever cleaned up a singular config.filePath/r2Key, so deleting a multi-file source would've leaked every uploaded file on disk and in R2. Now loops config.files too.
- discardUpload handler — same gap, for the "user declined the PII prompt" cleanup path; now accepts an optional files[] array alongside the old singular params.