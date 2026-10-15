/**
 * CSV Source Instance — DuckDB-backed
 *
 * Loads one or more CSV files into DuckDB tables (one table per file, named
 * after the file). Queries run as real SQL, enabling full aggregation,
 * cross-file joins, and analytics — mirrors ExcelInstance's one-tool/many-
 * tables model, just without a sheet-conversion step (files are already CSV).
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import {
  BaseSource,
  SourceConfig,
  SourceSchema,
  QueryResult,
  SchemaEntity,
  SourceTool,
  SchemaField,
  inferColumnTypes,
} from '../core';
import {
  isURL,
  downloadFileFromURL,
  downloadFileFromR2,
  getSourceDbPath,
  fileFingerprint,
  readSourceMeta,
  writeSourceMeta,
  deleteSourceMeta,
} from '../core/file-storage';
import { processCsvFile } from '../core/pii-redactor';
import { baseTableName, dedupeTableName } from '../core/table-naming';

/** One uploaded CSV within a (possibly multi-file) CSV source. */
export interface CSVFileEntry {
  fileName: string;
  filePath: string;
  /** R2 object key, if uploaded via the multipart R2 flow. */
  r2Key?: string;
  /** DuckDB table name — assigned once (deduped), then kept stable across rebuilds. */
  tableName?: string;
  /**
   * Stable audit-trail id for this file, assigned once. Persisted here (not
   * derived from the DuckDB rebuild) so it — and createdAt/createdBy below —
   * survive a full rebuild, which happens whenever ANY file in the source
   * changes. Every row loaded from this file carries it in the __source
   * column, joinable against the __sources table for who/when detail.
   */
  sourceRowId?: string;
  createdAt?: string;
  /** From CSVInstance.currentActor at the time this entry was first created. Left unset if none was provided. */
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
  /**
   * This file's own `size:mtimeMs` as of the last build. A rebuild can be
   * triggered by a SIBLING file changing (they share one .duckdb) — this lets
   * connect() tell "this file actually changed" apart from "the source was
   * rebuilt for an unrelated reason", so updatedAt only moves for files that
   * really did change.
   */
  fingerprint?: string;
}

interface CSVConfig {
  /** Legacy single-file field. Still supported for existing sources; superseded by `files` when present. */
  filePath?: string;
  /** Legacy single-file R2 key, paired with `filePath` above. */
  r2Key?: string;
  /** Multi-file field. When non-empty, takes precedence over the legacy singular fields. */
  files?: CSVFileEntry[];
  delimiter?: string;
  hasHeader?: boolean;
  encoding?: string;
  refreshInterval?: number;
  /** PII columns to mask on load (persisted opt-in). entity = table name. */
  redactColumns?: Array<{ entity: string; column: string }>;
  /** PII columns to drop entirely on load (persisted opt-in). entity = table name. */
  dropColumns?: Array<{ entity: string; column: string }>;
}

export class CSVInstance extends BaseSource {
  private db: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  /** All loaded table names, one per file. Legacy single-file sources have exactly one. */
  private tableNames: string[] = [];
  private lastLoaded: Date | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private originalUrl: string | null = null;
  private isRefreshing: boolean = false;
  public onPostRefresh: (() => Promise<void>) | null = null;
  /** Optional live progress sink for PII redaction (set by the upload handler). */
  public onRedactProgress:
    | ((info: { sheetName: string; rows: number; total: number; done: boolean }) => void)
    | null = null;
  /** Optional live progress sink for loading each file into DuckDB (set by the upload handler). */
  public onLoadProgress:
    | ((info: { sheetName: string; index: number; total: number }) => void)
    | null = null;
  /**
   * Identity of whoever triggered this connect()/refresh() call — set by the
   * upload/refresh handler (project-sources.ts) right before calling connect(),
   * same pattern as the progress sinks above. Used to stamp createdBy/updatedBy
   * on the audit trail; left null if the caller didn't provide one.
   */
  public currentActor: string | null = null;

  private getConnectionConfig(): CSVConfig {
    return this.config.config as CSVConfig;
  }

  /** Every uploaded file is user-curated — never strip it as "junk". */
  protected filtersJunkTables(): boolean {
    return false;
  }

  /**
   * Resolves `cfg.files` when present, else the legacy singular `filePath`
   * as a one-entry list — single-file is just N=1 of the same load loop.
   */
  private async resolveFileEntries(cfg: CSVConfig): Promise<CSVFileEntry[]> {
    if (cfg.files && cfg.files.length > 0) {
      const resolved: CSVFileEntry[] = [];
      for (let i = 0; i < cfg.files.length; i++) {
        const entry = cfg.files[i];
        let localPath = entry.filePath;

        if (entry.r2Key && (!localPath || !fs.existsSync(localPath))) {
          console.log(`[CSVInstance] Local file missing, re-downloading from R2: ${entry.r2Key}`);
          localPath = await downloadFileFromR2(
            entry.r2Key,
            this.config.projectId,
            this.config.id,
            entry.fileName,
            String(i),
          );
          entry.filePath = localPath;
        }

        if (!localPath || !fs.existsSync(localPath)) {
          throw new Error(`File not found: ${entry.fileName} (${localPath || 'no path'})`);
        }

        resolved.push(entry);
      }
      return resolved;
    }

    // Legacy singular path.
    let localPath = cfg.filePath;
    if (!localPath) return [];

    if (isURL(localPath)) {
      if (!this.originalUrl) this.originalUrl = localPath;
      localPath = await downloadFileFromURL(localPath, this.config.projectId, this.config.id);
      (this.config.config as CSVConfig).filePath = localPath;
    }

    if (cfg.r2Key && (!localPath || !fs.existsSync(localPath))) {
      console.log(`[CSVInstance] Local file missing, re-downloading from R2: ${cfg.r2Key}`);
      localPath = await downloadFileFromR2(
        cfg.r2Key,
        this.config.projectId,
        this.config.id,
        localPath ? path.basename(localPath) : undefined,
      );
      (this.config.config as CSVConfig).filePath = localPath;
    }

    if (!fs.existsSync(localPath)) {
      throw new Error(`File not found: ${localPath}`);
    }

    return [{ fileName: path.basename(localPath), filePath: localPath, r2Key: cfg.r2Key }];
  }

  /** Combined fingerprint across every file — any one changing invalidates the cache. */
  private combinedFingerprint(entries: CSVFileEntry[]): string | null {
    const parts: string[] = [];
    for (const entry of entries) {
      const fp = fileFingerprint(entry.filePath);
      if (!fp) return null;
      parts.push(fp);
    }
    return parts.join('|');
  }

  /**
   * Load one or more CSV files into DuckDB tables (one table per file).
   *
   * Reconciles rather than rebuilds: a table is only (re)created for a file
   * that's new or actually changed, and only removed tables get dropped —
   * files that are already loaded and unchanged are left untouched. Add and
   * remove (the only operations reachable from Manage Files today) never
   * need to touch sibling tables at all.
   */
  async connect(): Promise<void> {
    const cfg = this.getConnectionConfig();

    try {
      // Clean up any existing connection
      await this.cleanup();

      const fileEntries = await this.resolveFileEntries(cfg);
      if (fileEntries.length === 0) {
        throw new Error('No source file configured');
      }

      const dbPath = this.getDbPath();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });

      // Fast path: nothing at all changed since the last build — reuse the
      // cached .duckdb untouched, no need to even open it for reconciliation.
      const fingerprint = this.combinedFingerprint(fileEntries);
      const meta = readSourceMeta(this.config.projectId, this.config.id);
      if (fingerprint && meta?.fingerprint === fingerprint && fs.existsSync(dbPath)) {
        // Drop a stale WAL left by an unclean shutdown. The build CHECKPOINTs the
        // .duckdb, so the main file is authoritative and the WAL holds nothing we
        // need — replaying it can crash DuckDB and force a pointless rebuild.
        try { fs.unlinkSync(`${dbPath}.wal`); } catch {}
        try {
          await this.openExistingDb(dbPath);
          this.lastLoaded = new Date();
          this.setConnected(true);
          console.log(`[CSVInstance] Reused cached DuckDB (unchanged since ${meta.builtAt}; ${this.tableNames.length} table(s): ${this.tableNames.join(', ')})`);
          this.startRefreshTimer();
          return;
        } catch (reuseErr) {
          const msg = reuseErr instanceof Error ? reuseErr.message : String(reuseErr);
          console.warn(`[CSVInstance] Cached DuckDB unusable, rebuilding: ${msg}`);
          await this.cleanup();
        }
      }

      // Something changed (or this is the first-ever build, or the cache was
      // unusable). Open the existing .duckdb if there is one and reconcile it
      // in place; only a missing/corrupt file falls back to creating fresh.
      let existingTables: string[] = [];
      try { fs.unlinkSync(`${dbPath}.wal`); } catch {}
      if (fs.existsSync(dbPath)) {
        try {
          this.db = await DuckDBInstance.create(dbPath);
          this.connection = await this.db.connect();
          await this.connection.run(`PRAGMA memory_limit='1GB'`);
          await this.connection.run(`PRAGMA threads=4`);
          existingTables = await this.listExistingTables();
        } catch (openErr) {
          const msg = openErr instanceof Error ? openErr.message : String(openErr);
          console.warn(`[CSVInstance] Existing DuckDB unusable, creating fresh: ${msg}`);
          await this.cleanup();
          try { fs.unlinkSync(dbPath); } catch {}
        }
      }

      if (!this.connection) {
        // First-ever build, or the existing file was unusable.
        this.db = await DuckDBInstance.create(dbPath);
        this.connection = await this.db.connect();
        // Per-source DuckDB caps. 1 GB is enough for `read_csv` to handle ~1 GB
        // input files comfortably (read_csv is streaming, so the cap mainly gates
        // working memory for GROUP BY / sort / join). 4 threads strikes a balance
        // between single-source throughput and cross-source contention.
        await this.connection.run(`PRAGMA memory_limit='1GB'`);
        await this.connection.run(`PRAGMA threads=4`);
      }

      // Assign/dedupe table names for every entry up front — existing names
      // are always reused; only entries without one yet get freshly deduped.
      const usedNames = new Set<string>(existingTables);
      for (const entry of fileEntries) {
        if (!entry.tableName) {
          entry.tableName = dedupeTableName(baseTableName(entry.fileName), usedNames);
        }
        usedNames.add(entry.tableName);
      }
      const desiredNames = new Set(fileEntries.map(e => e.tableName!));

      // Drop tables for files no longer in this source (Manage Files "remove").
      for (const existingTable of existingTables) {
        if (!desiredNames.has(existingTable)) {
          await this.connection.run(`DROP TABLE IF EXISTS "${existingTable.replace(/"/g, '""')}"`);
          console.log(`[CSVInstance] Dropped table "${existingTable}" (file removed)`);
        }
      }

      this.tableNames = [];
      let loadIndex = 0;

      for (const entry of fileEntries) {
        loadIndex++;
        const tableName = entry.tableName!;
        const alreadyLoaded = existingTables.includes(tableName);

        // Audit trail: assign a stable row id + createdAt once, kept stable
        // across rebuilds. updatedAt only moves when THIS file's own content
        // actually changed — reconciling a sibling add/remove must not make
        // every other file in the source look "just updated".
        const currentFingerprint = fileFingerprint(entry.filePath);
        const isNewEntry = !entry.sourceRowId;
        const fileActuallyChanged = isNewEntry || entry.fingerprint !== currentFingerprint || !alreadyLoaded;

        if (alreadyLoaded && !fileActuallyChanged) {
          // Already loaded and unchanged — nothing to do for this file.
          this.tableNames.push(tableName);
          continue;
        }

        this.onLoadProgress?.({ sheetName: entry.fileName, index: loadIndex, total: fileEntries.length });

        const now = new Date().toISOString();
        if (isNewEntry) {
          entry.sourceRowId = randomUUID();
          entry.createdAt = now;
          if (this.currentActor) entry.createdBy = this.currentActor;
        }
        entry.updatedAt = now;
        if (this.currentActor) entry.updatedBy = this.currentActor;
        if (currentFingerprint) entry.fingerprint = currentFingerprint;

        if (alreadyLoaded) {
          // Content changed for a file whose table already exists — not
          // reachable from today's UI (only an explicit file replace could
          // trigger it), but handled correctly regardless: swap just this
          // one table, siblings untouched.
          await this.connection.run(`DROP TABLE IF EXISTS "${tableName.replace(/"/g, '""')}"`);
        }

        await this.loadFileIntoTable(entry, tableName, cfg);
        this.tableNames.push(tableName);
      }

      // Audit trail: one row per uploaded file, mapping __source ids (on every
      // data row) back to the file/table they came from and when. __-prefixed
      // so it's excluded from the LLM-facing schema and from table rediscovery
      // (openExistingDb below) — it's bookkeeping, not queryable data. Small
      // table (one row per file) — simplest to fully regenerate each time
      // rather than diff it.
      await this.connection.run(`DROP TABLE IF EXISTS "__sources"`);
      await this.connection.run(`
        CREATE TABLE "__sources" (
          id VARCHAR, name VARCHAR, table_name VARCHAR, file_size BIGINT,
          created_at TIMESTAMP, updated_at TIMESTAMP,
          created_by VARCHAR, updated_by VARCHAR
        )
      `);
      const esc = (v?: string) => (v === undefined ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
      const auditRows = fileEntries.map(entry => {
        // Read fresh off disk rather than persisting it — always reflects the
        // file actually loaded, no stale value across rebuilds.
        let fileSize: number | null = null;
        try { fileSize = fs.statSync(entry.filePath).size; } catch { /* leave null if unreadable */ }
        return `(${esc(entry.sourceRowId)}, ${esc(entry.fileName)}, ${esc(entry.tableName)}, ${fileSize ?? 'NULL'}, ${esc(entry.createdAt)}::TIMESTAMP, ${esc(entry.updatedAt)}::TIMESTAMP, ${esc(entry.createdBy)}, ${esc(entry.updatedBy)})`;
      }).join(',\n        ');
      await this.connection.run(`INSERT INTO "__sources" VALUES\n        ${auditRows}`);

      this.lastLoaded = new Date();
      this.setConnected(true);

      for (const table of this.tableNames) {
        try {
          const countResult = await this.connection.runAndReadAll(
            `SELECT COUNT(*) as cnt FROM "${table.replace(/"/g, '""')}"`
          );
          const countRows = countResult.getRowObjects() as Array<{ cnt: number | bigint }>;
          const rowCount = Number(countRows[0]?.cnt || 0);
          console.log(`[CSVInstance] Table "${table}": ${rowCount} rows`);
        } catch {
          // ignore
        }
      }

      console.log(`[CSVInstance] Reconciled ${fileEntries.length} file(s) into DuckDB (${this.tableNames.length} table(s): ${this.tableNames.join(', ')})`);

      // Flush the WAL into the .duckdb file so the on-disk DB is self-contained.
      // Without this, a kill before a clean DuckDB shutdown leaves an
      // un-checkpointed WAL that can fail to replay on the next open (DuckDB
      // "GetDefaultDatabase" assertion), needlessly forcing a full rebuild.
      // Best-effort — a failed checkpoint only risks a rebuild next start.
      try {
        await this.connection.run(`CHECKPOINT`);
      } catch (checkpointErr) {
        console.warn(`[CSVInstance] Checkpoint after build failed:`, checkpointErr);
      }

      // Record the build cache key so the next restart can reuse this .duckdb.
      // Re-fingerprint after the build — the 0xA0 normalization below may have
      // rewritten a file, bumping its mtime.
      const builtFingerprint = this.combinedFingerprint(fileEntries);
      if (builtFingerprint) {
        writeSourceMeta(this.config.projectId, this.config.id, {
          fingerprint: builtFingerprint,
          builtAt: new Date().toISOString(),
        });
      }

      // Start background refresh timer
      this.startRefreshTimer();
    } catch (error) {
      await this.cleanup();
      this.setConnected(false);
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load CSV into DuckDB: ${errorMsg}`);
    }
  }

  /** All table names in the currently-open connection, excluding the __sources bookkeeping table. */
  private async listExistingTables(): Promise<string[]> {
    const res = await this.connection!.runAndReadAll(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name`
    );
    return (res.getRowObjects() as Array<{ table_name: string }>)
      .map(r => r.table_name)
      .filter(name => name !== '__sources');
  }

  /** Load one file's CSV content into its (already-created-empty-of) table. */
  private async loadFileIntoTable(entry: CSVFileEntry, tableName: string, cfg: CSVConfig): Promise<void> {
    // Normalize encoding: replace stray 0xA0 bytes (latin-1 non-breaking
    // space) with regular spaces so DuckDB's UTF-8 parser doesn't reject
    // them. Proper UTF-8 NBSP (0xC2 0xA0) is left intact.
    const rawBytes = fs.readFileSync(entry.filePath);
    let modified = false;
    for (let i = 0; i < rawBytes.length; i++) {
      if (rawBytes[i] === 0xa0 && (i === 0 || rawBytes[i - 1] !== 0xc2)) {
        rawBytes[i] = 0x20; // replace with regular space
        modified = true;
      }
    }
    if (modified) {
      fs.writeFileSync(entry.filePath, rawBytes);
    }

    // PII column policy (persisted opt-in), scoped by table name.
    const redactCols = (cfg.redactColumns || []).filter(r => r.entity === tableName).map(r => r.column);
    const dropCols = (cfg.dropColumns || []).filter(r => r.entity === tableName).map(r => r.column);
    if (redactCols.length > 0 || dropCols.length > 0) {
      // Announce before the (slow) read so the toast shows "Redacting …" up front.
      this.onRedactProgress?.({ sheetName: tableName, rows: 0, total: 0, done: false });
      const result = await processCsvFile(entry.filePath, {
        redactColumns: redactCols,
        dropColumns: dropCols,
        delimiter: cfg.delimiter || ',',
        hasHeader: cfg.hasHeader !== false,
        onProgress: (info) =>
          this.onRedactProgress?.({ sheetName: tableName, rows: info.rows, total: info.total, done: info.done }),
      });
      console.log(`[CSVInstance] PII policy applied to "${tableName}": ${result.cellsRedacted} cell(s) masked, ${result.columnsDropped} column(s) dropped (${result.rowsScanned} rows)`);
    }

    const escapedPath = entry.filePath.replace(/'/g, "''");
    const hasHeader = cfg.hasHeader !== false;
    const delimiter = cfg.delimiter || ',';
    const escapedDelimiter = delimiter.replace(/'/g, "''");
    const escapedTable = tableName.replace(/"/g, '""');

    // Create table from CSV — load as all_varchar to avoid type inference errors
    // on mixed-type columns, then convert numeric columns afterward. __source
    // tags every row with this file's audit-trail id (see __sources table) —
    // double-underscore prefix keeps it out of the LLM-facing schema.
    const escapedSourceRowId = entry.sourceRowId!.replace(/'/g, "''");
    await this.connection!.run(
      `CREATE TABLE "${escapedTable}" AS SELECT *, '${escapedSourceRowId}' AS __source FROM read_csv('${escapedPath}', header=${hasHeader}, delim='${escapedDelimiter}', quote='"', all_varchar=true, store_rejects=true)`
    );

    // Log any rows DuckDB rejected during CSV parsing
    try {
      const rejectsResult = await this.connection!.runAndReadAll(
        `SELECT COUNT(*) as cnt FROM reject_errors`
      );
      const rejectRows = rejectsResult.getRowObjects() as Array<{ cnt: number | bigint }>;
      const rejectCount = Number(rejectRows[0]?.cnt ?? 0);
      if (rejectCount > 0) {
        console.warn(`[CSV] ${rejectCount} row(s) rejected during parsing of "${tableName}" — check reject_errors table for details`);
      }
    } catch { /* reject_errors table may not exist if no errors */ }

    // Remove totals/summary rows that would cause double-counting
    await this.removeTotalsRows(tableName);

    // Re-type the all_varchar columns: dates (serial, then text) first so a
    // date column isn't grabbed by the numeric pass, then numbers.
    await inferColumnTypes(this.connection!, tableName, '[CSVInstance]');
  }

  /**
   * Open an already-built .duckdb without rebuilding, recovering all table
   * names from the DB. Used by the build-cache fast path in connect(). Throws
   * if the DB can't be opened or has no tables (caller falls back to a full rebuild).
   */
  private async openExistingDb(dbPath: string): Promise<void> {
    this.db = await DuckDBInstance.create(dbPath);
    this.connection = await this.db.connect();
    await this.connection.run(`PRAGMA memory_limit='1GB'`);
    await this.connection.run(`PRAGMA threads=4`);

    this.tableNames = await this.listExistingTables();
    if (this.tableNames.length === 0) {
      throw new Error('cached DuckDB has no tables');
    }
  }

  /**
   * Ensure DuckDB is loaded (reconnect if needed)
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.connection) {
      await this.connect();
    }
  }

  /**
   * Start a background timer to proactively refresh data
   */
  private startRefreshTimer(): void {
    this.stopRefreshTimer();

    const cfg = this.getConnectionConfig();
    const intervalMinutes = cfg.refreshInterval ?? 1440;

    if (intervalMinutes <= 0) return;

    const intervalMs = intervalMinutes * 60 * 1000;
    console.log(`[CSVInstance] Background refresh scheduled every ${intervalMinutes} minutes for: ${this.getName()}`);

    this.refreshTimer = setInterval(async () => {
      await this.refresh();
    }, intervalMs);
  }

  /**
   * Stop the background refresh timer
   */
  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Refresh the data — re-download (if URL) and reload DuckDB. Also picks up
   * any add/remove/replace applied to `config.files` since the last connect.
   * Can be called manually or by the background timer.
   */
  async refresh(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    try {
      console.log(`[CSVInstance] Refreshing data for: ${this.getName()}`);

      // If originally a URL, re-download by restoring the URL before reconnecting
      if (this.originalUrl) {
        (this.config.config as CSVConfig).filePath = this.originalUrl;
      }

      await this.connect();
      console.log(`[CSVInstance] Refresh complete for: ${this.getName()}`);

      // Notify manager to re-extract schema and refresh tools
      if (this.onPostRefresh) {
        await this.onPostRefresh();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[CSVInstance] Refresh failed for ${this.getName()}: ${errorMsg}`);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Detect and remove totals/summary rows from a loaded table.
   *
   * CSV files (especially those exported from Excel) commonly have a "Total"
   * or "Grand Total" row at the bottom. If left in, SUM/AVG queries double-count.
   */
  private async removeTotalsRows(tableName: string): Promise<void> {
    try {
      if (!this.connection) return;
      const escapedTable = tableName.replace(/"/g, '""');

      const desc = await this.connection.runAndReadAll(`DESCRIBE "${escapedTable}"`);
      const cols = desc.getRowObjects() as Array<{ column_name: string; column_type: string }>;

      const textCols = cols.filter(c =>
        c.column_type.toUpperCase().includes('VARCHAR') ||
        c.column_type.toUpperCase().includes('TEXT')
      );

      if (textCols.length === 0) return;

      const totalsPatterns = ['total', 'grand total', 'subtotal', 'sum', 'totals'];
      const conditions = textCols.map(col => {
        const patterns = totalsPatterns.map(p => `LOWER(TRIM("${col.column_name}")) = '${p}'`).join(' OR ');
        return `(${patterns})`;
      }).join(' OR ');

      const countResult = await this.connection.runAndReadAll(
        `SELECT COUNT(*) as cnt FROM "${escapedTable}" WHERE ${conditions}`
      );
      const matchCount = Number((countResult.getRowObjects() as any[])[0]?.cnt || 0);

      if (matchCount > 0) {
        await this.connection.run(
          `DELETE FROM "${escapedTable}" WHERE ${conditions}`
        );
        console.log(`[CSVInstance] Removed ${matchCount} totals/summary row(s) from "${tableName}"`);
      }
    } catch (e) {
      console.warn(`[CSVInstance] Totals row detection skipped for "${tableName}":`, e);
    }
  }

  /**
   * Absolute path to this source's on-disk DuckDB database file.
   */
  private getDbPath(): string {
    return getSourceDbPath(this.config.projectId, this.config.id);
  }

  /**
   * Clean up DuckDB resources
   */
  private async cleanup(): Promise<void> {
    try {
      if (this.connection) {
        this.connection.closeSync();
        this.connection = null;
      }
      if (this.db) {
        this.db.closeSync();
        this.db = null;
      }
    } catch {
      this.connection = null;
      this.db = null;
    }
    this.tableNames = [];
  }

  /**
   * Disconnect — release DuckDB resources and stop timers
   */
  async disconnect(): Promise<void> {
    this.stopRefreshTimer();
    await this.cleanup();
    // Drop the on-disk DuckDB file and build-cache meta — connect() rebuilds
    // them from the source file(s).
    try { fs.unlinkSync(this.getDbPath()); } catch {}
    deleteSourceMeta(this.config.projectId, this.config.id);
    this.lastLoaded = null;
    this.setConnected(false);
    console.log(`[CSVInstance] Unloaded ${this.getName()}`);
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.connection) return false;
      await this.connection.runAndReadAll('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extract schema from DuckDB tables (one entity per loaded file).
   */
  async extractSchema(): Promise<SourceSchema> {
    await this.ensureLoaded();

    const entities: SchemaEntity[] = [];

    for (const tableName of this.tableNames) {
      const escapedTable = tableName.replace(/"/g, '""');

      // Get column info
      const descResult = await this.connection!.runAndReadAll(
        `DESCRIBE "${escapedTable}"`
      );
      const columns = descResult.getRowObjects() as Array<{
        column_name: string;
        column_type: string;
        null: string;
        key: string | null;
        default: string | null;
        extra: string | null;
      }>;

      // Get row count
      const countResult = await this.connection!.runAndReadAll(
        `SELECT COUNT(*) as cnt FROM "${escapedTable}"`
      );
      const countRows = countResult.getRowObjects() as Array<{ cnt: number | bigint }>;
      const rowCount = Number(countRows[0]?.cnt || 0);

      // Skip empty CSV — no data to query, saves schema tokens
      if (rowCount === 0) {
        console.log(`[CSVInstance] Skipping empty CSV "${tableName}"`);
        continue;
      }

      // Build fields with sample values
      const fields: SchemaField[] = [];
      for (const col of columns) {
        const normalizedType = this.normalizeType(col.column_type);

        let sampleValues: any[] = [];
        try {
          const sampleResult = await this.connection!.runAndReadAll(
            `SELECT DISTINCT "${col.column_name}" FROM "${escapedTable}" WHERE "${col.column_name}" IS NOT NULL LIMIT 5`
          );
          const sampleRows = sampleResult.getRowObjectsJson();
          sampleValues = sampleRows.map((r: any) => r[col.column_name]).filter((v: any) => v !== null && v !== undefined);
        } catch {
          // Skip sample values on error
        }

        fields.push({
          name: col.column_name,
          type: normalizedType,
          nativeType: col.column_type,
          nullable: col.null === 'YES',
          sampleValues: sampleValues.slice(0, 5),
        });
      }

      entities.push({
        name: tableName,
        fullName: tableName,
        fields,
        rowCount,
      });
    }

    const schema: SourceSchema = {
      entities,
      extractedAt: new Date().toISOString(),
    };

    this.setSchema(schema);
    console.log(`[CSVInstance] Extracted schema: ${entities.length} table(s), tables: ${this.tableNames.join(', ')}`);
    return schema;
  }

  /**
   * Execute SQL query against DuckDB
   */
  async execute(params: { sql: string; params?: Record<string, any> }): Promise<QueryResult> {
    await this.ensureLoaded();

    let { sql } = params;
    const { params: queryParams } = params;
    const startTime = Date.now();

    // Authorization seam — always read-only for file sources. See BaseSource.prepareSql.
    sql = await this.prepareSql(sql, { forceReadOnly: true });

    try {
      // Substitute named parameters ($name or @name) into the SQL
      const finalSql = this.substituteParams(sql, queryParams);
      const result = await this.connection!.runAndReadAll(finalSql);
      const data = result.getRowObjectsJson() as any[];

      return {
        data,
        count: data.length,
        metadata: {
          executionTime: Date.now() - startTime,
          totalCount: data.length,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`DuckDB query failed: ${errorMsg}\nSQL: ${sql}`);
    }
  }

  /**
   * Substitute named parameters ($name or @name) into SQL with proper quoting for DuckDB
   */
  private substituteParams(sql: string, params?: Record<string, any>): string {
    if (!params || Object.keys(params).length === 0) return sql;

    return sql.replace(/[@$](\w+)/g, (match, paramName) => {
      // Skip DuckDB positional params like $1, $2
      if (match.startsWith('$') && /^\d+$/.test(paramName)) return match;
      if (!(paramName in params)) return match;

      const value = params[paramName];
      if (value === null || value === undefined) return 'NULL';
      if (typeof value === 'number') return String(value);
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
      // String: escape single quotes
      return `'${String(value).replace(/'/g, "''")}'`;
    });
  }

  // ============================================
  // Tool Generation — SQL pattern (like Postgres)
  // ============================================

  protected getToolId(): string {
    return `${this.config.id}_query`;
  }

  protected getToolName(): string {
    return `Query ${this.config.name}`;
  }

  protected buildToolDescription(): string {
    const schemaInfo = this.formatSchemaForMainAgent();
    const sourceContext = this.getSourceContext();
    const domainHints = this.getDataDomainHints();
    const fileCount = this.getFileCount();

    if (this.tableNames.length <= 1) {
      return `Query ${this.config.name} (CSV file${fileCount > 1 ? 's' : ''}, loaded into DuckDB SQL engine).${sourceContext}${domainHints}

Available table: "${this.tableNames[0] || ''}"
${schemaInfo}

This source supports full DuckDB SQL including:
- Aggregations: SUM, AVG, COUNT, MIN, MAX, MEDIAN, STDDEV, PERCENTILE_CONT, etc.
- GROUP BY, HAVING, ORDER BY, LIMIT
- Window functions: ROW_NUMBER, RANK, LAG, LEAD, SUM OVER, etc.
- String functions, date functions, CASE WHEN, subqueries, CTEs
- Column names with spaces must be quoted: SELECT "Column Name" FROM "${this.tableNames[0] || ''}"`;
    }

    const tableList = this.tableNames.map(t => `"${t}"`).join(', ');

    return `Query ${this.config.name} (${this.tableNames.length} CSV files, loaded into DuckDB SQL engine).${sourceContext}${domainHints}

Available tables (one per uploaded file): ${tableList}
${schemaInfo}

This source supports full DuckDB SQL including:
- Aggregations: SUM, AVG, COUNT, MIN, MAX, MEDIAN, STDDEV, PERCENTILE_CONT, etc.
- GROUP BY, HAVING, ORDER BY, LIMIT
- Window functions: ROW_NUMBER, RANK, LAG, LEAD, SUM OVER, etc.
- Cross-file JOINs between tables (each uploaded file is a table)
- String functions, date functions, CASE WHEN, subqueries, CTEs
- Table names with spaces must be quoted: SELECT * FROM "My Table"
- Column names with spaces must be quoted: SELECT "Column Name" FROM "${this.tableNames[0] || ''}"`;
  }

  private getFileCount(): number {
    const cfg = this.getConnectionConfig();
    return cfg.files?.length || 1;
  }

  protected getToolParams(): Record<string, string> {
    if (this.tableNames.length <= 1) {
      return {
        sql: `string - DuckDB SQL query to execute. Table name is "${this.tableNames[0] || ''}". Use double quotes for column names with spaces.`,
      };
    }
    return {
      sql: `string - DuckDB SQL query to execute. Tables (one per uploaded file): ${this.tableNames.map(t => `"${t}"`).join(', ')}. Use double quotes for table/column names with spaces.`,
    };
  }

  protected getToolOutputSchema(): SourceTool['outputSchema'] {
    return {
      description: `Query results from ${this.config.name}. Output columns depend on the SELECT clause in the SQL query.`,
      fields: [
        { name: 'data', type: 'array', description: 'Array of result rows with columns matching the SQL SELECT clause' },
        { name: 'count', type: 'number', description: 'Number of rows returned' },
      ],
    };
  }
}
