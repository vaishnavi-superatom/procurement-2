/**
 * Federation Instance — DuckDB-backed cross-source query layer
 *
 * Creates a single shared DuckDB instance per project that can query across
 * ALL data sources through one SQL interface:
 * - Postgres: attached via postgres_scanner (live, zero-copy)
 * - MySQL: attached via mysql_scanner (live, zero-copy)
 * - Excel/CSV: tables loaded into DuckDB memory
 * - MSSQL: deferred (will be synced to memory in future)
 *
 * Components use this federation layer to JOIN data across sources.
 * Chat (source agents) continue to query individual sources directly.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { getSourceCsvDir, readSourceCsvManifest } from '../core/file-storage';
import { assertReadOnlySql } from '../core/sql-guard';
import { rewriteSql } from '../core/sql-rewrite';
import { resolvePolicies } from '../core/policy-gate';
import { raceWithAbort } from '../core/base-source';
import {
  SourceConfig,
  SourceInstance,
  SourceSchema,
  SourceTool,
  QueryResult,
  SchemaEntity,
} from '../core/types';

interface AttachedSource {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  schemaPrefix: string;
  entities: SchemaEntity[];
}

export class FederationInstance {
  private db: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private attachedSources: Map<string, AttachedSource> = new Map();
  private extensionsLoaded: Set<string> = new Set();

  /**
   * Create the shared DuckDB in-memory instance
   */
  async initialize(): Promise<void> {
    try {
      this.db = await DuckDBInstance.create(':memory:');
      this.connection = await this.db.connect();
      // Bound working memory and give DuckDB an on-disk spill location, so a
      // cross-source query over large file sources spills to disk (or errors
      // gracefully) instead of OOM-killing the whole process. Combined with the
      // VIEWs below — which don't materialize any source data at startup — this
      // keeps both boot and query-time memory bounded.
      try {
        const tmpDir = path.resolve(process.cwd(), 'duckdb', '.federation-tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        await this.connection.run(`PRAGMA memory_limit='1GB'`);
        await this.connection.run(`PRAGMA temp_directory='${tmpDir.replace(/'/g, "''")}'`);
        await this.connection.run(`PRAGMA threads=4`);
      } catch (cfgErr) {
        console.warn('[Federation] Could not apply memory/temp PRAGMAs:', cfgErr);
      }
      console.log('[Federation] Shared DuckDB instance created');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create federation DuckDB: ${msg}`);
    }
  }

  /**
   * Load an extension if not already loaded
   */
  private async loadExtension(name: string): Promise<void> {
    if (this.extensionsLoaded.has(name)) return;
    if (!this.connection) throw new Error('Federation not initialized');

    try {
      await this.connection.run(`INSTALL ${name}`);
      await this.connection.run(`LOAD ${name}`);
      this.extensionsLoaded.add(name);
      console.log(`[Federation] Extension loaded: ${name}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load DuckDB extension '${name}': ${msg}`);
    }
  }

  // ============================================
  // Attach Sources
  // ============================================

  /**
   * Attach a Postgres source via postgres_scanner (live, read-only)
   */
  async attachPostgres(sourceId: string, config: SourceConfig): Promise<void> {
    if (!this.connection) throw new Error('Federation not initialized');

    const prefix = this.sanitizePrefix(config.name);
    const cfg = config.config as {
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      schema?: string;
    };

    try {
      await this.loadExtension('postgres_scanner');

      // Detach if already attached (e.g. on reload)
      await this.safeDetach(prefix);

      const connStr = `host=${cfg.host} port=${cfg.port || 5432} dbname=${cfg.database} user=${cfg.user} password=${cfg.password}`;
      await this.connection.run(
        `ATTACH '${connStr.replace(/'/g, "''")}' AS "${prefix}" (TYPE POSTGRES, READ_ONLY)`
      );

      // Build entity list from the source's cached schema
      const entities = this.getEntitiesFromConfig(config, prefix);

      this.attachedSources.set(sourceId, {
        sourceId,
        sourceName: config.name,
        sourceType: 'postgres',
        schemaPrefix: prefix,
        entities,
      });

      console.log(`[Federation] Attached Postgres: "${prefix}" (${cfg.host}/${cfg.database})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Federation] Failed to attach Postgres "${config.name}": ${msg}`);
      // Don't throw — federation is optional, other sources should still work
    }
  }

  /**
   * Attach a MySQL source via mysql_scanner (live, read-only)
   */
  async attachMySQL(sourceId: string, config: SourceConfig): Promise<void> {
    if (!this.connection) throw new Error('Federation not initialized');

    const prefix = this.sanitizePrefix(config.name);
    const cfg = config.config as {
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
    };

    try {
      await this.loadExtension('mysql_scanner');

      await this.safeDetach(prefix);

      const connStr = `host=${cfg.host} port=${cfg.port || 3306} database=${cfg.database} user=${cfg.user} password=${cfg.password}`;
      await this.connection.run(
        `ATTACH '${connStr.replace(/'/g, "''")}' AS "${prefix}" (TYPE MYSQL, READ_ONLY)`
      );

      const entities = this.getEntitiesFromConfig(config, prefix);

      this.attachedSources.set(sourceId, {
        sourceId,
        sourceName: config.name,
        sourceType: 'mysql',
        schemaPrefix: prefix,
        entities,
      });

      console.log(`[Federation] Attached MySQL: "${prefix}" (${cfg.host}/${cfg.database})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Federation] Failed to attach MySQL "${config.name}": ${msg}`);
    }
  }

  /**
   * Expose an Excel source's sheets in the federation DuckDB as VIEWs. Views
   * don't materialize data at startup, so a large workbook no longer OOMs at
   * boot. Each view reads the per-sheet CSV produced during the build via
   * streaming read_csv (memory-safe); read_xlsx is only a fallback for a sheet
   * whose CSV is missing. Query-time memory is bounded by the connection's
   * memory_limit + temp_directory.
   */
  async loadExcelTables(sourceId: string, config: SourceConfig, instance: SourceInstance): Promise<void> {
    if (!this.connection) throw new Error('Federation not initialized');

    const prefix = this.sanitizePrefix(config.name);
    const cfg = config.config as { filePath: string; sheets?: string[] };

    try {
      await this.loadExtension('excel');

      // Drop old schema if reloading
      await this.safeDropSchema(prefix);

      // Create schema for this source
      await this.connection.run(`CREATE SCHEMA IF NOT EXISTS "${prefix}"`);

      const escapedPath = cfg.filePath.replace(/'/g, "''");

      // Get table names from the instance's schema
      const schema = instance.getSchema();
      if (!schema || schema.entities.length === 0) {
        console.warn(`[Federation] No schema for Excel source "${config.name}", skipping`);
        return;
      }

      const csvDir = getSourceCsvDir(config.projectId, sourceId);
      const csvManifest = readSourceCsvManifest(config.projectId, sourceId);
      const loadedTables: string[] = [];

      for (const entity of schema.entities) {
        const tableName = entity.name;

        // Prefer the per-sheet CSV produced during the build — read_csv streams,
        // so it's memory-safe even for huge sheets. The manifest maps each sheet
        // to its exact CSV file. Fall back to read_xlsx (which buffers the whole
        // sheet) only when the CSV is missing (e.g. a legacy source built before
        // the manifest existed, or the CSVs were cleaned up).
        const csvFile = csvManifest?.get(tableName);
        const csvPath = csvFile ? path.join(csvDir, csvFile) : null;

        let readExpr: string;
        if (csvPath && fs.existsSync(csvPath)) {
          const escapedCsv = csvPath.replace(/'/g, "''");
          readExpr = `read_csv('${escapedCsv}', header=true, delim=',', quote='"', escape='"', all_varchar=true)`;
        } else {
          const escapedSheet = tableName.replace(/'/g, "''");
          const sheetClause = tableName === 'data' ? '' : `, sheet='${escapedSheet}'`;
          readExpr = `read_xlsx('${escapedPath}'${sheetClause}, header=true, all_varchar=true)`;
        }

        try {
          await this.connection.run(
            `CREATE VIEW "${prefix}"."${tableName}" AS SELECT * FROM ${readExpr}`
          );
          loadedTables.push(tableName);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Federation] Failed to load Excel sheet "${tableName}" into "${prefix}": ${msg}`);
        }
      }

      this.attachedSources.set(sourceId, {
        sourceId,
        sourceName: config.name,
        sourceType: 'excel',
        schemaPrefix: prefix,
        entities: schema.entities,
      });

      console.log(`[Federation] Loaded Excel: "${prefix}" (${loadedTables.length} sheets: ${loadedTables.join(', ')})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Federation] Failed to load Excel "${config.name}": ${msg}`);
    }
  }

  /**
   * Expose a (possibly multi-file) CSV source as VIEWs, one per uploaded file
   * — mirrors loadExcelTables. Views don't materialize data at startup;
   * read_csv streams on demand at query time.
   */
  async loadCSVTables(sourceId: string, config: SourceConfig, instance: SourceInstance): Promise<void> {
    if (!this.connection) throw new Error('Federation not initialized');

    const prefix = this.sanitizePrefix(config.name);
    const cfg = config.config as {
      filePath?: string;
      files?: Array<{ filePath: string; tableName?: string }>;
      delimiter?: string;
      hasHeader?: boolean;
    };

    try {
      await this.safeDropSchema(prefix);
      await this.connection.run(`CREATE SCHEMA IF NOT EXISTS "${prefix}"`);

      const schema = instance.getSchema();
      if (!schema || schema.entities.length === 0) {
        console.warn(`[Federation] No schema for CSV source "${config.name}", skipping`);
        return;
      }

      const delimiter = cfg.delimiter || ',';
      const header = cfg.hasHeader !== false;

      // Map table name -> local file path. Multi-file sources carry this in
      // config.files; legacy single-file sources have exactly one table/file.
      const pathByTable = new Map<string, string>();
      if (cfg.files && cfg.files.length > 0) {
        for (const f of cfg.files) {
          if (f.tableName) pathByTable.set(f.tableName, f.filePath);
        }
      } else if (cfg.filePath && schema.entities[0]) {
        pathByTable.set(schema.entities[0].name, cfg.filePath);
      }

      const loadedTables: string[] = [];
      for (const entity of schema.entities) {
        const filePath = pathByTable.get(entity.name);
        if (!filePath) {
          console.warn(`[Federation] No file path for table "${entity.name}" in "${config.name}", skipping`);
          continue;
        }
        const escapedPath = filePath.replace(/'/g, "''");
        const escapedTable = entity.name.replace(/"/g, '""');
        try {
          await this.connection.run(
            `CREATE VIEW "${prefix}"."${escapedTable}" AS SELECT * FROM read_csv('${escapedPath}', header=${header}, delim='${delimiter}', all_varchar=true)`
          );
          loadedTables.push(entity.name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Federation] Failed to load CSV table "${entity.name}" into "${prefix}": ${msg}`);
        }
      }

      this.attachedSources.set(sourceId, {
        sourceId,
        sourceName: config.name,
        sourceType: 'csv',
        schemaPrefix: prefix,
        entities: schema.entities,
      });

      console.log(`[Federation] Loaded CSV: "${prefix}" (${loadedTables.length} table(s): ${loadedTables.join(', ')})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Federation] Failed to load CSV "${config.name}": ${msg}`);
    }
  }

  // ============================================
  // Detach / Cleanup
  // ============================================

  /**
   * Remove a source from federation
   */
  async detachSource(sourceId: string): Promise<void> {
    const attached = this.attachedSources.get(sourceId);
    if (!attached) return;

    const { schemaPrefix, sourceType } = attached;

    try {
      if (sourceType === 'postgres' || sourceType === 'mysql') {
        await this.safeDetach(schemaPrefix);
      } else {
        await this.safeDropSchema(schemaPrefix);
      }
    } catch (error) {
      console.warn(`[Federation] Error detaching "${schemaPrefix}":`, error);
    }

    this.attachedSources.delete(sourceId);
    console.log(`[Federation] Detached source: ${attached.sourceName} ("${schemaPrefix}")`);
  }

  /**
   * Safely DETACH a database (Postgres/MySQL)
   */
  private async safeDetach(prefix: string): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.run(`DETACH IF EXISTS "${prefix}"`);
    } catch {
      // Ignore — may not be attached
    }
  }

  /**
   * Safely DROP a schema and all its tables (Excel/CSV)
   */
  private async safeDropSchema(prefix: string): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.run(`DROP SCHEMA IF EXISTS "${prefix}" CASCADE`);
    } catch {
      // Ignore
    }
  }

  /**
   * Shutdown the federation DuckDB instance
   */
  async shutdown(): Promise<void> {
    // Detach all attached database sources
    for (const [sourceId, attached] of this.attachedSources) {
      if (attached.sourceType === 'postgres' || attached.sourceType === 'mysql') {
        await this.safeDetach(attached.schemaPrefix);
      }
    }

    if (this.connection) {
      try {
        this.connection.closeSync();
      } catch {
        // Ignore
      }
      this.connection = null;
    }

    if (this.db) {
      try {
        this.db.closeSync();
      } catch {
        // Ignore
      }
    }

    this.db = null;
    this.attachedSources.clear();
    this.extensionsLoaded.clear();
    console.log('[Federation] Shutdown complete');
  }

  // ============================================
  // Query Execution
  // ============================================

  /**
   * Execute SQL against the federation DuckDB. `signal` is accepted for
   * interface parity with SourceInstance.execute (raceWithAbort passes it
   * through) but unused — DuckDB queries here don't support cancellation;
   * the caller still unblocks promptly via raceWithAbort regardless.
   */
  async execute(params: { sql: string }, signal?: AbortSignal): Promise<QueryResult> {
    if (!this.connection) throw new Error('Federation not initialized');

    let { sql } = params;
    const startTime = Date.now();

    // Authorization seam. Federation is not a BaseSource, so it calls the
    // rewriter directly rather than through prepareSql — same two layers, same
    // order: regex guard, then AST rewrite. Always read-only: this runs DuckDB
    // over live attached sources.
    assertReadOnlySql(sql, 'federation');
    // Federation has no project_sources row of its own; 'federation' is its id
    // here, so a policy must name that explicitly to apply.
    const fedPolicy = resolvePolicies('federation', 'federation');
    sql = (await rewriteSql(sql, {
      sourceType: 'federation',
      sourceName: 'federation',
      policies: fedPolicy.policies,
      readableTables: fedPolicy.readableTables,
    })).sql;

    try {
      console.log(`[Federation] Executing:`, sql.substring(0, 150) + (sql.length > 150 ? '...' : ''));

      const result = await this.connection.runAndReadAll(sql);
      const data = result.getRowObjectsJson() as any[];

      console.log(`[Federation] Query returned ${data.length} rows (${Date.now() - startTime}ms)`);

      return {
        data,
        count: data.length,
        metadata: {
          executionTime: Date.now() - startTime,
          totalCount: data.length,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Federation query failed: ${msg}\nSQL: ${sql}`);
    }
  }

  // ============================================
  // Tool Generation
  // ============================================

  /**
   * Get the federation tool for LLM
   */
  getTool(): SourceTool {
    const schemaDescription = this.buildFederatedSchemaDescription();

    return {
      id: 'federation_query',
      name: 'Cross-Source Query',
      description: `Query across ALL data sources using DuckDB SQL. Use this tool ONLY when you need to JOIN or combine data from multiple sources in a SINGLE query. For single-source queries, use the specific source tool instead.

${schemaDescription}

IMPORTANT RULES:
- Always use schema-qualified table names: "schema_name"."table_name"
- For Postgres/MySQL sources: tables are accessed as "schema_name"."db_schema"."table_name" (e.g., "my_postgres"."public"."orders")
- For Excel/CSV sources: tables are accessed as "schema_name"."sheet_or_table_name" (e.g., "sales_data"."Sheet1")
- Table and column names with spaces MUST be double-quoted
- This uses DuckDB SQL syntax (supports JOINs, CTEs, window functions, aggregations, subqueries)
- All attached database sources (Postgres/MySQL) are READ_ONLY — no INSERT/UPDATE/DELETE`,
      toolType: 'source',
      fullSchema: schemaDescription,
      params: {
        sql: 'string - DuckDB SQL query using schema-qualified table names to join across multiple sources',
      },
      fn: async (input: any, signal?: AbortSignal) => {
        const result = await raceWithAbort((s) => this.execute(input, s), signal);
        // Safety cap: truncate large results
        const maxRows = 500;
        if (result.data && result.data.length > maxRows) {
          const totalCount = result.data.length;
          result.data = result.data.slice(0, maxRows);
          result.count = result.data.length;
          result.metadata = {
            ...result.metadata,
            truncated: true,
            totalCount,
          };
        }
        return result;
      },
      outputSchema: {
        description: 'Cross-source query results. Output columns depend on the SELECT clause.',
        fields: [
          { name: 'data', type: 'array', description: 'Array of result rows' },
          { name: 'count', type: 'number', description: 'Number of rows returned' },
        ],
      },
    };
  }

  /**
   * Build a description of all federated schemas for the LLM
   */
  private buildFederatedSchemaDescription(): string {
    if (this.attachedSources.size === 0) {
      return 'No sources attached to federation.';
    }

    const sections: string[] = ['Available sources in federation:\n'];

    for (const attached of this.attachedSources.values()) {
      const { sourceName, sourceType, schemaPrefix, entities } = attached;
      const typeLabel = sourceType === 'postgres' ? 'PostgreSQL (live)'
        : sourceType === 'mysql' ? 'MySQL (live)'
        : sourceType === 'excel' ? 'Excel (in-memory)'
        : sourceType === 'csv' ? 'CSV (in-memory)'
        : sourceType;

      let section = `--- ${sourceName} [${typeLabel}] — schema prefix: "${schemaPrefix}" ---\n`;

      if (entities.length === 0) {
        section += '  (no tables discovered)\n';
      } else {
        for (const entity of entities) {
          const tableRef = (sourceType === 'postgres' || sourceType === 'mysql')
            ? `"${schemaPrefix}"."${entity.fullName || entity.name}"`
            : `"${schemaPrefix}"."${entity.name}"`;

          // Double-underscore-prefixed columns (e.g. __source, an audit reference)
          // are internal bookkeeping — hidden from the LLM, same as the per-source tool.
          const fieldNames = entity.fields.filter(f => !f.name.startsWith('__')).map(f => f.name).join(', ');
          const rowInfo = entity.rowCount ? ` (~${entity.rowCount} rows)` : '';
          section += `  ${tableRef}${rowInfo}: ${fieldNames}\n`;
        }
      }

      sections.push(section);
    }

    return sections.join('\n');
  }

  // ============================================
  // Utilities
  // ============================================

  /**
   * Check if federation has any attached sources
   */
  hasAttachedSources(): boolean {
    return this.attachedSources.size > 0;
  }

  /**
   * Get count of attached sources
   */
  getAttachedSourceCount(): number {
    return this.attachedSources.size;
  }

  /**
   * Check if a specific source is attached
   */
  isSourceAttached(sourceId: string): boolean {
    return this.attachedSources.has(sourceId);
  }

  /**
   * Sanitize a source name into a valid DuckDB schema/database name
   */
  private sanitizePrefix(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 30) || 'source';
  }

  /**
   * Extract entity info from a source's cached schema
   */
  private getEntitiesFromConfig(config: SourceConfig, _prefix: string): SchemaEntity[] {
    if (!config.schema || !config.schema.entities) return [];
    return config.schema.entities;
  }
}
