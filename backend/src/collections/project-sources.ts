/**
 * Project Sources Collection
 *
 * CRUD operations for managing data sources via SDK
 */

import * as sourceService from '../../../database/postgres/src/project-data-db/project-sources';
import { sourceRegistry, getSourceManager, loadModule, isSourceTypeSupported } from '../sources';
import type { SourceSchema } from '../sources';
import { generateSourceId } from '../sources/core/fingerprint';
import { saveUploadedFile, downloadFileFromR2, deleteUploadedFile, isUploadedFile, deleteSourceDbFile, deleteFileFromR2, deleteSourceCsvDir, deleteSourceMeta } from '../sources/core/file-storage';
import { getAllTools } from '../tools';
import { detectPII } from '../sources/core/pii-detector';
import { sampleSchemaForPII, sampleConvertedCsvs, sampleMultipleCsvs, sampleCsvEntity } from '../sources/core/pii-sampler';
import * as path from 'path';
import { ensureXlsxConverted } from '../sources/core/xlsx-to-csv';
import { baseTableName, dedupeTableName } from '../sources/core/table-naming';
import { MAX_FILES_PER_SOURCE } from '../sources/csv';
import type { CollectionContext } from './types';
import { redactSourceSecrets, restoreSourceSecrets } from './source-redaction';
import { runAsSystem } from '@superatomai/sdk-node';

/**
 * Compare an old schema against a new one and return a drift report.
 * Returns null when nothing changed. Used by replace-file to warn the user
 * when an uploaded file changes the shape of the data underneath them.
 */
interface SchemaDrift {
  removedEntities: string[];
  addedEntities: string[];
  removedFields: Array<{ entity: string; field: string }>;
  typeChanges: Array<{ entity: string; field: string; from: string; to: string }>;
}

// ============================================
// Secret field masking/merging for project-sources responses
// ============================================
// Never send a source's secret config fields (e.g. NetSuite's privateKey, a
// DB password) back to the frontend on read, and never let a save that
// doesn't touch a secret field accidentally wipe it — see getSecretFieldPaths
// in the database layer for which fields are encrypted at rest per type.

function getPath(obj: any, path: string): any {
  return path.split('.').reduce((cur, key) => (cur == null ? cur : cur[key]), obj);
}

function setPath(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj: any, path: string): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

/** Strip secret config fields before a source is sent to the frontend. */
function maskSecretFields<T extends { type: string; config?: Record<string, any> | null }>(source: T): T {
  if (!source?.config) return source;
  const paths = sourceService.getSecretFieldPaths(source.type);
  if (!paths.length) return source;
  const config = JSON.parse(JSON.stringify(source.config));
  for (const path of paths) deletePath(config, path);
  return { ...source, config };
}

/**
 * Fill in any secret field left blank/omitted in an update payload with the
 * source's current (already-stored, decrypted) value, so a save that doesn't
 * touch a secret — e.g. just renaming the source — doesn't need it
 * re-supplied and doesn't accidentally clear it. Mutates `incomingConfig`.
 */
function preserveOmittedSecrets(sourceType: string, incomingConfig: Record<string, any>, existingConfig: Record<string, any> | null | undefined): void {
  if (!existingConfig) return;
  const paths = sourceService.getSecretFieldPaths(sourceType);
  for (const path of paths) {
    const incoming = getPath(incomingConfig, path);
    if (incoming === undefined || incoming === null || incoming === '') {
      const existing = getPath(existingConfig, path);
      if (existing !== undefined) setPath(incomingConfig, path, existing);
    }
  }
}

function computeSchemaDrift(
  oldSchema: SourceSchema | null | undefined,
  newSchema: SourceSchema,
): SchemaDrift | null {
  if (!oldSchema?.entities?.length) return null;

  const oldByName = new Map(oldSchema.entities.map(e => [e.name, e]));
  const newByName = new Map(newSchema.entities.map(e => [e.name, e]));

  const removedEntities: string[] = [];
  const addedEntities: string[] = [];
  const removedFields: SchemaDrift['removedFields'] = [];
  const typeChanges: SchemaDrift['typeChanges'] = [];

  for (const [name, oldEntity] of oldByName) {
    const newEntity = newByName.get(name);
    if (!newEntity) {
      removedEntities.push(name);
      continue;
    }
    const newFields = new Map(newEntity.fields.map(f => [f.name, f]));
    for (const oldField of oldEntity.fields) {
      const newField = newFields.get(oldField.name);
      if (!newField) {
        removedFields.push({ entity: name, field: oldField.name });
      } else if (newField.type !== oldField.type) {
        typeChanges.push({ entity: name, field: oldField.name, from: oldField.type, to: newField.type });
      }
    }
  }

  for (const name of newByName.keys()) {
    if (!oldByName.has(name)) addedEntities.push(name);
  }

  const hasDrift =
    removedEntities.length > 0 ||
    addedEntities.length > 0 ||
    removedFields.length > 0 ||
    typeChanges.length > 0;

  return hasDrift ? { removedEntities, addedEntities, removedFields, typeChanges } : null;
}

export async function registerProjectSourcesCollections({ sdk }: CollectionContext): Promise<void> {

  // Push a live upload-progress event to the initiating browser (best-effort —
  // never throws, never blocks the upload). No-op unless the client passed both
  // its clientId (for point-to-point routing) and an uploadId (to correlate).
  const sendUploadProgress = (
    clientId: string | undefined,
    uploadId: string | undefined,
    step: string,
    message: string,
    extra?: Record<string, any>,
  ): void => {
    if (!clientId || !uploadId) return;
    try {
      sdk.send({
        id: `upload_progress_${uploadId}_${step}_${Date.now()}`,
        type: 'UPLOAD_PROGRESS',
        from: { type: 'data-agent' },
        to: { id: clientId },
        payload: { uploadId, step, message, ...extra },
      } as any);
    } catch { /* best-effort progress — never affects the upload */ }
  };

  // Push a one-time schema-extraction outcome event to the initiating browser (best-effort — never
  // throws, never blocks the extraction). No-op unless the client passed its clientId. Used for
  // NetSuite's background extraction (see extractSchema below), where the result can arrive
  // 30-60+ min after the original request/response already completed.
  const sendSchemaExtractionEvent = (
    clientId: string | undefined,
    sourceId: string,
    type: 'SCHEMA_EXTRACTION_DONE' | 'SCHEMA_EXTRACTION_FAILED',
    payload: Record<string, any>,
  ): void => {
    if (!clientId) return;
    try {
      sdk.send({
        id: `schema_extraction_${sourceId}_${Date.now()}`,
        type,
        from: { type: 'data-agent' },
        to: { id: clientId },
        payload: { sourceId, ...payload },
      } as any);
    } catch { /* best-effort — never affects the extraction itself */ }
  };

  // Map xlsx→CSV conversion events to a 'converting' progress message. Reused by
  // the PII gate (which converts to sample) AND the instance build (which converts
  // when no gate ran, i.e. PII off) so progress shows in both paths.
  const convertProgressSink = (
    progress: (step: string, message: string, extra?: Record<string, any>) => void,
  ) => (info: { sheetName: string; sheetIndex: number; rows: number; done: boolean }): void =>
    progress(
      'converting',
      info.done
        ? `Converted sheet "${info.sheetName}" (${info.rows.toLocaleString()} rows)`
        : `Converting "${info.sheetName}"…${info.rows ? ` ${info.rows.toLocaleString()} rows` : ''}`,
      { sheet: info.sheetName, sheetIndex: info.sheetIndex, rows: info.rows, done: info.done },
    );

  // Map per-sheet PII-redaction events to a 'redacting' progress message, so the
  // user sees which sheet is being masked and how far along (rows processed).
  const redactProgressSink = (
    progress: (step: string, message: string, extra?: Record<string, any>) => void,
  ) => (info: { sheetName: string; rows: number; total: number; done: boolean }): void =>
    progress(
      'redacting',
      info.done
        ? `Redacted "${info.sheetName}" (${info.total.toLocaleString()} rows)`
        : info.total > 0
          ? `Redacting "${info.sheetName}"… ${info.rows.toLocaleString()}/${info.total.toLocaleString()} rows`
          : `Redacting "${info.sheetName}"…`,
      { sheet: info.sheetName, rows: info.rows, total: info.total, done: info.done },
    );

  // Map per-sheet DuckDB load events to a 'loading' progress message. This fills
  // the gap after conversion, while each sheet's CSV is read into DuckDB and
  // re-typed — the long pole for big sheets.
  const loadProgressSink = (
    progress: (step: string, message: string, extra?: Record<string, any>) => void,
  ) => (info: { sheetName: string; index: number; total: number }): void =>
    progress(
      'loading',
      info.total > 1
        ? `Loading "${info.sheetName}" into the database… (${info.index}/${info.total})`
        : `Loading "${info.sheetName}" into the database…`,
      { sheet: info.sheetName, index: info.index, total: info.total },
    );

  // ============================================
  // CRUD Operations
  // ============================================

  /**
   * Register a project-sources operation with credential redaction applied to
   * whatever it returns. Every op goes through here rather than each handler
   * sanitizing itself, so a new operation cannot leak `config` by omission —
   * source rows carry live host/user/password and this collection is served to
   * browsers over the DATA_REQ bus.
   */
  const addSourceOp = <TParams>(
    operation: string,
    handler: (params: TParams) => Promise<any>
  ): void => {
    sdk.addCollection('project-sources', operation, async (params: TParams) =>
      redactSourceSecrets(await handler(params))
    );
  };

  // Create a new source
  addSourceOp('create', async (params: {
    id?: string;
    projectId: string;
    name: string;
    description?: string;
    type: string;
    config: Record<string, any>;
    isPrimary?: boolean;
    /** Opt-in: run a PII scan before persisting the source (file sources). */
    piiDetection?: boolean;
    /** Set on the confirm re-call after the user accepts a PII review prompt. */
    piiAcknowledged?: boolean;
    /**
     * Columns to redact, as { entity, column } targets (entity = table for CSV,
     * sheet name for Excel). Sent on the confirm re-call for "redact & add" /
     * "redact specific & add". Persisted in config; the load pipeline masks each
     * target per-cell (only cells containing PII) on every (re)build.
     */
    redactColumns?: Array<{ entity: string; column: string }>;
    /** Columns to drop entirely (the "skip" choice in the PII modal). Persisted in config. */
    dropColumns?: Array<{ entity: string; column: string }>;
    /** Browser clientId + uploadId for live upload-progress events (optional). */
    clientId?: string;
    uploadId?: string;
    /** Identity of whoever is creating this source — stamped as createdBy/updatedBy on the audit trail (csv only, for now). */
    userId?: string;
  }) => {
    const { projectId, name, description, type, config, isPrimary } = params;

    if (!projectId) throw new Error('projectId is required');
    if (!name) throw new Error('name is required');
    if (!type) throw new Error('type is required');
    if (!config) throw new Error('config is required');
    if (Array.isArray(config.files) && config.files.length > MAX_FILES_PER_SOURCE) {
      throw new Error(`Too many files (${config.files.length}). Maximum is ${MAX_FILES_PER_SOURCE} per source.`);
    }

    // Live progress emitter for this upload (no-op unless the client opted in).
    const progress = (step: string, message: string, extra?: Record<string, any>) =>
      sendUploadProgress(params.clientId, params.uploadId, step, message, extra);

    // The browser uploads the file(s) to R2 *before* calling create, so capture
    // those keys up front: if anything below fails (disk full while downloading,
    // an unparseable file, a failed connection test, a DB insert error), the R2
    // object(s) would be orphaned forever. We clean them up in the catch at the end.
    const uploadedR2Key: string | undefined = config.r2Key;
    const uploadedR2Keys: string[] = Array.isArray(config.files)
      ? config.files.map((f: any) => f?.r2Key).filter(Boolean)
      : (uploadedR2Key ? [uploadedR2Key] : []);
    let sourceRecordCreated = false;
    try {

    // For file uploads, use the original fileName(s) for fingerprinting so each
    // distinct file/batch gets a unique ID (filePath isn't set yet at this point)
    const configForId = { ...config };
    if (Array.isArray(config.files) && config.files.length > 0) {
      configForId.filePath = config.files.map((f: any) => f.fileName).join('|');
      delete configForId.files;
    } else if (config.fileData && config.fileName) {
      configForId.filePath = config.fileName;
    } else if (config.r2Key) {
      // R2 upload path — fingerprint on filename so re-uploads of the same name
      // dedupe identically to the legacy base64 path. r2Key itself contains a
      // UUID, so using it would defeat dedup.
      configForId.filePath = config.fileName || config.r2Key.split('/').pop() || config.r2Key;
      delete configForId.r2Key;
    }

    // Generate deterministic ID from config — same source always gets the same ID
    const id = generateSourceId(type as any, configForId, projectId);

    // Handle file upload(s): download/save, replacing r2Key/fileData with a local filePath.
    if (Array.isArray(config.files) && config.files.length > 0) {
      progress('downloading', `Fetching ${config.files.length} file(s)…`);
      for (let i = 0; i < config.files.length; i++) {
        const f = config.files[i];
        if (!f.r2Key) throw new Error(`File "${f.fileName}" is missing its upload key`);
        f.filePath = await downloadFileFromR2(f.r2Key, projectId, id, f.fileName, String(i));
      }
      console.log(`[PROJECT-SOURCES] ${config.files.length} source file(s) ready`);
    } else if (config.fileData && config.fileName) {
      const savedPath = saveUploadedFile(config.fileData, config.fileName, projectId, id);
      config.filePath = savedPath;
      // Don't persist base64 data in the database
      delete config.fileData;
      delete config.fileName;
      console.log(`[PROJECT-SOURCES] File uploaded and saved to: ${savedPath}`);
    } else if (config.r2Key) {
      // R2 upload path: pull the file from R2 to local disk so DuckDB can read it.
      // r2Key is kept in config — needed to re-hydrate the local cache after a
      // backend restart / disk wipe.
      progress('downloading', 'Fetching the uploaded file…');
      const savedPath = await downloadFileFromR2(config.r2Key, projectId, id, config.fileName);
      config.filePath = savedPath;
      delete config.fileName; // redundant once filePath is set
      console.log(`[PROJECT-SOURCES] Source file ready at: ${savedPath}`);
    }

    // ============================================
    // PII redaction (opt-in via `redactColumns`)
    // ============================================
    // Persist the chosen { entity, column } targets in the source config. The load
    // pipeline (each instance's connect) masks them per-cell on every (re)build —
    // CSV rewrites its local file; Excel masks the converted per-sheet CSVs (the
    // .xlsx is never touched). Persisting makes redaction durable across rebuilds
    // and R2 re-hydration, since connect() re-applies it whenever it rebuilds.
    if (Array.isArray(params.redactColumns) && params.redactColumns.length > 0) {
      (config as any).redactColumns = params.redactColumns;
    }
    if (Array.isArray(params.dropColumns) && params.dropColumns.length > 0) {
      (config as any).dropColumns = params.dropColumns;
    }
    const piiTargetCount = (params.redactColumns?.length || 0) + (params.dropColumns?.length || 0);
    if (piiTargetCount > 0) {
      console.log(`[PROJECT-SOURCES] PII policy for "${name}": ${params.redactColumns?.length || 0} redact + ${params.dropColumns?.length || 0} drop column(s) — applied on load`);
    }

    // Lazy-load the module if it's a known type but not yet registered
    if (!sourceRegistry.isSupported(type) && isSourceTypeSupported(type)) {
      await loadModule(type);
    }

    // Validate source type
    if (!sourceRegistry.isSupported(type)) {
      throw new Error(`Unsupported source type: ${type}. Supported: ${sourceRegistry.getSupportedTypes().join(', ')}`);
    }

    // Validate config
    const validation = sourceRegistry.validateConfig(type as any, config);
    if (!validation.valid) {
      throw new Error(`Invalid config: ${validation.errors?.join(', ')}`);
    }

    // Reject duplicates BEFORE connecting. `id` is a deterministic fingerprint,
    // so a re-upload of the same source resolves to the same id — and since we
    // now connect the test instance under the real id, letting it proceed would
    // rebuild (and on disconnect delete) the DuckDB file that the existing live
    // instance is using. Fail fast instead. (getProjectSource throws when absent.)
    let alreadyExists = false;
    try {
      const existing = await sourceService.getProjectSource({ id });
      alreadyExists = !!existing?.data;
    } catch { /* not found — fall through to create */ }
    if (alreadyExists) {
      console.warn(`[PROJECT-SOURCES] Duplicate source detected: ${id}`);
      throw new Error(`This data source is already connected. The same connection configuration already exists in this project.`);
    }

    // ============================================
    // PII detection gate (opt-in via `piiDetection`)
    // ============================================
    // Runs BEFORE the (potentially expensive) build by sampling only the HEAD of
    // the file — column names + a few rows are all detectPII needs. This avoids
    // loading a large file into DuckDB just to discover it has PII. If PII is
    // found and not yet acknowledged, we return the review prompt WITHOUT building
    // anything; the downloaded file is kept so the confirm re-call builds once
    // (with the chosen redact/drop policy). Per-cell redaction later still scans
    // every row, so head-sampling only affects which columns are offered.
    const hasMultiFiles = Array.isArray(config.files) && config.files.length > 0;
    if (
      params.piiDetection &&
      !params.piiAcknowledged &&
      (type === 'csv' || type === 'excel') &&
      ((config as any).filePath || hasMultiFiles)
    ) {
      try {
        let sampled;
        if (type === 'excel') {
          // Convert the workbook to per-sheet CSVs (the build reuses these via the
          // fingerprint marker, so the xlsx is read once) then sample those CSVs —
          // exceljs is forward-only and can't be cheaply head-read directly.
          const converted = await ensureXlsxConverted((config as any).filePath, projectId, id, {
            sheets: config.sheets,
            logPrefix: '[PROJECT-SOURCES]',
            onProgress: convertProgressSink(progress),
          }, uploadedR2Key);
          sampled = await sampleConvertedCsvs(converted);
        } else if (hasMultiFiles) {
          // Assign the same (deduped) table names CSVInstance will use, so PII
          // findings and the eventual redact/drop policy land on the same entity.
          const used = new Set<string>();
          const named = config.files.map((f: any) => {
            const tableName = dedupeTableName(baseTableName(f.fileName), used);
            used.add(tableName);
            return { filePath: f.filePath, tableName };
          });
          sampled = await sampleMultipleCsvs(named, config.delimiter, config.hasHeader);
        } else {
          sampled = await sampleSchemaForPII((config as any).filePath, 'csv', {
            delimiter: config.delimiter,
            hasHeader: config.hasHeader,
          });
        }
        progress('scanning', 'Scanning for personal information…');
        const piiFindings = await detectPII(sampled);
        if (piiFindings.length > 0) {
          progress('review', `Potential PII found in ${piiFindings.length} column(s) — review needed`);
          console.log(`[PROJECT-SOURCES] PII detected in ${piiFindings.length} column(s) for "${name}" (head sample) — awaiting user confirmation`);
          return {
            success: false,
            status: 'pii_review',
            message: `Potential PII detected in ${piiFindings.length} column(s). Confirm to proceed.`,
            piiFindings,
            // Echoed back to `discardUpload` if the user declines, so the orphaned
            // upload(s) (R2 object + local file) get cleaned up.
            sourceId: id,
            r2Key: uploadedR2Key,
            filePath: (config as any).filePath,
            files: hasMultiFiles ? config.files.map((f: any) => ({ r2Key: f.r2Key, filePath: f.filePath })) : undefined,
          };
        }
        console.log(`[PROJECT-SOURCES] PII scan clean for "${name}" (head sample) — proceeding`);
      } catch (piiErr) {
        // Fail-open: a scan error must never block a legitimate upload.
        console.warn(`[PROJECT-SOURCES] PII head-sample scan failed for "${name}", proceeding without gate:`, piiErr);
      }
    }

    // Build the real runtime config once. We connect it now to validate the
    // source before persisting, then ADOPT that same connected instance into
    // the manager below — avoiding a second connect(), which for Excel/CSV
    // would re-load the entire file into DuckDB.
    const sourceConfig = {
      id,
      projectId,
      name,
      description,
      type: type as any,
      config,
      isPrimary: isPrimary ?? false,
      isActive: true,
    };

    let testedInstance: ReturnType<typeof sourceRegistry.createInstance> | null = null;
    try {
      console.log(`[PROJECT-SOURCES] Testing connection for: ${name} (${type})`);
      progress('building', 'Loading the data into the database…');
      testedInstance = sourceRegistry.createInstance(sourceConfig as any);
      // Show conversion progress even when no PII gate ran (PII off) — connect()
      // is where the xlsx is converted in that case. onRedactProgress surfaces the
      // per-sheet masking detail when a redact/skip policy is applied.
      (testedInstance as any).onConvertProgress = convertProgressSink(progress);
      (testedInstance as any).onRedactProgress = redactProgressSink(progress);
      (testedInstance as any).onLoadProgress = loadProgressSink(progress);
      if (params.userId) (testedInstance as any).currentActor = params.userId;
      await testedInstance.connect();
      const healthy = await testedInstance.healthCheck();

      if (!healthy) {
        throw new Error(`Connection test failed: health check returned unhealthy`);
      }
      console.log(`[PROJECT-SOURCES] Connection test passed for: ${name}`);
      progress('extracting', 'Finalizing & extracting schema…');
    } catch (connError: any) {
      // Release the half-open instance so we don't leak a DuckDB handle / file.
      if (testedInstance) {
        try { await testedInstance.disconnect(); } catch { /* ignore */ }
      }
      const connMsg = connError instanceof Error ? connError.message : String(connError);
      console.error(`[PROJECT-SOURCES] Connection test failed for ${name}:`, connMsg);
      throw new Error(`Cannot connect to data source: ${connMsg}`);
    }

    try {
      console.log(`[PROJECT-SOURCES] Creating source: ${name} (${type})`);
      const result = await sourceService.createProjectSource({
        id,
        projectId,
        name,
        description,
        type: type as any,
        config,
        isPrimary,
      });
      console.log(`[PROJECT-SOURCES] Created successfully: ${id}`);
      sourceRecordCreated = true;

      // Add to runtime manager — background for most types, awaited for csv/excel.
      const manager = getSourceManager();
      if (manager) {
        // Hand ownership of the already-connected instance to the manager.
        const instanceToRegister = testedInstance;
        testedInstance = null;

        // Register instance, extract schema, refresh SDK tools.
        const registerAndExtract = async () => {
          try {
            const instance = await manager.addSource(sourceConfig as any, instanceToRegister ?? undefined);
            console.log(`[PROJECT-SOURCES] Source instance registered: ${id}`);

            // Extract schema and save to DB
            try {
              const schema = await instance.extractSchema();
              await sourceService.updateSourceSchema(id, schema);
              console.log(`[PROJECT-SOURCES] Schema extracted for: ${name} (${schema.entities?.length || 0} entities)`);
            } catch (schemaError) {
              console.warn(`[PROJECT-SOURCES] Schema extraction failed for ${name}, source still usable:`, schemaError);
            }

            // Refresh SDK tools so the new source tool is available to LLM
            const updatedTools = getAllTools();
            sdk.setTools(updatedTools);
            console.log(`[PROJECT-SOURCES] SDK tools refreshed (${updatedTools.length} total) — new tool available for: ${name}`);
          } catch (runtimeError) {
            console.error(`[PROJECT-SOURCES] Failed to register runtime instance for ${id}:`, runtimeError);
            // addSource rejected before adopting the instance — release it.
            if (instanceToRegister && manager.getInstance(id) !== instanceToRegister) {
              try { await instanceToRegister.disconnect(); } catch { /* ignore */ }
            }
          }
        };

        if (type === 'csv' || type === 'excel') {
          // connect() above already built (and typed) the DuckDB tables, so
          // extractSchema() here is just a cheap DESCRIBE — await it so the
          // response doesn't return before the schema is actually persisted.
          // Otherwise the frontend's post-create refetch can land before this
          // background write finishes, showing an empty file list until a
          // manual refresh. Other source types keep this backgrounded —
          // extraction over a large live database can be genuinely slow.
          await registerAndExtract();
        } else {
          registerAndExtract();
        }
      } else if (testedInstance) {
        // No runtime manager to adopt it — release the connected instance.
        try { await testedInstance.disconnect(); } catch { /* ignore */ }
        testedInstance = null;
      }

      progress('done', 'Data source ready');
      return result;
    } catch (error: any) {
      // Persisting failed — release the connected instance we were holding.
      if (testedInstance) {
        try { await testedInstance.disconnect(); } catch { /* ignore */ }
        testedInstance = null;
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Provide a clear message when the same source already exists
      if (errorMsg.includes('already exists')) {
        console.warn(`[PROJECT-SOURCES] Duplicate source detected: ${id}`);
        throw new Error(`This data source is already connected. The same connection configuration already exists in this project.`);
      }
      console.error(`[PROJECT-SOURCES] Create failed:`, errorMsg);
      throw new Error(`Failed to create source: ${errorMsg}`);
    }
    } catch (createError: any) {
      // Upload succeeded but no source record was persisted → the R2 object(s)
      // are orphaned. Remove them (best-effort) before surfacing the original error.
      if (uploadedR2Keys.length > 0 && !sourceRecordCreated) {
        for (const key of uploadedR2Keys) {
          try {
            await deleteFileFromR2(key);
            console.log(`[PROJECT-SOURCES] Cleaned up orphaned R2 upload: ${key}`);
          } catch { /* best-effort */ }
        }
      }
      throw createError;
    }
  });

  // Get all sources for a project
  addSourceOp('getAll', async (params: {
    projectId: string;
    includeInactive?: boolean;
  }) => {
    const { projectId, includeInactive } = params;

    if (!projectId) throw new Error('projectId is required');

    try {
      const result = await sourceService.getProjectSources(projectId, includeInactive);
      const manager = getSourceManager();
      // isExtractingSchema reflects SourceManager's in-memory state directly, so it's correct even
      // after a page reload — the UI shouldn't rely on local component state for this (that state is
      // lost on reload, but an extraction already running on the backend keeps running regardless).
      const data = (result.data || []).map((source: any) => ({
        ...maskSecretFields(source),
        isExtractingSchema: manager?.isSchemaExtractionInFlight(source.id) ?? false,
      }));
      return { ...result, data };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get sources: ${errorMsg}`);
    }
  });

  // Get a single source
  addSourceOp('getOne', async (params: { id: string }) => {
    const { id } = params;
    if (!id) throw new Error('id is required');

    try {
      const result = await sourceService.getProjectSource({ id });
      return { ...result, data: result.data ? maskSecretFields(result.data) : result.data };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get source: ${errorMsg}`);
    }
  });

  // Update specific fields of the Claude-authored semantic model (admin edits).
  // Targeted merge so a single field change never has to round-trip the whole
  // (potentially huge) model and can't clobber the rest of it. Persists to
  // project_sources.semantic_model; live agents pick up edits on next restart
  // (same as the apply-semantic-model workflow).
  addSourceOp('updateSemanticModel', async (params: {
    id: string;
    /** Entity to edit, matched by `name` or `fullName`. */
    entity: string;
    /** Field name to edit; omit for an entity-level edit. */
    field?: string;
    /** Only the keys present are applied. Entity-level: description/summary/synonyms/notes. Field-level: description/valueVocabulary. */
    patch: {
      description?: string;
      summary?: string;
      synonyms?: string[];
      notes?: string;
      valueVocabulary?: any[];
    };
  }) => {
    const { id, entity, field, patch } = params;
    if (!id) throw new Error('id is required');
    if (!entity) throw new Error('entity is required');
    if (!patch || typeof patch !== 'object') throw new Error('patch is required');

    const current = await sourceService.getProjectSource({ id });
    const model = (current.data as any)?.semanticModel;
    if (!model?.entities?.length) {
      throw new Error('This source has no semantic model to edit.');
    }

    // Deep clone so we never mutate the cached DB row in place.
    const next = JSON.parse(JSON.stringify(model));
    const ent = next.entities.find((e: any) => e.name === entity || e.fullName === entity);
    if (!ent) throw new Error(`Entity not found in semantic model: ${entity}`);

    if (field) {
      const f = (ent.fields || []).find((x: any) => x.name === field);
      if (!f) throw new Error(`Field not found: ${entity}.${field}`);
      if (patch.description !== undefined) f.description = patch.description;
      if (patch.valueVocabulary !== undefined) {
        f.semantic = { ...(f.semantic || {}), valueVocabulary: patch.valueVocabulary };
      }
    } else {
      if (patch.description !== undefined) ent.description = patch.description;
      const sem = { ...(ent.semantic || {}) };
      if (patch.summary !== undefined) sem.summary = patch.summary;
      if (patch.synonyms !== undefined) sem.synonyms = patch.synonyms;
      if (patch.notes !== undefined) sem.notes = patch.notes;
      ent.semantic = sem;
    }

    const result = await sourceService.updateSourceSemanticModel(id, next);
    console.log(`[PROJECT-SOURCES] Semantic model edited: ${id} (${field ? `${entity}.${field}` : entity})`);

    // Hot-reload into the live agent without a restart:
    //  1. swap the updated model onto the running instance (synchronous, instant —
    //     so schema formatting / SQL generation use the new text immediately),
    //  2. refresh SDK tools so updated descriptions flow into the tool definitions,
    //  3. re-embed the schema index in the background (force past the freshness
    //     guard) so vector retrieval reflects the edited descriptions/synonyms.
    // All best-effort: the DB write above is the source of truth and must not be
    // undone if the live refresh fails (e.g. no manager / instance not connected).
    const manager = getSourceManager();
    const instance = manager?.getInstance(id);
    if (instance) {
      try {
        instance.applySemanticModel(next);
        sdk.setTools(getAllTools());
        manager!.reembedSource(id).catch((err) =>
          console.warn(`[PROJECT-SOURCES] Semantic model re-embed failed for ${id}:`, err),
        );
        console.log(`[PROJECT-SOURCES] Semantic model hot-reloaded into live instance: ${id}`);
      } catch (hotErr) {
        console.warn(`[PROJECT-SOURCES] Semantic model hot-reload failed for ${id} (persisted to DB; effective on restart):`, hotErr);
      }
    }

    return { success: true, semanticModel: next, data: result.data };
  });

  // Set the SQL write policy for a database source.
  //   read → SELECT only (default) · dml → + INSERT/UPDATE/DELETE · full → + DDL.
  // Persists `writeMode` into the connection config jsonb and hot-reloads it onto
  // the live source instance so the SQL guard's next execute() honors it without a
  // restart. The LLM agent flow only ever generates read-only SQL; raising this is
  // meaningful only for a trusted, non-LLM flow that issues the writes — and the
  // connecting DB role should be scoped to match.
  const WRITE_MODES = ['read', 'dml', 'full'] as const;
  const WRITABLE_SOURCE_TYPES = new Set(['postgres', 'mysql', 'mssql']);

  addSourceOp('setWriteMode', async (params: {
    id: string;
    writeMode: 'read' | 'dml' | 'full';
  }) => {
    const { id, writeMode } = params;
    if (!id) throw new Error('id is required');
    if (!WRITE_MODES.includes(writeMode as any)) {
      throw new Error(`Invalid writeMode "${writeMode}". Expected one of: ${WRITE_MODES.join(', ')}.`);
    }

    const current = await sourceService.getProjectSource({ id });
    if (!current.data) throw new Error(`Source with ID ${id} not found`);
    if (!WRITABLE_SOURCE_TYPES.has(current.data.type)) {
      throw new Error(
        `Write policy is only configurable for database sources (postgres/mysql/mssql); ` +
        `"${current.data.type}" is always read-only.`,
      );
    }

    // Config is stored/replaced wholesale, so read-modify-write the whole object.
    const nextConfig = { ...(current.data.config as Record<string, any>), writeMode };
    const result = await sourceService.updateProjectSource({ id, config: nextConfig });
    console.log(`[PROJECT-SOURCES] Write policy set: ${id} -> ${writeMode}`);

    // Hot-reload onto the live instance so the guard uses the new mode on the next
    // query. Best-effort: the DB write above is the source of truth and stays even
    // if no live instance is registered (it takes effect on the next connect/restart).
    const manager = getSourceManager();
    const instance = manager?.getInstance(id);
    if (instance) {
      try {
        // Surgical single-field mutation — preserves any live-only config state.
        (instance as any).config.config.writeMode = writeMode;
        console.log(`[PROJECT-SOURCES] Write policy hot-reloaded into live instance: ${id} (${writeMode})`);
      } catch (hotErr) {
        console.warn(`[PROJECT-SOURCES] Write policy hot-reload failed for ${id} (persisted to DB; effective on restart):`, hotErr);
      }
    }

    return { success: true, writeMode, data: result.data };
  });

  // Update a source
  addSourceOp('update', async (params: {
    id: string;
    name?: string;
    description?: string;
    config?: Record<string, any>;
    isPrimary?: boolean;
    isActive?: boolean;
  }) => {
    const { id, name, description, isPrimary, isActive } = params;
    let config = params.config;
    if (!id) throw new Error('id is required');

    // If config is being updated, test connectivity with the new config
    if (config) {
      // Get current source to know the type
      const currentSource = await sourceService.getProjectSource({ id });
      if (!currentSource.data) {
        throw new Error(`Source with ID ${id} not found`);
      }

      // The admin dialog prefills from the redacted config we sent and posts the
      // whole thing back, so any secret the client never received arrives as a
      // sentinel. Swap the stored values back in BEFORE the connection test —
      // otherwise the test would dial with a placeholder password, and the write
      // below would overwrite a live credential.
      config = restoreSourceSecrets(config, currentSource.data.config as Record<string, any>);

      const sourceType = currentSource.data.type;

      // A secret field left blank/omitted (because getOne/getAll never send
      // it back) means "unchanged" — fill it from the current stored value
      // rather than testing/persisting a blank one and wiping the real value.
      preserveOmittedSecrets(sourceType, config, currentSource.data.config as Record<string, any>);

      try {
        console.log(`[PROJECT-SOURCES] Testing new config for: ${id} (${sourceType})`);
        const tempConfig = {
          id: 'connection-test-update-' + id,
          projectId: currentSource.data.projectId,
          name: 'Connection Test',
          type: sourceType as any,
          config,
          isPrimary: false,
          isActive: true,
        };
        const instance = sourceRegistry.createInstance(tempConfig);
        await instance.connect();
        const healthy = await instance.healthCheck();
        await instance.disconnect();

        if (!healthy) {
          throw new Error('Connection test failed: health check returned unhealthy');
        }
        console.log(`[PROJECT-SOURCES] New config connection test passed for: ${id}`);
      } catch (connError: any) {
        const connMsg = connError instanceof Error ? connError.message : String(connError);
        console.error(`[PROJECT-SOURCES] Config update connection test failed for ${id}:`, connMsg);
        throw new Error(`Cannot connect with new config: ${connMsg}`);
      }
    }

    try {
      console.log(`[PROJECT-SOURCES] Updating source: ${id}`);

      const manager = getSourceManager();

      // Handle isActive change - disconnect/reconnect the running instance
      if (isActive !== undefined && manager) {
        const currentInstance = manager.getInstance(id);

        if (isActive === false && currentInstance) {
          // Deactivating: disconnect the running instance
          console.log(`[PROJECT-SOURCES] Deactivating source: ${id} - disconnecting instance`);
          await manager.removeSource(id);
        } else if (isActive === true && !currentInstance) {
          // Reactivating: need to reconnect after DB update
          // We'll handle this after the DB update below
        }
      }

      // Update in database
      const result = await sourceService.updateProjectSource({
        id,
        name,
        description,
        config,
        isPrimary,
        isActive,
      });

      // Reload runtime instance in background if config changed or source reactivated
      if (manager && (config || (isActive === true && !manager.getInstance(id)))) {
        const configChanged = !!config;
        (async () => {
          try {
            const sourceData = await sourceService.getProjectSource({ id });
            if (sourceData.data && sourceData.data.isActive) {
              // Remove old instance if exists
              if (manager.getInstance(id)) {
                console.log(`[PROJECT-SOURCES] Removing old instance for config reload: ${id}`);
                await manager.removeSource(id);
              }

              console.log(`[PROJECT-SOURCES] Creating new instance with updated config: ${id}`);
              const sourceConfig = {
                id: sourceData.data.id,
                projectId: sourceData.data.projectId,
                name: sourceData.data.name,
                description: sourceData.data.description,
                type: sourceData.data.type as any,
                config: sourceData.data.config,
                schema: sourceData.data.schema || null,
                isPrimary: sourceData.data.isPrimary,
                isActive: sourceData.data.isActive,
              };
              const instance = await manager.addSource(sourceConfig as any);

              // Re-extract schema if config changed (new tables, etc.). Routed through
              // manager.refreshSchema() (not instance.extractSchema() directly) so it
              // also reconciles the semantic model and re-embeds the schema index.
              if (configChanged) {
                try {
                  const schema = await manager.refreshSchema(id);
                  console.log(`[PROJECT-SOURCES] Schema re-extracted for: ${id} (${schema.entities?.length || 0} entities)`);
                } catch (schemaError) {
                  console.warn(`[PROJECT-SOURCES] Schema re-extraction failed for ${id}:`, schemaError);
                }
              }

              console.log(`[PROJECT-SOURCES] Runtime instance reloaded: ${id}`);

              // Refresh SDK tools with updated source tool
              const updatedTools = getAllTools();
              sdk.setTools(updatedTools);
              console.log(`[PROJECT-SOURCES] SDK tools refreshed after update (${updatedTools.length} total)`);
            }
          } catch (reconnectError) {
            console.error(`[PROJECT-SOURCES] Failed to reload instance for ${id}:`, reconnectError);
          }
        })();
      }

      // Refresh SDK tools for non-config changes (name, isActive toggle off, etc.)
      if (!config && (name || isActive === false)) {
        const updatedTools = getAllTools();
        sdk.setTools(updatedTools);
        console.log(`[PROJECT-SOURCES] SDK tools refreshed after update (${updatedTools.length} total)`);
      }

      // Don't echo the full row back — it carries `config` (secrets, e.g. a
      // NetSuite private key, decrypted for internal use) and `schema` (can be
      // multi-MB for a large source). The caller only needs confirmation +
      // enough fields to refresh a list view, not the connection details.
      const { config: _omitConfig, schema: _omitSchema, ...safeData } = (result.data || {}) as Record<string, any>;
      return { success: result.success, message: result.message, data: safeData };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to update source: ${errorMsg}`);
    }
  });

  // Delete a source
  // Discard an upload that was held at the PII review gate and then DECLINED.
  // No source record was ever persisted — this only deletes the orphaned
  // artifacts the gate's build left behind: the R2 object, the downloaded local
  // file, and the on-disk DuckDB build. All deletes (no reprocessing), so it's
  // fast regardless of file size. Best-effort: never throws back to the UI.
  addSourceOp('discardUpload', async (params: {
    projectId?: string;
    sourceId?: string;
    type?: string;
    r2Key?: string;
    filePath?: string;
    /** Multi-file sources: the full set from the pii_review response. */
    files?: Array<{ r2Key?: string; filePath?: string }>;
  }) => {
    const { projectId, sourceId, type, r2Key, filePath, files } = params;
    console.log(`[PROJECT-SOURCES] Discarding declined upload: ${sourceId || filePath || r2Key || '(unknown)'}`);

    if (r2Key) { try { await deleteFileFromR2(r2Key); } catch (e) { console.warn('[PROJECT-SOURCES] discard: R2 delete failed:', e); } }
    if (filePath && isUploadedFile(filePath)) { try { deleteUploadedFile(filePath); } catch (e) { console.warn('[PROJECT-SOURCES] discard: local delete failed:', e); } }
    for (const f of files || []) {
      if (f.r2Key) { try { await deleteFileFromR2(f.r2Key); } catch (e) { console.warn('[PROJECT-SOURCES] discard: R2 delete failed:', e); } }
      if (f.filePath && isUploadedFile(f.filePath)) { try { deleteUploadedFile(f.filePath); } catch (e) { console.warn('[PROJECT-SOURCES] discard: local delete failed:', e); } }
    }
    if (projectId && sourceId && (type === 'excel' || type === 'csv')) {
      try { deleteSourceDbFile(projectId, sourceId); } catch { /* ignore */ }
      try { deleteSourceCsvDir(projectId, sourceId); } catch { /* ignore */ }
      try { deleteSourceMeta(projectId, sourceId); } catch { /* ignore */ }
    }

    return { success: true };
  });

  addSourceOp('delete', async (params: { id: string }) => {
    const { id } = params;
    if (!id) throw new Error('id is required');

    try {
      console.log(`[PROJECT-SOURCES] Deleting source: ${id}`);

      // Fetch source data before removing anything (needed for cleanup paths).
      let sourceData: Awaited<ReturnType<typeof sourceService.getProjectSource>> | null = null;
      try {
        sourceData = await sourceService.getProjectSource({ id });
      } catch {
        // Non-critical — proceed even if we can't read source data
      }

      // Disconnect from manager first — this closes DuckDB and releases file locks.
      // File cleanup must happen after so unlinkSync doesn't hit EBUSY.
      const manager = getSourceManager();
      if (manager) {
        await manager.removeSource(id);
      }

      // Clean up uploaded file(s) and on-disk DuckDB file.
      try {
        if (sourceData?.data) {
          const cfg = sourceData.data.config as any;
          const filePath = cfg?.filePath;
          if (filePath && isUploadedFile(filePath)) {
            deleteUploadedFile(filePath);
          }
          if (sourceData.data.type === 'excel' || sourceData.data.type === 'csv') {
            deleteSourceDbFile(sourceData.data.projectId, id);
          }
          // Remove the uploaded file(s) from R2 (best-effort, proxied via the worker).
          // Failure only orphans the object — it must not block deleting the record.
          if (cfg?.r2Key) await deleteFileFromR2(cfg.r2Key);
          for (const f of cfg?.files || []) {
            if (f.filePath && isUploadedFile(f.filePath)) deleteUploadedFile(f.filePath);
            if (f.r2Key) await deleteFileFromR2(f.r2Key);
          }
        }
      } catch {
        // Non-critical — proceed with deletion even if cleanup fails
      }

      const result = await sourceService.deleteProjectSource({ id });

      // Refresh SDK tools so the removed source's tool is no longer available to LLM
      const updatedTools = getAllTools();
      sdk.setTools(updatedTools);
      console.log(`[PROJECT-SOURCES] SDK tools refreshed after delete (${updatedTools.length} total)`);

      return result;
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete source: ${errorMsg}`);
    }
  });

  // ============================================
  // Source Operations
  // ============================================

  // Test connection to a source
  addSourceOp('testConnection', async (params: {
    type: string;
    config: Record<string, any>;
  }) => {
    const { type, config } = params;

    if (!type) throw new Error('type is required');
    if (!config) throw new Error('config is required');

    // Lazy-load the module if it's a known type but not yet registered
    if (!sourceRegistry.isSupported(type) && isSourceTypeSupported(type)) {
      await loadModule(type);
    }

    if (!sourceRegistry.isSupported(type)) {
      return { success: false, error: `Unsupported source type: ${type}` };
    }

    // Validate config first
    const validation = sourceRegistry.validateConfig(type as any, config);
    if (!validation.valid) {
      return { success: false, error: `Invalid config: ${validation.errors?.join(', ')}` };
    }

    try {
      // Create temporary instance to test
      const tempConfig = {
        id: 'temp-test',
        projectId: 'temp',
        name: 'Test Connection',
        type: type as any,
        config,
        isPrimary: false,
        isActive: true,
      };

      const instance = sourceRegistry.createInstance(tempConfig);
      await instance.connect();
      const healthy = await instance.healthCheck();
      await instance.disconnect();

      return { success: healthy, message: healthy ? 'Connection successful' : 'Health check failed' };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  });

  // Extract schema from a source. `clientId` is optional and only used for NetSuite's background
  // completion push (see below) — every other source type ignores it and behaves exactly as before.
  addSourceOp('extractSchema', async (params: { id: string; clientId?: string }) => {
    const { id, clientId } = params;
    if (!id) throw new Error('id is required');

    const manager = getSourceManager();
    if (!manager) {
      throw new Error('Source manager not initialized');
    }

    const instance = manager.getInstance(id);

    // Sources that implement estimateExtractionTime() (NetSuite, Postgres, MySQL, MSSQL — see
    // SourceInstance.estimateExtractionTime) get a fast count/status message back immediately,
    // with the real extraction continuing in the background — matters most for NetSuite (30-60+
    // min via per-table probing) but is harmless and consistent for the others too (their fast
    // catalog-query estimate essentially completes alongside the real extraction anyway). A source
    // type without it keeps the old fully-blocking path below.
    if (instance && typeof instance.estimateExtractionTime === 'function') {
      if (manager.isSchemaExtractionInFlight(id)) {
        return { success: false, alreadyInProgress: true, message: 'Extraction is already in progress for this source — wait for it to finish before starting another.' };
      }

      const { candidateCount, message, estimatedMinutes } = await instance.estimateExtractionTime();
      console.log(`[PROJECT-SOURCES] Extracting schema for: ${id} — ${candidateCount} candidate table(s), running in background`);

      manager.refreshSchema(id)
        .then((schema) => {
          console.log(`[PROJECT-SOURCES] Background schema extraction finished for ${id}: ${schema.entities.length} entities`);
          sendSchemaExtractionEvent(clientId, id, 'SCHEMA_EXTRACTION_DONE', { entityCount: schema.entities.length });
        })
        .catch((error: any) => {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`[PROJECT-SOURCES] Background schema extraction failed for ${id}: ${errorMsg}`);
          sendSchemaExtractionEvent(clientId, id, 'SCHEMA_EXTRACTION_FAILED', { error: errorMsg });
        });

      return { success: true, started: true, candidateCount, estimatedMinutes, message };
    }

    try {
      console.log(`[PROJECT-SOURCES] Extracting schema for: ${id}`);
      const schema = await manager.refreshSchema(id);
      return { success: true, schema, message: `Extracted ${schema.entities.length} entities` };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to extract schema: ${errorMsg}`);
    }
  });

  // Set primary source
  addSourceOp('setPrimary', async (params: { id: string }) => {
    const { id } = params;
    if (!id) throw new Error('id is required');

    try {
      const result = await sourceService.setPrimarySource(id);
      return result;
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to set primary: ${errorMsg}`);
    }
  });

  // Get health status of all sources
  addSourceOp('healthCheck', async () => {
    const manager = getSourceManager();
    if (!manager) {
      return { success: false, error: 'Source manager not initialized', sources: [] };
    }

    const healthResults = await manager.healthCheckAll();
    const sources = Array.from(healthResults.entries()).map(([id, healthy]) => ({
      id,
      healthy,
    }));

    return { success: true, sources };
  });

  // ============================================
  // Module Info
  // ============================================

  // Get supported source types
  addSourceOp('getSupportedTypes', async () => {
    const modules = sourceRegistry.getModulesInfo();
    return { success: true, data: modules };
  });

  // Get config fields for a type
  addSourceOp('getConfigFields', async (params: { type: string }) => {
    const { type } = params;
    if (!type) throw new Error('type is required');

    const fields = sourceRegistry.getConfigFields(type as any);
    return { success: true, data: fields };
  });

  // ============================================
  // Activate / Deactivate Operations
  // ============================================

  // Deactivate a source (keeps in DB but disconnects and hides from LLM)
  addSourceOp('deactivate', async (params: { id: string }) => {
    const { id } = params;
    if (!id) throw new Error('id is required');

    try {
      const manager = getSourceManager();

      // Disconnect the running instance if active
      if (manager) {
        const instance = manager.getInstance(id);
        if (instance) {
          console.log(`[PROJECT-SOURCES] Deactivating source: ${id} - disconnecting instance`);
          await manager.removeSource(id);
        }
      }

      // Update database
      const result = await sourceService.updateProjectSource({
        id,
        isActive: false,
      });

      console.log(`[PROJECT-SOURCES] ✓ Source deactivated: ${id}`);
      return {
        success: true,
        message: `Source '${id}' has been deactivated. It will no longer be available to the LLM.`,
        data: result.data,
      };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to deactivate source: ${errorMsg}`);
    }
  });

  // Activate a source (reconnects and makes available to LLM)
  addSourceOp('activate', async (params: { id: string }) => {
    const { id } = params;
    if (!id) throw new Error('id is required');

    try {
      // Update database first
      const result = await sourceService.updateProjectSource({
        id,
        isActive: true,
      });

      // Get the full source data and reconnect
      const manager = getSourceManager();
      if (manager && !manager.getInstance(id)) {
        const sourceData = await sourceService.getProjectSource({ id });
        if (sourceData.data) {
          console.log(`[PROJECT-SOURCES] Activating source: ${id} - connecting instance`);
          const sourceConfig = {
            id: sourceData.data.id,
            projectId: sourceData.data.projectId,
            name: sourceData.data.name,
            description: sourceData.data.description,
            type: sourceData.data.type as any,
            config: sourceData.data.config,
            schema: sourceData.data.schema || null,
            isPrimary: sourceData.data.isPrimary,
            isActive: sourceData.data.isActive,
          };
          await manager.addSource(sourceConfig as any);
          console.log(`[PROJECT-SOURCES] ✓ Source activated: ${id}`);
        }
      }

      return {
        success: true,
        message: `Source '${id}' has been activated. It is now available to the LLM.`,
        data: result.data,
      };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to activate source: ${errorMsg}`);
    }
  });

  // Refresh a file-based source. Two flavors via the same endpoint:
  //   1. No fileData → re-reads the existing file (or re-downloads URL) and rebuilds DuckDB.
  //   2. fileData + fileName → replaces the underlying file (keeping source ID stable),
  //      optionally renames the source via `name`, and returns a schemaDrift report
  //      so the UI can warn when columns/sheets have changed.
  addSourceOp('refreshSource', async (params: {
    id: string;
    fileData?: string;
    fileName?: string;
    r2Key?: string;
    name?: string;
    /** Opt-in: screen the NEW file for PII before committing the replace. */
    piiDetection?: boolean;
    /** Set on the confirm re-call after the user reviews the PII prompt. */
    piiAcknowledged?: boolean;
    /** Per-column PII policy chosen for the new file (replaces any prior policy). */
    redactColumns?: Array<{ entity: string; column: string }>;
    dropColumns?: Array<{ entity: string; column: string }>;
    /** Browser clientId + uploadId for live progress events (optional). */
    clientId?: string;
    uploadId?: string;
    /** Identity of whoever triggered this refresh — stamped as createdBy/updatedBy on the audit trail (csv only, for now). */
    userId?: string;
    /** CSV sources only: add new files to the batch. */
    filesToAdd?: Array<{ r2Key: string; fileName: string }>;
    /** CSV sources only: remove files by their current table name. */
    filesToRemove?: string[];
    /** CSV sources only: replace a file's content, keeping its table name. */
    filesToReplace?: Array<{ tableName: string; r2Key: string; fileName: string }>;
  }) => {
    const { id, fileData, fileName, r2Key, name, filesToAdd, filesToRemove, filesToReplace } = params;
    const progress = (step: string, message: string, extra?: Record<string, any>) =>
      sendUploadProgress(params.clientId, params.uploadId, step, message, extra);

    if (!id) throw new Error('id is required');

    const sourceData = await sourceService.getProjectSource({ id });
    if (!sourceData.data) {
      throw new Error(`Source with ID ${id} not found`);
    }

    const source = sourceData.data;
    const sourceType = source.type;

    if (sourceType !== 'excel' && sourceType !== 'csv') {
      throw new Error(`refreshSource is only supported for excel and csv sources, not ${sourceType}`);
    }

    const isReplacingFile = !!(fileData && fileName) || !!r2Key;
    const hasBatchOp = !!(filesToAdd?.length || filesToRemove?.length || filesToReplace?.length);
    if (hasBatchOp && sourceType !== 'csv') {
      throw new Error('filesToAdd/filesToRemove/filesToReplace is only supported for csv sources');
    }
    if (hasBatchOp && isReplacingFile) {
      throw new Error('Cannot combine a whole-file replace with filesToAdd/filesToRemove/filesToReplace');
    }
    const oldSchema = (isReplacingFile || hasBatchOp) ? (source.schema as SourceSchema | null) : null;

    try {
      const manager = getSourceManager();
      if (!manager) throw new Error('Source manager not initialized');

      const instance = manager.getInstance(id);
      if (!instance) throw new Error(`Source instance not found for: ${id}`);

      if (hasBatchOp) {
        console.log(`[PROJECT-SOURCES] Batch file update for source: ${id} (${source.name})`);

        const existingConfig = source.config as Record<string, any>;
        let files: Array<{ fileName: string; filePath: string; r2Key?: string; tableName?: string }> =
          Array.isArray(existingConfig.files) && existingConfig.files.length > 0
            ? existingConfig.files.map((f: any) => ({ ...f }))
            : existingConfig.filePath
              ? [{
                  fileName: path.basename(existingConfig.filePath),
                  filePath: existingConfig.filePath,
                  r2Key: existingConfig.r2Key,
                  tableName: (source.schema as SourceSchema | null)?.entities?.[0]?.name,
                }]
              : [];

        const r2KeysToDeleteOnSuccess: string[] = [];
        const r2KeysToCleanupOnFailure: string[] = [];
        // New/replaced files, validated + tagged for PII before the swap commits.
        const changedEntries: Array<{ filePath: string; tableName: string }> = [];

        if (filesToRemove?.length) {
          const removeSet = new Set(filesToRemove);
          const kept: typeof files = [];
          for (const f of files) {
            if (f.tableName && removeSet.has(f.tableName)) {
              if (f.r2Key) r2KeysToDeleteOnSuccess.push(f.r2Key);
              if (f.filePath && isUploadedFile(f.filePath)) deleteUploadedFile(f.filePath);
            } else {
              kept.push(f);
            }
          }
          files = kept;
          if (files.length === 0) {
            throw new Error('Cannot remove the last file from a source — delete the source instead');
          }
        }

        try {
          if (filesToReplace?.length) {
            for (const rep of filesToReplace) {
              const idx = files.findIndex(f => f.tableName === rep.tableName);
              if (idx === -1) throw new Error(`filesToReplace: no existing file for table "${rep.tableName}"`);
              progress('downloading', `Fetching ${rep.fileName}…`);
              const oldEntry = files[idx];
              const newPath = await downloadFileFromR2(rep.r2Key, source.projectId, id, rep.fileName, `r${idx}`);
              r2KeysToCleanupOnFailure.push(rep.r2Key);
              files[idx] = { fileName: rep.fileName, filePath: newPath, r2Key: rep.r2Key, tableName: rep.tableName };
              changedEntries.push({ filePath: newPath, tableName: rep.tableName });
              if (oldEntry.r2Key && oldEntry.r2Key !== rep.r2Key) r2KeysToDeleteOnSuccess.push(oldEntry.r2Key);
              if (oldEntry.filePath && oldEntry.filePath !== newPath && isUploadedFile(oldEntry.filePath)) {
                deleteUploadedFile(oldEntry.filePath);
              }
            }
          }

          if (filesToAdd?.length) {
            if (files.length + filesToAdd.length > MAX_FILES_PER_SOURCE) {
              throw new Error(`Too many files (${files.length + filesToAdd.length}). Maximum is ${MAX_FILES_PER_SOURCE} per source.`);
            }
            const usedNames = new Set(files.map(f => f.tableName).filter(Boolean) as string[]);
            progress('downloading', `Fetching ${filesToAdd.length} new file(s)…`);
            for (let i = 0; i < filesToAdd.length; i++) {
              const add = filesToAdd[i];
              const newPath = await downloadFileFromR2(add.r2Key, source.projectId, id, add.fileName, `a${i}`);
              r2KeysToCleanupOnFailure.push(add.r2Key);
              const tableName = dedupeTableName(baseTableName(add.fileName), usedNames);
              usedNames.add(tableName);
              files.push({ fileName: add.fileName, filePath: newPath, r2Key: add.r2Key, tableName });
              changedEntries.push({ filePath: newPath, tableName });
            }
          }

          // Readability check on the changed files — cheap head-read via fast-csv,
          // catches an unparseable upload before it's committed. The full load
          // (and any PII masking) still happens in instance.refresh() below.
          for (const entry of changedEntries) {
            const sample = await sampleCsvEntity(entry.filePath, entry.tableName, existingConfig.delimiter, existingConfig.hasHeader !== false);
            if (!sample) throw new Error(`"${entry.tableName}" appears to be empty or has no header row`);
          }

          if (params.piiDetection && !params.piiAcknowledged && changedEntries.length > 0) {
            const sampled = await sampleMultipleCsvs(changedEntries, existingConfig.delimiter, existingConfig.hasHeader);
            progress('scanning', 'Scanning for personal information…');
            const piiFindings = await detectPII(sampled);
            if (piiFindings.length > 0) {
              progress('review', `Potential PII found in ${piiFindings.length} column(s) — review needed`);
              // Nothing committed yet — new/replaced R2 objects are left in place
              // for the confirm re-call to reuse; discardUpload cleans them up if declined.
              return {
                success: false,
                status: 'pii_review',
                message: `Potential PII detected in ${piiFindings.length} column(s). Confirm to proceed.`,
                piiFindings,
                sourceId: id,
                files: [...r2KeysToCleanupOnFailure].map(k => ({ r2Key: k })),
              };
            }
          }
        } catch (err) {
          for (const key of r2KeysToCleanupOnFailure) { try { await deleteFileFromR2(key); } catch { /* best-effort */ } }
          throw err;
        }

        if (Array.isArray(params.redactColumns)) (existingConfig as any).redactColumns = params.redactColumns;
        if (Array.isArray(params.dropColumns)) (existingConfig as any).dropColumns = params.dropColumns;

        const newConfig: Record<string, any> = { ...existingConfig, files };
        delete newConfig.filePath;
        delete newConfig.r2Key;

        await sourceService.updateProjectSource({ id, config: newConfig, ...(name ? { name } : {}) });
        for (const key of r2KeysToDeleteOnSuccess) { try { await deleteFileFromR2(key); } catch { /* best-effort */ } }

        (instance as any).config.config = newConfig;
        if (name) (instance as any).config.name = name;

        progress('building', 'Loading the data into the database…');
        (instance as any).onLoadProgress = loadProgressSink(progress);
        if (params.userId) (instance as any).currentActor = params.userId;
        await (instance as any).refresh();
        progress('extracting', 'Finalizing & extracting schema…');

        // connect() (inside refresh(), just above) assigned sourceRowId /
        // createdAt / updatedAt / fingerprint on newConfig.files in place — but
        // newConfig was persisted BEFORE refresh() ran, so that's not captured
        // yet. Persist it again now, or the audit trail for new/changed files
        // never reaches Postgres and gets regenerated (wrongly) next rebuild.
        await sourceService.updateProjectSource({ id, config: newConfig });

        let newSchema: SourceSchema | null = instance.getSchema();
        if (!newSchema) {
          newSchema = await instance.extractSchema();
          await sourceService.updateSourceSchema(id, newSchema);
        }
        const schemaDrift = newSchema ? computeSchemaDrift(oldSchema, newSchema) : null;

        const updatedTools = getAllTools();
        sdk.setTools(updatedTools);

        progress('done', 'Data source refreshed');
        return {
          success: true,
          message: `Source '${name || source.name}' refreshed successfully. Data has been reloaded.`,
          schemaDrift,
        };
      }

      // File replacement path: save new → validate → swap. The old file is only
      // deleted after the new one has been verified loadable, so a corrupt upload
      // can't leave the source in a broken state.
      if (isReplacingFile) {
        console.log(`[PROJECT-SOURCES] Re-uploading file for source: ${id} (${source.name})`);

        const oldFilePath = (source.config as any).filePath as string | undefined;
        // Capture the previous R2 key before it's overwritten below, so we can
        // clean up the now-orphaned object once the swap commits.
        const oldR2Key = (source.config as any).r2Key as string | undefined;

        // 1. Save the new file. Same sourceId → if the filename matches the old
        //    one this overwrites in place; otherwise old and new sit side by side
        //    on disk until validation decides which survives.
        //    Two paths: base64 (legacy, ≤100MB) and r2Key (R2 multipart, no size cap).
        if (r2Key) progress('downloading', 'Fetching the uploaded file…');
        const newFilePath = r2Key
          ? await downloadFileFromR2(r2Key, source.projectId, id, fileName)
          : saveUploadedFile(fileData!, fileName!, source.projectId, id);
        const newConfig: Record<string, any> = {
          ...(source.config as Record<string, any>),
          filePath: newFilePath,
        };
        // Keep r2Key in config for future rehydration; clear it if this refresh
        // came from a base64 upload (the local file is now canonical).
        if (r2Key) newConfig.r2Key = r2Key;
        else delete newConfig.r2Key;

        // The new file gets a fresh PII policy — clear anything inherited from the
        // old file (its columns may differ).
        delete newConfig.redactColumns;
        delete newConfig.dropColumns;

        // PII detection gate on the NEW file (opt-in). Sample its head and, if PII
        // is found and not yet acknowledged, return for review WITHOUT committing the
        // swap — the live source keeps serving its current data until confirmed.
        if (params.piiDetection && !params.piiAcknowledged) {
          try {
            let sampled;
            if (sourceType === 'excel') {
              const converted = await ensureXlsxConverted(newFilePath, source.projectId, id, {
                sheets: newConfig.sheets,
                logPrefix: '[PROJECT-SOURCES]',
                onProgress: convertProgressSink(progress),
              }, r2Key);
              sampled = await sampleConvertedCsvs(converted);
            } else {
              sampled = await sampleSchemaForPII(newFilePath, 'csv', {
                delimiter: newConfig.delimiter,
                hasHeader: newConfig.hasHeader,
              });
            }
            progress('scanning', 'Scanning for personal information…');
            const piiFindings = await detectPII(sampled);
            if (piiFindings.length > 0) {
              progress('review', `Potential PII found in ${piiFindings.length} column(s) — review needed`);
              console.log(`[PROJECT-SOURCES] PII detected in ${piiFindings.length} column(s) on re-upload for "${source.name}" — awaiting confirmation`);
              return {
                success: false,
                status: 'pii_review',
                message: `Potential PII detected in ${piiFindings.length} column(s). Confirm to proceed.`,
                piiFindings,
                sourceId: id,
                r2Key,
                filePath: newFilePath,
              };
            }
            console.log(`[PROJECT-SOURCES] PII scan clean on re-upload for "${source.name}" — proceeding`);
          } catch (piiErr) {
            // Fail-open: a scan error must never block a legitimate re-upload.
            console.warn(`[PROJECT-SOURCES] PII re-upload scan failed for "${source.name}", proceeding without gate:`, piiErr);
          }
        }

        // Apply the chosen PII policy from the confirm re-call.
        if (Array.isArray(params.redactColumns) && params.redactColumns.length > 0) {
          newConfig.redactColumns = params.redactColumns;
        }
        if (Array.isArray(params.dropColumns) && params.dropColumns.length > 0) {
          newConfig.dropColumns = params.dropColumns;
        }

        // 2. Validate by spinning up a temp instance with the new path — UNLESS the
        //    PII gate already ran. The gate converts (Excel) / reads (CSV) the new
        //    file successfully, which is itself the validation, and the rebuild
        //    below reuses that conversion. Skipping it avoids converting the
        //    workbook a second time. (Temp uses a distinct id so its .duckdb never
        //    collides with the real source's still-live one.)
        if (!params.piiDetection) {
          try {
            if (sourceType === 'excel') {
              // Convert the workbook ONCE, into THIS source's CSV dir. This both
              // validates that it parses AND caches the per-sheet CSVs (keyed on
              // r2Key), so refresh() below REUSES them instead of converting a
              // second time. (Previously a temp instance with a different id
              // converted to its own dir, double-converting large files.)
              await ensureXlsxConverted(newFilePath, source.projectId, id, {
                sheets: newConfig.sheets,
                logPrefix: '[PROJECT-SOURCES]',
                onProgress: convertProgressSink(progress),
              }, r2Key);
            } else {
              // CSV has no conversion step to share — validate it loads via a
              // throwaway temp instance (distinct id so its .duckdb never collides
              // with the live source's still-open one). Cheap relative to xlsx.
              const tempConfig = {
                id: 'connection-test-replace-' + id,
                projectId: source.projectId,
                name: 'File Replace Test',
                type: sourceType as any,
                config: newConfig,
                isPrimary: false,
                isActive: true,
              };
              const tempInstance = sourceRegistry.createInstance(tempConfig);
              (tempInstance as any).onLoadProgress = loadProgressSink(progress);
              await tempInstance.connect();
              const healthy = await tempInstance.healthCheck();
              await tempInstance.disconnect();
              if (!healthy) throw new Error('Health check returned unhealthy');
            }
          } catch (validErr: any) {
            const msg = validErr instanceof Error ? validErr.message : String(validErr);
            // Roll back the new file only if it didn't overwrite the old one
            if (oldFilePath && newFilePath !== oldFilePath && isUploadedFile(newFilePath)) {
              deleteUploadedFile(newFilePath);
            }
            throw new Error(`Uploaded file is not valid: ${msg}`);
          }
        }

        // 3. Validation passed — commit the swap.
        if (oldFilePath && oldFilePath !== newFilePath && isUploadedFile(oldFilePath)) {
          deleteUploadedFile(oldFilePath);
        }
        await sourceService.updateProjectSource({
          id,
          config: newConfig,
          ...(name ? { name } : {}),
        });

        // The new file is committed — drop the previous R2 object if it changed
        // (R2→R2 replace) or was dropped entirely (R2→base64 replace). Best-effort.
        if (oldR2Key && oldR2Key !== r2Key) {
          await deleteFileFromR2(oldR2Key);
        }

        // Mutate the live instance so refresh() below uses the new config
        (instance as any).config.config = newConfig;
        if (name) (instance as any).config.name = name;

        console.log(`[PROJECT-SOURCES] New file saved: ${newFilePath}`);
      }

      // Rebuild DuckDB from the (possibly new) file
      console.log(`[PROJECT-SOURCES] Refreshing source: ${name || source.name}`);
      progress('building', 'Loading the data into the database…');
      (instance as any).onConvertProgress = convertProgressSink(progress);
      (instance as any).onRedactProgress = redactProgressSink(progress);
      (instance as any).onLoadProgress = loadProgressSink(progress);
      if (params.userId) (instance as any).currentActor = params.userId;
      await (instance as any).refresh();
      progress('extracting', 'Finalizing & extracting schema…');

      // refresh() above already ran the post-refresh hook, which re-extracted the
      // schema (cached on the instance via setSchema), persisted it, and refreshed
      // SDK tools. Reuse that cached schema for the drift check instead of calling
      // extractSchema() again — it rescans every sheet, so re-extracting here
      // doubled the schema work on large files. Fall back to a one-off extract only
      // if the hook didn't produce one (e.g. it isn't wired for this instance).
      let newSchema: SourceSchema | null = instance.getSchema();
      if (!newSchema) {
        try {
          newSchema = await instance.extractSchema();
          await sourceService.updateSourceSchema(id, newSchema);
        } catch (schemaError) {
          console.warn(`[PROJECT-SOURCES] Schema extraction failed after refresh for ${source.name}:`, schemaError);
        }
      }
      if (newSchema) {
        console.log(`[PROJECT-SOURCES] Schema after refresh: ${name || source.name} (${newSchema.entities?.length || 0} entities)`);
      }

      // Compute drift only when we actually replaced the file
      const schemaDrift = isReplacingFile && newSchema
        ? computeSchemaDrift(oldSchema, newSchema)
        : null;

      // Refresh SDK tools
      const updatedTools = getAllTools();
      sdk.setTools(updatedTools);

      progress('done', 'Data source refreshed');
      return {
        success: true,
        message: `Source '${name || source.name}' refreshed successfully. Data has been reloaded.`,
        schemaDrift,
      };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[PROJECT-SOURCES] Refresh failed for ${id}:`, errorMsg);
      throw new Error(`Failed to refresh source: ${errorMsg}`);
    }
  });

  // ============================================
  // Data Viewer Operations
  // ============================================

  // Get browseable entities (tables/sheets/endpoints) for a source
  addSourceOp('getEntities', async (params: { sourceId: string }) => {
    const { sourceId } = params;
    if (!sourceId) throw new Error('sourceId is required');

    try {
      const manager = getSourceManager();
      let schema: any = null;
      let sourceType: string = '';

      // Try runtime instance first
      if (manager) {
        const instance = manager.getInstance(sourceId);
        if (instance) {
          schema = instance.getSchema();
          sourceType = instance.getType();
        }
      }

      // Fall back to DB if no runtime instance or no cached schema
      if (!schema) {
        const sourceData = await sourceService.getProjectSource({ id: sourceId });
        if (!sourceData.data) throw new Error(`Source not found: ${sourceId}`);
        schema = sourceData.data.schema;
        sourceType = sourceData.data.type;
      }

      if (!schema || !schema.entities || schema.entities.length === 0) {
        return { success: true, sourceType, entities: [] };
      }

      const entities = schema.entities.map((entity: any) => ({
        name: entity.name,
        fullName: entity.fullName || entity.name,
        fieldCount: entity.fields?.length || 0,
        rowCount: entity.rowCount,
        description: entity.description,
      }));

      return { success: true, sourceType, entities };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get entities: ${errorMsg}`);
    }
  });

  // Get paginated data from an entity (table/sheet/endpoint)
  addSourceOp('getEntityData', async (params: {
    sourceId: string;
    entityName: string;
    page?: number;
    pageSize?: number;
    sortColumn?: string;
    sortDirection?: 'asc' | 'desc';
    search?: string;
  }) => {
    const { sourceId, entityName } = params;
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 50));
    const sortColumn = params.sortColumn || null;
    const sortDirection = params.sortDirection || 'asc';
    const search = params.search?.trim() || '';

    if (!sourceId) throw new Error('sourceId is required');
    if (!entityName) throw new Error('entityName is required');

    const manager = getSourceManager();
    if (!manager) throw new Error('Source manager not initialized');

    const instance = manager.getInstance(sourceId);
    if (!instance) throw new Error(`Source instance not found: ${sourceId}`);

    const sourceType = instance.getType();
    const schema = instance.getSchema();

    // Get column metadata from schema
    const entity = schema?.entities?.find(
      (e: any) => e.name === entityName || e.fullName === entityName
    );
    const columns = (entity?.fields || []).map((f: any) => ({
      name: f.name,
      type: f.type,
      nativeType: f.nativeType,
      isPrimaryKey: f.isPrimaryKey || false,
    }));

    const sqlSourceTypes = ['postgres', 'mysql', 'mssql', 'netsuite', 'csv', 'excel'];

    if (sqlSourceTypes.includes(sourceType)) {
      // SQL-based sources: build SELECT query with pagination
      const offset = (page - 1) * pageSize;

      // Quote identifier based on source type
      const qi = (name: string) => {
        if (sourceType === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
        if (sourceType === 'mssql') return '[' + name.replace(/\]/g, ']]') + ']';
        return '"' + name.replace(/"/g, '""') + '"';
      };

      // Use fullName for schema-qualified names, else just quoted name
      const tableName = entity?.fullName && entity.fullName !== entity.name
        ? entity.fullName.split('.').map((p: string) => qi(p)).join('.')
        : qi(entityName);

      // Build WHERE clause for search
      let whereClause = '';
      if (search && columns.length > 0) {
        // Text AND numeric columns — an id/trip-id searched by value is very
        // often a numeric column, and CAST(... AS VARCHAR) below works for
        // either. Restricting this to text-only columns meant searching a
        // numeric value (e.g. a trip id) silently never matched anything.
        const searchableCols = columns.filter((c: any) => {
          const t = `${c.type || ''} ${c.nativeType || ''}`.toLowerCase();
          return ['string', 'text', 'varchar', 'char', 'int', 'numeric', 'decimal', 'float', 'double', 'bigint', 'serial']
            .some(k => t.includes(k));
        });
        const searchCols = searchableCols.length > 0 ? searchableCols : columns.slice(0, 10);
        const conditions = searchCols.map((c: any) => {
          const colRef = `CAST(${qi(c.name)} AS VARCHAR)`;
          const escaped = search.replace(/'/g, "''");
          if (sourceType === 'mysql') {
            return `CAST(${qi(c.name)} AS CHAR) LIKE '%${escaped}%'`;
          }
          if (sourceType === 'mssql') {
            // MSSQL has no ILIKE operator — LIKE is already case-insensitive
            // under the default (case-insensitive) collation used here.
            return `${colRef} LIKE '%${escaped}%'`;
          }
          if (sourceType === 'netsuite') {
            // SuiteQL (Oracle-style) has no ILIKE operator either, and LIKE is
            // case-sensitive by default — wrap both sides in UPPER() instead.
            // Never CAST here: confirmed this account's SuiteQL endpoint
            // rejects CAST(...) of any target type outright, even with no
            // aggregate involved (500 Internal Server Error) — fields already
            // come back as text-comparable values, so use the column bare.
            return `UPPER(${qi(c.name)}) LIKE UPPER('%${escaped}%')`;
          }
          return `${colRef} ILIKE '%${escaped}%'`;
        });
        if (conditions.length > 0) {
          whereClause = `WHERE ${conditions.join(' OR ')}`;
        }
      }

      // Build ORDER BY
      let orderClause = '';
      if (sortColumn) {
        const dir = sortDirection === 'desc' ? 'DESC' : 'ASC';
        orderClause = `ORDER BY ${qi(sortColumn)} ${dir}`;
      }

      // Fetch pageSize + 1 rows to detect if there's a next page (avoids COUNT(*))
      const fetchSize = pageSize + 1;
      let limitClause: string;
      if (sourceType === 'mssql') {
        // MSSQL requires ORDER BY for OFFSET/FETCH
        if (!orderClause) orderClause = 'ORDER BY (SELECT NULL)';
        limitClause = `OFFSET ${offset} ROWS FETCH NEXT ${fetchSize} ROWS ONLY`;
      } else if (sourceType === 'netsuite') {
        // SuiteQL (Oracle-style) has no LIMIT/OFFSET keywords — same
        // OFFSET...FETCH NEXT syntax as MSSQL, but no ORDER BY requirement.
        limitClause = `OFFSET ${offset} ROWS FETCH NEXT ${fetchSize} ROWS ONLY`;
      } else {
        limitClause = `LIMIT ${fetchSize} OFFSET ${offset}`;
      }

      try {
        const dataSql = `SELECT * FROM ${tableName} ${whereClause} ${orderClause} ${limitClause}`;
        const dataResult = await runAsSystem('admin-table-browse', () => instance.execute({ sql: dataSql }));
        const allRows = dataResult.data || [];

        // If we got more than pageSize rows, there's a next page
        const hasNext = allRows.length > pageSize;
        const rows = hasNext ? allRows.slice(0, pageSize) : allRows;
        const hasPrev = page > 1;

        // Use approximate row count from schema (free, no query)
        const approxTotalRows = entity?.rowCount ?? null;

        return {
          success: true,
          columns,
          rows,
          pagination: {
            page,
            pageSize,
            hasNext,
            hasPrev,
            approxTotalRows,
          },
          metadata: {
            executionTime: dataResult.metadata?.executionTime || 0,
            sourceType,
          },
        };
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`Query failed: ${errorMsg}`);
      }
    } else {
      // Non-SQL sources (rest_api, graphql): execute and paginate in-memory
      try {
        const executeParams: any = {};
        if (sourceType === 'rest_api') {
          executeParams.endpoint = entityName;
        } else if (sourceType === 'graphql') {
          executeParams.operation = entityName;
        }

        const result = await runAsSystem('admin-entity-browse', () => instance.execute(executeParams));
        let data = result.data || [];

        // Apply search filter in-memory
        if (search) {
          const lowerSearch = search.toLowerCase();
          data = data.filter((row: any) =>
            Object.values(row).some(val =>
              val != null && String(val).toLowerCase().includes(lowerSearch)
            )
          );
        }

        // Apply sort in-memory
        if (sortColumn) {
          data.sort((a: any, b: any) => {
            const aVal = a[sortColumn] ?? '';
            const bVal = b[sortColumn] ?? '';
            const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
            return sortDirection === 'desc' ? -cmp : cmp;
          });
        }

        // Apply pagination in-memory
        const offset = (page - 1) * pageSize;
        const pagedData = data.slice(offset, offset + pageSize);
        const hasNext = data.length > offset + pageSize;
        const hasPrev = page > 1;

        // Infer columns from data if schema is empty
        const inferredColumns = columns.length > 0 ? columns :
          pagedData.length > 0
            ? Object.keys(pagedData[0]).map((k: string) => ({ name: k, type: 'string', isPrimaryKey: false }))
            : [];

        return {
          success: true,
          columns: inferredColumns,
          rows: pagedData,
          pagination: {
            page,
            pageSize,
            hasNext,
            hasPrev,
            approxTotalRows: data.length,
          },
          metadata: {
            executionTime: result.metadata?.executionTime || 0,
            sourceType,
          },
        };
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to fetch data: ${errorMsg}`);
      }
    }
  });

  // Execute a user-provided query against a source
  // Industry-standard approach: auto-inject LIMIT if missing, N+1 fetch, prev/next pagination
  addSourceOp('querySource', async (params: {
    sourceId: string;
    query: string;
    page?: number;
    pageSize?: number;
  }) => {
    const { sourceId, query } = params;
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(500, Math.max(1, params.pageSize || 100));

    if (!sourceId) throw new Error('sourceId is required');
    if (!query || !query.trim()) throw new Error('query is required');

    const manager = getSourceManager();
    if (!manager) throw new Error('Source manager not initialized');

    const instance = manager.getInstance(sourceId);
    if (!instance) throw new Error(`Source instance not found: ${sourceId}`);

    const sourceType = instance.getType();
    const sqlSourceTypes = ['postgres', 'mysql', 'mssql', 'netsuite', 'csv', 'excel'];

    if (!sqlSourceTypes.includes(sourceType)) {
      throw new Error(`Query editor is only available for SQL-based sources (${sqlSourceTypes.join(', ')}). This source is ${sourceType}.`);
    }

    // Safety: only allow read-only queries
    const trimmed = query.trim();
    // Remove comments (-- and /* */) before checking
    const stripped = trimmed
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();

    // Check for write/destructive keywords anywhere in the query (not just at the start)
    // This catches "SELECT 1; DROP TABLE" and similar injection attempts
    const writeKeywords = [
      { pattern: /\bDROP\b/, label: 'DROP' },
      { pattern: /\bDELETE\b/, label: 'DELETE' },
      { pattern: /\bTRUNCATE\b/, label: 'TRUNCATE' },
      { pattern: /\bALTER\b/, label: 'ALTER' },
      { pattern: /\bINSERT\b/, label: 'INSERT' },
      { pattern: /\bUPDATE\b(?!\s*\()/, label: 'UPDATE' }, // allow UPDATE() window function
      { pattern: /\bCREATE\b/, label: 'CREATE' },
      { pattern: /\bGRANT\b/, label: 'GRANT' },
      { pattern: /\bREVOKE\b/, label: 'REVOKE' },
      { pattern: /\bEXEC\b/, label: 'EXEC' },
      { pattern: /\bEXECUTE\b/, label: 'EXECUTE' },
      { pattern: /\bCALL\b/, label: 'CALL' },
      { pattern: /\bMERGE\b/, label: 'MERGE' },
      { pattern: /\bREPLACE\b/, label: 'REPLACE' },
      { pattern: /\bLOAD\b/, label: 'LOAD' },
      { pattern: /\bCOPY\b/, label: 'COPY' },
    ];

    for (const { pattern, label } of writeKeywords) {
      if (pattern.test(stripped)) {
        throw new Error(
          `${label} statements are not allowed. This query editor is read-only — only SELECT, SHOW, DESCRIBE, and EXPLAIN queries are permitted.`
        );
      }
    }

    // Must start with an allowed keyword
    const allowedStarts = /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|PRAGMA|SET\s+SEARCH_PATH)\b/;
    if (!allowedStarts.test(stripped)) {
      throw new Error(
        `Query must start with SELECT, WITH, SHOW, DESCRIBE, or EXPLAIN. This query editor is read-only — write operations are not permitted.`
      );
    }

    // Check if user query already has a row-limiting clause — either the
    // ANSI/Postgres/MySQL `LIMIT n` or the MSSQL/SuiteQL `TOP n`. Checking
    // for `LIMIT` alone misses `TOP`, which used to fall through to the
    // auto-inject branch below and get OFFSET/FETCH NEXT appended onto an
    // already-TOP'd query — invalid syntax, since TOP and OFFSET/FETCH NEXT
    // are mutually exclusive pagination mechanisms in both MSSQL and SuiteQL.
    const limitMatch = trimmed.match(/\bLIMIT\s+(\d+)/i);
    const topMatch = trimmed.match(/\bTOP\s+\(?\s*(\d+)\s*\)?/i);
    const existingLimitValue = limitMatch ? parseInt(limitMatch[1], 10) : topMatch ? parseInt(topMatch[1], 10) : null;
    const hasLimit = existingLimitValue !== null;
    const hasOffset = /\bOFFSET\s+\d+/i.test(trimmed);

    // Build the final SQL:
    // - If user has their own LIMIT/TOP under `pageSize`: respect it exactly, as typed.
    // - If user has their own LIMIT/TOP at or above `pageSize`: cap it down to `pageSize`
    //   in place, rather than injecting a second pagination clause on top of it.
    // - If no LIMIT/TOP: wrap with safe LIMIT/OFFSET (or OFFSET/FETCH NEXT) pagination
    let finalSql: string;
    let limitWasInjected = false;
    const fetchSize = pageSize + 1; // N+1 pattern
    const offset = (page - 1) * pageSize;

    if (hasLimit) {
      // User controls pagination — run as-is, unless they asked for too much
      let sql = trimmed.replace(/;+\s*$/, '');
      if (existingLimitValue! >= pageSize) {
        // Replace only the digits, keeping surrounding whitespace/parens intact —
        // consuming the trailing `\s*` here would glue the number to whatever
        // follows (e.g. `TOP 10 lastname` -> `TOP 100lastname`, invalid SQL).
        sql = limitMatch
          ? sql.replace(/\bLIMIT\s+\d+/i, `LIMIT ${pageSize}`)
          : sql.replace(/\bTOP(\s+\(?\s*)\d+(\s*\)?)/i, `TOP$1${pageSize}$2`);
      }
      finalSql = sql;
    } else {
      // Auto-inject safe LIMIT/OFFSET
      limitWasInjected = true;
      const cleanQuery = trimmed.replace(/;+\s*$/, '');
      if (sourceType === 'mssql') {
        // MSSQL: use OFFSET/FETCH (requires ORDER BY)
        const hasOrderBy = /\bORDER\s+BY\b/i.test(cleanQuery);
        const orderClause = hasOrderBy ? '' : ' ORDER BY (SELECT NULL)';
        finalSql = `${cleanQuery}${orderClause} OFFSET ${offset} ROWS FETCH NEXT ${fetchSize} ROWS ONLY`;
      } else if (sourceType === 'netsuite') {
        // SuiteQL (Oracle-style) has no LIMIT — same OFFSET...FETCH NEXT
        // syntax as MSSQL, but no ORDER BY requirement.
        finalSql = `${cleanQuery} OFFSET ${offset} ROWS FETCH NEXT ${fetchSize} ROWS ONLY`;
      } else {
        finalSql = `${cleanQuery} LIMIT ${fetchSize} OFFSET ${offset}`;
      }
    }

    try {
      const startTime = Date.now();
      const result = await runAsSystem('admin-query-run', () => instance.execute({ sql: finalSql }));
      const allRows = result.data || [];
      const executionTime = Date.now() - startTime;

      let rows: any[];
      let hasNext: boolean;

      if (hasLimit) {
        // User-controlled limit: show all returned rows, no "next"
        rows = allRows;
        hasNext = false;
      } else {
        // We injected LIMIT: check N+1
        hasNext = allRows.length > pageSize;
        rows = hasNext ? allRows.slice(0, pageSize) : allRows;
      }

      const hasPrev = !hasLimit && page > 1;

      // Infer columns from first row
      const columns = rows.length > 0
        ? Object.keys(rows[0]).map(name => ({ name, type: typeof rows[0][name] === 'number' ? 'number' : 'string', isPrimaryKey: false }))
        : [];

      return {
        success: true,
        columns,
        rows,
        rowCount: rows.length,
        pagination: {
          page: hasLimit ? 1 : page,
          pageSize,
          hasNext,
          hasPrev,
        },
        executionTime,
        limitInjected: limitWasInjected,
      };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Query failed: ${errorMsg}`);
    }
  });

  // Get active sources status (which sources are currently connected)
  addSourceOp('getActiveStatus', async () => {
    const manager = getSourceManager();
    if (!manager) {
      return { success: false, error: 'Source manager not initialized', sources: [] };
    }

    const status = manager.getStatus();
    return {
      success: true,
      projectId: status.projectId,
      totalConfigured: status.sourceCount,
      sources: status.sources,
    };
  });

}
