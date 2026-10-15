/**
 * Excel Source Instance — DuckDB-backed
 *
 * Loads Excel (.xlsx) files into DuckDB in-memory tables (one per sheet).
 * Queries run as real SQL, enabling full aggregation, joins, and analytics.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import {
  BaseSource,
  SourceSchema,
  QueryResult,
  SourceTool,
  SchemaEntity,
  SchemaField,
  inferColumnTypes,
  ensureXlsxConverted,
} from '../core';
import {
  isURL,
  downloadFileFromURL,
  downloadFileFromR2,
  getSourceDbPath,
  deleteSourceCsvDir,
  fileFingerprint,
  readSourceMeta,
  writeSourceMeta,
  deleteSourceMeta,
} from '../core/file-storage';
import { processCsvFile } from '../core/pii-redactor';

interface ExcelConfig {
  filePath: string;
  /**
   * R2 object key when the file was uploaded via the multipart R2 flow.
   * If set and `filePath` doesn't exist locally (e.g. after a backend restart
   * on a fresh disk), connect() re-downloads the file from R2.
   */
  r2Key?: string;
  sheets?: string[];
  headerRow?: number;
  refreshInterval?: number;
  /** PII columns to mask on load (persisted opt-in). entity = sheet name. */
  redactColumns?: Array<{ entity: string; column: string }>;
  /** PII columns to drop entirely on load (persisted opt-in). entity = sheet name. */
  dropColumns?: Array<{ entity: string; column: string }>;
}

export class ExcelInstance extends BaseSource {
  private db: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private tableNames: string[] = [];
  private lastLoaded: Date | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private originalUrl: string | null = null;
  private isRefreshing: boolean = false;
  public onPostRefresh: (() => Promise<void>) | null = null;
  /**
   * Optional live progress sink for the xlsx→CSV conversion, set by the upload
   * handler so progress shows even when the PII gate isn't running (PII off).
   * No-op when the conversion is reused from a prior run (nothing to convert).
   */
  public onConvertProgress:
    | ((info: { sheetName: string; sheetIndex: number; rows: number; done: boolean }) => void)
    | null = null;
  /** Optional live progress sink for per-sheet PII redaction (set by the upload handler). */
  public onRedactProgress:
    | ((info: { sheetName: string; rows: number; total: number; done: boolean }) => void)
    | null = null;
  /** Optional live progress sink for loading each sheet into DuckDB (set by the upload handler). */
  public onLoadProgress:
    | ((info: { sheetName: string; index: number; total: number }) => void)
    | null = null;

  private getConnectionConfig(): ExcelConfig {
    return this.config.config as ExcelConfig;
  }

  /** Every sheet is user-curated — never strip "TEMP_"/"BACKUP_"/date-stamped sheets. */
  protected filtersJunkTables(): boolean {
    return false;
  }

  /**
   * Load Excel file into DuckDB in-memory tables
   */
  async connect(): Promise<void> {
    const cfg = this.getConnectionConfig();

    try {
      // Clean up any existing connection
      await this.cleanup();

      let localPath = cfg.filePath;

      // If filePath is a URL, download it first
      if (isURL(cfg.filePath)) {
        // Preserve the original URL for future re-downloads
        if (!this.originalUrl) {
          this.originalUrl = cfg.filePath;
        }
        localPath = await downloadFileFromURL(
          cfg.filePath,
          this.config.projectId,
          this.config.id,
        );
        (this.config.config as any).filePath = localPath;
      }

      // R2-backed source — re-hydrate the local cache if the file is missing.
      // This happens after backend restarts on a fresh disk.
      if (cfg.r2Key && (!localPath || !fs.existsSync(localPath))) {
        console.log(`[ExcelInstance] Local file missing, re-downloading from R2: ${cfg.r2Key}`);
        localPath = await downloadFileFromR2(
          cfg.r2Key,
          this.config.projectId,
          this.config.id,
          localPath ? path.basename(localPath) : undefined,
        );
        (this.config.config as any).filePath = localPath;
      }

      if (!fs.existsSync(localPath)) {
        throw new Error(`File not found: ${localPath}`);
      }

      const dbPath = this.getDbPath();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });

      // Build cache: if a prior run already built a .duckdb from this exact file
      // (same size+mtime), reuse it instead of re-streaming and re-typing the
      // whole workbook. This is what makes a pm2 restart cheap for large files —
      // the expensive rebuild only runs when the source file actually changed.
      const fingerprint = fileFingerprint(localPath);
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
          console.log(`[ExcelInstance] Reused cached DuckDB for ${localPath} (unchanged since ${meta.builtAt}; ${this.tableNames.length} sheets: ${this.tableNames.join(', ')})`);
          this.startRefreshTimer();
          return;
        } catch (reuseErr) {
          // Cached DB missing/corrupt (e.g. killed mid-write) — fall back to rebuild.
          const msg = reuseErr instanceof Error ? reuseErr.message : String(reuseErr);
          console.warn(`[ExcelInstance] Cached DuckDB unusable, rebuilding: ${msg}`);
          await this.cleanup();
        }
      }

      // Rebuild path — drop any stale .duckdb from prior runs.
      try { fs.unlinkSync(dbPath); } catch {}

      // Create DuckDB file-backed instance — data spills to disk so RAM stays
      // bounded by OS page cache + working memory rather than full file size.
      this.db = await DuckDBInstance.create(dbPath);
      this.connection = await this.db.connect();

      // Per-source DuckDB caps. read_csv is streaming, so the 1 GB cap mainly
      // gates working memory for GROUP BY / sort / join rather than the load
      // itself. 4 threads strikes a balance between single-source throughput
      // and cross-source contention.
      await this.connection.run(`PRAGMA memory_limit='1GB'`);
      await this.connection.run(`PRAGMA threads=4`);

      // Stream the workbook to one CSV per sheet on disk. exceljs reads the
      // worksheet XML row by row, so memory stays flat even for multi-GB files —
      // unlike DuckDB's read_xlsx, which buffers the whole sheet into memory and
      // is what made large uploads OOM the process. We then load those CSVs with
      // DuckDB's streaming read_csv: the same bounded path the CSV source
      // already uses comfortably for 1 GB files.
      // Convert the workbook to per-sheet CSVs — or REUSE a conversion the PII gate
      // already produced from this exact xlsx (matched by fingerprint), so the
      // workbook is read only once across detect + build. ensureXlsxConverted also
      // writes the sheet → CSV manifest the federation layer reads.
      const converted = await ensureXlsxConverted(localPath, this.config.projectId, this.config.id, {
        sheets: cfg.sheets,
        logPrefix: '[ExcelInstance]',
        onProgress: this.onConvertProgress ?? undefined,
      }, cfg.r2Key);

      // PII redaction (persisted opt-in). Mask the chosen columns in the CONVERTED
      // per-sheet CSVs — never the .xlsx. Re-applied on every rebuild, so it stays
      // masked even though connect() re-derives the CSVs from the workbook. The
      // converted CSVs are always header=true, comma-delimited (see read_csv below).
      const redactTargets = cfg.redactColumns || [];
      const dropTargets = cfg.dropColumns || [];
      if (redactTargets.length > 0 || dropTargets.length > 0) {
        for (const { sheetName, csvPath } of converted) {
          const redactCols = redactTargets.filter((r) => r.entity === sheetName).map((r) => r.column);
          const dropCols = dropTargets.filter((r) => r.entity === sheetName).map((r) => r.column);
          if (redactCols.length === 0 && dropCols.length === 0) continue;
          // Announce the sheet BEFORE the (slow) read so the toast flips to
          // "Redacting <sheet>…" immediately, not after the sheet is finished.
          this.onRedactProgress?.({ sheetName, rows: 0, total: 0, done: false });
          const result = await processCsvFile(csvPath, {
            redactColumns: redactCols,
            dropColumns: dropCols,
            delimiter: ',',
            hasHeader: true,
            onProgress: (info) =>
              this.onRedactProgress?.({ sheetName, rows: info.rows, total: info.total, done: info.done }),
          });
          console.log(`[ExcelInstance] PII policy applied to sheet "${sheetName}": ${result.cellsRedacted} cell(s) masked, ${result.columnsDropped} column(s) dropped`);
        }
      }

      // Load each converted sheet as a DuckDB table named after the sheet.
      // all_varchar=true mirrors the CSV source — every column starts as text
      // and inferColumnTypes() re-types dates/numbers afterward.
      this.tableNames = [];
      let loadIndex = 0;
      for (const { sheetName, csvPath } of converted) {
        const tableName = sheetName;
        loadIndex++;
        this.onLoadProgress?.({ sheetName, index: loadIndex, total: converted.length });
        const escapedCsv = csvPath.replace(/'/g, "''");
        await this.connection.run(
          `CREATE TABLE "${tableName}" AS SELECT * FROM read_csv('${escapedCsv}', header=true, delim=',', quote='"', escape='"', all_varchar=true)`
        );

        // Remove totals/summary rows — Excel files commonly have a totals row at
        // the bottom that would cause double-counting in aggregations.
        await this.removeTotalsRows(tableName);

        this.tableNames.push(tableName);
      }

      // Re-type the all_varchar columns: dates (serial, then text) first so an
      // Excel serial date isn't grabbed by the numeric pass, then numbers.
      for (const table of this.tableNames) {
        await inferColumnTypes(this.connection!, table, '[ExcelInstance]');
      }

      this.lastLoaded = new Date();
      this.setConnected(true);

      // Log loaded table info
      for (const table of this.tableNames) {
        try {
          const cnt = await this.connection.runAndReadAll(`SELECT COUNT(*) as cnt FROM "${table}"`);
          const rowCount = (cnt.getRowObjects() as any[])[0]?.cnt;
          console.log(`[ExcelInstance] Table "${table}": ${rowCount} rows`);
        } catch {
          // ignore
        }
      }

      console.log(`[ExcelInstance] Loaded ${localPath} into DuckDB (${this.tableNames.length} sheets: ${this.tableNames.join(', ')})`);

      // Flush the WAL into the .duckdb file so the on-disk DB is self-contained.
      // Without this, a kill before a clean DuckDB shutdown leaves an
      // un-checkpointed WAL that can fail to replay on the next open (DuckDB
      // "GetDefaultDatabase" assertion), needlessly forcing a full rebuild.
      // Best-effort — a failed checkpoint only risks a rebuild next start.
      try {
        await this.connection.run(`CHECKPOINT`);
      } catch (checkpointErr) {
        console.warn(`[ExcelInstance] Checkpoint after build failed:`, checkpointErr);
      }

      // Record the build cache key so the next restart can reuse this .duckdb.
      // Re-fingerprint after the build in case the source file's stat changed.
      const builtFingerprint = fileFingerprint(localPath);
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
      throw new Error(`Failed to load Excel file into DuckDB: ${errorMsg}`);
    }
  }

  /**
   * Open an already-built .duckdb and rediscover its tables, without rebuilding.
   * Used by the build-cache fast path in connect(). Throws if the DB can't be
   * opened or has no tables (caller then falls back to a full rebuild).
   */
  private async openExistingDb(dbPath: string): Promise<void> {
    this.db = await DuckDBInstance.create(dbPath);
    this.connection = await this.db.connect();
    await this.connection.run(`PRAGMA memory_limit='1GB'`);
    await this.connection.run(`PRAGMA threads=4`);

    const res = await this.connection.runAndReadAll(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name`
    );
    this.tableNames = (res.getRowObjects() as Array<{ table_name: string }>).map(r => r.table_name);
    if (this.tableNames.length === 0) {
      throw new Error('cached DuckDB has no tables');
    }
  }

  /**
   * Detect and remove totals/summary rows from a loaded table.
   *
   * Excel files commonly have a "Total" or "Grand Total" row at the bottom
   * which contains aggregated values. If left in, SUM/AVG queries double-count.
   *
   * Strategy: check the first text column in the last few rows for keywords
   * like "total", "grand total", "sum", "subtotal", etc.
   */
  private async removeTotalsRows(tableName: string): Promise<void> {
    try {
      // Get column info to find text columns (likely label columns)
      const desc = await this.connection!.runAndReadAll(`DESCRIBE "${tableName}"`);
      const cols = desc.getRowObjects() as Array<{ column_name: string; column_type: string }>;

      // Find text/varchar columns — totals labels are usually in text columns
      const textCols = cols.filter(c =>
        c.column_type.toUpperCase().includes('VARCHAR') ||
        c.column_type.toUpperCase().includes('TEXT')
      );

      if (textCols.length === 0) return;

      // Build a WHERE clause that matches totals-like values in any text column
      const totalsPatterns = ['total', 'grand total', 'subtotal', 'sum', 'totals'];
      const conditions = textCols.map(col => {
        const patterns = totalsPatterns.map(p => `LOWER(TRIM("${col.column_name}")) = '${p}'`).join(' OR ');
        return `(${patterns})`;
      }).join(' OR ');

      // Count how many rows match
      const countResult = await this.connection!.runAndReadAll(
        `SELECT COUNT(*) as cnt FROM "${tableName}" WHERE ${conditions}`
      );
      const matchCount = Number((countResult.getRowObjects() as any[])[0]?.cnt || 0);

      if (matchCount > 0) {
        // Delete the totals rows
        await this.connection!.run(
          `DELETE FROM "${tableName}" WHERE ${conditions}`
        );
        console.log(`[ExcelInstance] Removed ${matchCount} totals/summary row(s) from "${tableName}"`);
      }
    } catch (e) {
      // Non-critical — if detection fails, keep all rows
      console.warn(`[ExcelInstance] Totals row detection skipped for "${tableName}":`, e);
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
    console.log(`[ExcelInstance] Background refresh scheduled every ${intervalMinutes} minutes for: ${this.getName()}`);

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
   * Refresh the data — re-download (if URL) and reload DuckDB.
   * Can be called manually or by the background timer.
   */
  async refresh(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    try {
      console.log(`[ExcelInstance] Refreshing data for: ${this.getName()}`);

      // If originally a URL, re-download by restoring the URL before reconnecting
      if (this.originalUrl) {
        (this.config.config as any).filePath = this.originalUrl;
      }

      await this.connect();
      console.log(`[ExcelInstance] Refresh complete for: ${this.getName()}`);

      // Notify manager to re-extract schema and refresh tools
      if (this.onPostRefresh) {
        await this.onPostRefresh();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ExcelInstance] Refresh failed for ${this.getName()}: ${errorMsg}`);
    } finally {
      this.isRefreshing = false;
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
      // Ignore cleanup errors
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
    // Drop the on-disk DuckDB file, converted CSVs, and build-cache meta —
    // connect() rebuilds all of them from the source xlsx.
    try { fs.unlinkSync(this.getDbPath()); } catch {}
    deleteSourceCsvDir(this.config.projectId, this.config.id);
    deleteSourceMeta(this.config.projectId, this.config.id);
    this.lastLoaded = null;
    this.setConnected(false);
    console.log(`[ExcelInstance] Unloaded ${this.getName()}`);
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
   * Extract schema from DuckDB tables
   */
  async extractSchema(): Promise<SourceSchema> {
    await this.ensureLoaded();

    const entities: SchemaEntity[] = [];

    for (const tableName of this.tableNames) {
      // Get column info using DESCRIBE
      const descResult = await this.connection!.runAndReadAll(
        `DESCRIBE "${tableName}"`
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
        `SELECT COUNT(*) as cnt FROM "${tableName}"`
      );
      const countRows = countResult.getRowObjects() as Array<{ cnt: number | bigint }>;
      const rowCount = Number(countRows[0]?.cnt || 0);

      // Skip empty sheets — no data to query, saves schema tokens
      if (rowCount === 0) {
        console.log(`[ExcelInstance] Skipping empty sheet "${tableName}"`);
        continue;
      }

      // Build fields with sample values
      const fields: SchemaField[] = [];
      for (const col of columns) {
        const normalizedType = this.normalizeType(col.column_type);

        // Get sample values for each column
        let sampleValues: any[] = [];
        try {
          const sampleResult = await this.connection!.runAndReadAll(
            `SELECT DISTINCT "${col.column_name}" FROM "${tableName}" WHERE "${col.column_name}" IS NOT NULL LIMIT 5`
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
    console.log(`[ExcelInstance] Extracted schema: ${entities.length} sheets, tables: ${this.tableNames.join(', ')}`);
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
    const cfg = this.getConnectionConfig();
    const schemaInfo = this.formatSchemaForMainAgent();
    const fileName = path.basename(cfg.filePath);
    const sourceContext = this.getSourceContext();
    const domainHints = this.getDataDomainHints();

    const tableList = this.tableNames.map(t => `"${t}"`).join(', ');

    return `Query ${this.config.name} (Excel file: ${fileName}, loaded into DuckDB SQL engine).${sourceContext}${domainHints}

Available tables (one per sheet): ${tableList}
${schemaInfo}

This source supports full DuckDB SQL including:
- Aggregations: SUM, AVG, COUNT, MIN, MAX, MEDIAN, STDDEV, PERCENTILE_CONT, etc.
- GROUP BY, HAVING, ORDER BY, LIMIT
- Window functions: ROW_NUMBER, RANK, LAG, LEAD, SUM OVER, etc.
- Cross-sheet JOINs between tables (each sheet is a table)
- String functions, date functions, CASE WHEN, subqueries, CTEs
- Table names with spaces must be quoted: SELECT * FROM "My Sheet"
- Column names with spaces must be quoted: SELECT "Column Name" FROM "Sheet1"`;
  }

  protected getToolParams(): Record<string, string> {
    return {
      sql: `string - DuckDB SQL query to execute. Tables are sheet names: ${this.tableNames.map(t => `"${t}"`).join(', ')}. Use double quotes for table/column names with spaces.`,
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
