/**
 * PostgreSQL Source Instance
 *
 * Delegates all DB I/O to a SourceTransport:
 *   • DirectPostgresTransport — pg.Pool with health checks, retry, keepalive
 *     (today's behavior, factored out).
 *   • BridgeTransport — routes {sql, params} through the db-bridge WebSocket
 *     when the source config has `bridge: true`.
 *
 * The instance still owns dialect-specific concerns: extractSchema's
 * information_schema queries, batched column-statistics SQL, named-to-positional
 * parameter conversion, tool description generation.
 */

import {
  BaseSource,
  SourceSchema,
  QueryResult,
  SourceTool,
  SchemaEntity,
  SchemaField,
} from '../core';
import { SourceTransport } from '../core/transports/source-transport';
import { DirectPostgresTransport } from '../core/transports/direct-postgres';
import { BridgeTransport } from '../core/transports/bridge-transport';

interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema?: string;
  ssl?: boolean;
  /**
   * When true, route queries through the db-bridge over WebSocket instead of
   * opening a direct connection. The host/port/user/password fields are still
   * captured in the source config (so toggling back to direct mode just works),
   * but at runtime the credentials live with the db-bridge process on the VM.
   */
  bridge?: boolean;
}

export class PostgresInstance extends BaseSource {
  private _transport: SourceTransport | null = null;

  private getConnectionConfig(): PostgresConfig {
    return this.config.config as PostgresConfig;
  }

  /**
   * Lazily build the transport based on config.bridge. The same instance lives
   * for the process lifetime, so we cache the transport once.
   */
  private get transport(): SourceTransport {
    if (this._transport) return this._transport;
    const cfg = this.getConnectionConfig();
    if (cfg.bridge) {
      this._transport = new BridgeTransport({
        wsUrl: process.env.SA_WEBSOCKET_URL || 'wss://ws.superatom.ai/websocket',
        projectId: this.config.projectId,
        apiKey: process.env.SUPERATOM_API_KEY,
        dialect: 'postgres',
      });
      console.log(`[PostgresInstance:${this.getName()}] Using BridgeTransport (projectId=${this.config.projectId})`);
    } else {
      this._transport = new DirectPostgresTransport({
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        ssl: cfg.ssl,
        schema: cfg.schema,
        logTag: this.getName(),
      });
    }
    return this._transport;
  }

  /**
   * Connect (lazy - the underlying transport opens its connection on first use).
   */
  async connect(): Promise<void> {
    try {
      if (this.transport.connect) await this.transport.connect();
      this.setConnected(true);
    } catch (error) {
      this.setConnected(false);
      throw error;
    }
  }

  /**
   * Disconnect
   */
  async disconnect(): Promise<void> {
    if (this._transport?.disconnect) {
      await this._transport.disconnect();
    }
    this._transport = null;
    this.setConnected(false);
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.transport.query('SELECT 1 AS health');
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  /** Fast (single COUNT query) candidate-table count from information_schema — see SourceInstance.estimateExtractionTime. */
  async estimateExtractionTime(): Promise<{ candidateCount: number; message: string }> {
    const result = await this.transport.query(`
      SELECT COUNT(*) AS count
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
    `);
    const candidateCount = Number(result.rows[0]?.count) || 0;
    return { candidateCount, message: `Found ${candidateCount} table(s) from information_schema, extracting schema...` };
  }

  /**
   * Extract rich schema with statistics, sample values, and descriptions
   */
  async extractSchema(): Promise<SourceSchema> {
    try {
      console.log(`[PostgresInstance:${this.getName()}] Extracting rich schema...`);

      // Get tables with row counts
      const tablesResult = await this.transport.query(`
        SELECT
          t.table_schema,
          t.table_name,
          COALESCE(
            (SELECT reltuples::bigint FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = t.table_name AND n.nspname = t.table_schema),
            0
          ) AS row_count
        FROM information_schema.tables t
        WHERE t.table_type = 'BASE TABLE'
          AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY t.table_schema, t.table_name
      `);

      // Get columns with constraints
      const columnsResult = await this.transport.query(`
        SELECT
          c.table_schema,
          c.table_name,
          c.column_name,
          c.data_type,
          c.udt_name,
          c.is_nullable,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_primary_key,
          fk.foreign_table_name AS referenced_table,
          fk.foreign_column_name AS referenced_column
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT kcu.table_schema, kcu.table_name, kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
        ) pk ON c.table_schema = pk.table_schema
          AND c.table_name = pk.table_name
          AND c.column_name = pk.column_name
        LEFT JOIN (
          SELECT
            kcu.table_schema,
            kcu.table_name,
            kcu.column_name,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
        ) fk ON c.table_schema = fk.table_schema
          AND c.table_name = fk.table_name
          AND c.column_name = fk.column_name
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
      `);

      // Build entities
      const entityMap = new Map<string, SchemaEntity>();
      const relationships: Array<{ from: string; to: string; type: 'one-to-one' | 'one-to-many' | 'many-to-many'; fromField: string; toField: string }> = [];

      let skippedEmpty = 0;
      for (const row of tablesResult.rows) {
        const rowCount = parseInt(row.row_count) || 0;

        // reltuples is an estimate and can be stale — it may report 0 for non-empty tables
        // or non-zero for empty tables. Always do a quick existence check to be sure.
        try {
          const existsResult = await this.transport.query(
            `SELECT 1 FROM "${row.table_schema}"."${row.table_name}" LIMIT 1`
          );
          if (existsResult.rows.length === 0) {
            skippedEmpty++;
            continue;
          }
        } catch {
          skippedEmpty++;
          continue;
        }

        const key = `${row.table_schema}.${row.table_name}`;
        entityMap.set(key, {
          name: row.table_name,
          fullName: key,
          description: this.generateTableDescription(row.table_name),
          fields: [],
          rowCount: rowCount || 1,
          primaryKey: [],
        });
      }
      if (skippedEmpty > 0) {
        console.log(`[PostgresInstance:${this.getName()}] Skipped ${skippedEmpty} empty tables`);
      }

      // Group columns by table for batch statistics extraction
      const tableColumns = new Map<string, Array<{ row: any; entity: SchemaEntity }>>();

      for (const row of columnsResult.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        const entity = entityMap.get(key);
        if (entity) {
          if (!tableColumns.has(key)) {
            tableColumns.set(key, []);
          }
          tableColumns.get(key)!.push({ row, entity });
        }
      }

      // Always collect full stats + sample values for all tables.
      // ≤50 tables: sequential, 51+: parallel batches of 10
      const totalTables = tableColumns.size;
      const PARALLEL_BATCH_SIZE = 10;
      const useParallel = totalTables > 50;

      if (useParallel) {
        console.log(`[PostgresInstance:${this.getName()}] [Schema] ${totalTables} tables — parallel mode (batches of ${PARALLEL_BATCH_SIZE})`);
      }

      const processTable = async (tableKey: string, columns: Array<{ row: any; entity: SchemaEntity }>) => {
        const [tableSchema, tableName] = tableKey.split('.');
        const entity = entityMap.get(tableKey)!;
        const rowCount = entity.rowCount || 0;

        const fields: Array<{ field: SchemaField; row: any }> = [];
        for (const { row } of columns) {
          const field: SchemaField = {
            name: row.column_name,
            type: this.normalizeType(row.data_type),
            nativeType: row.udt_name || row.data_type,
            nullable: row.is_nullable === 'YES',
            isPrimaryKey: row.is_primary_key,
            description: this.generateColumnDescription(tableName, row.column_name, row.data_type, row.is_primary_key, !!row.referenced_table),
          };

          if (row.is_primary_key) {
            entity.primaryKey!.push(row.column_name);
          }

          if (row.referenced_table) {
            field.isForeignKey = true;
            field.references = {
              entity: row.referenced_table,
              field: row.referenced_column,
            };
            relationships.push({
              from: tableName,
              to: row.referenced_table,
              type: 'one-to-many',
              fromField: row.column_name,
              toField: row.referenced_column,
            });
          }

          fields.push({ field, row });
          entity.fields.push(field);
        }

        if (rowCount === 0) return;

        try {
          const statsMap = await this.getBatchedColumnStatistics(tableSchema, tableName, fields.map(f => ({ column: f.row.column_name, dataType: f.row.data_type })), rowCount);
          for (const { field } of fields) {
            const stats = statsMap.get(field.name);
            if (stats) {
              field.statistics = stats;
              if (stats.cardinality) {
                (field as any).cardinality = stats.cardinality;
              }
            }
          }
        } catch (statsError) {
          console.warn(`[PostgresInstance:${this.getName()}] Could not get batched stats for ${tableKey}: ${statsError instanceof Error ? statsError.message : String(statsError)}`);
        }

        for (const { field } of fields) {
          if (field.statistics?.distinct && field.statistics.distinct <= 100) {
            try {
              const sampleValues = await this.getSampleValues(tableSchema, tableName, field.name);
              if (sampleValues && sampleValues.length > 0) {
                field.sampleValues = sampleValues;
              }
            } catch {
              // Skip silently
            }
          }
        }
      };

      const tableEntries = Array.from(tableColumns.entries());

      if (useParallel) {
        for (let i = 0; i < tableEntries.length; i += PARALLEL_BATCH_SIZE) {
          const batch = tableEntries.slice(i, i + PARALLEL_BATCH_SIZE);
          console.log(`[PostgresInstance:${this.getName()}] [Schema] Processing tables ${i + 1}-${Math.min(i + PARALLEL_BATCH_SIZE, tableEntries.length)}/${totalTables}`);
          await Promise.all(batch.map(([key, cols]) => processTable(key, cols)));
        }
      } else {
        for (const [tableKey, columns] of tableEntries) {
          await processTable(tableKey, columns);
        }
      }

      const schema: SourceSchema = {
        entities: Array.from(entityMap.values()),
        relationships,
        extractedAt: new Date().toISOString(),
      };

      this.setSchema(schema);
      console.log(`[PostgresInstance:${this.getName()}] Extracted rich schema: ${schema.entities.length} tables${skippedEmpty > 0 ? ` (skipped ${skippedEmpty} empty)` : ''}, ${relationships.length} relationships`);
      return schema;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to extract schema: ${errorMsg}`);
    }
  }

  /**
   * Get statistics for ALL columns in a table using a single batched query.
   * Returns a Map of columnName -> stats object.
   */
  private async getBatchedColumnStatistics(
    schema: string,
    table: string,
    columns: Array<{ column: string; dataType: string }>,
    rowCount: number
  ): Promise<Map<string, { distinct?: number; min?: any; max?: any; avg?: number; nonNullCount?: number; cardinality?: 'unique' | 'low' | 'medium' | 'high'; trueCount?: number; falseCount?: number }>> {
    const numericTypes = ['integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision', 'decimal'];
    const textTypes = ['character varying', 'varchar', 'text', 'char', 'character', 'uuid'];
    const dateTypes = ['date', 'timestamp', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz'];
    const boolTypes = ['boolean', 'bool'];

    const statsMap = new Map<string, any>();

    // Build a single SELECT with all column stats
    const selectParts: string[] = [];
    const columnMeta: Array<{ column: string; category: 'numeric' | 'text' | 'date' | 'bool' | 'other' }> = [];

    for (const { column, dataType } of columns) {
      const lowerType = dataType.toLowerCase();
      const col = `"${column}"`;

      if (boolTypes.includes(lowerType)) {
        selectParts.push(
          `COUNT(CASE WHEN ${col} = TRUE THEN 1 END) as "${column}__true_count"`,
          `COUNT(CASE WHEN ${col} = FALSE THEN 1 END) as "${column}__false_count"`,
          `COUNT(${col}) as "${column}__non_null_count"`
        );
        columnMeta.push({ column, category: 'bool' });
      } else if (numericTypes.includes(lowerType)) {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as "${column}__distinct_count"`,
          `COUNT(${col}) as "${column}__non_null_count"`,
          `MIN(${col}) as "${column}__min_value"`,
          `MAX(${col}) as "${column}__max_value"`,
          `AVG(${col})::numeric(15,2) as "${column}__avg_value"`
        );
        columnMeta.push({ column, category: 'numeric' });
      } else if (dateTypes.includes(lowerType)) {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as "${column}__distinct_count"`,
          `COUNT(${col}) as "${column}__non_null_count"`,
          `MIN(${col}) as "${column}__min_value"`,
          `MAX(${col}) as "${column}__max_value"`
        );
        columnMeta.push({ column, category: 'date' });
      } else if (textTypes.includes(lowerType)) {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as "${column}__distinct_count"`,
          `COUNT(${col}) as "${column}__non_null_count"`
        );
        columnMeta.push({ column, category: 'text' });
      } else {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as "${column}__distinct_count"`,
          `COUNT(${col}) as "${column}__non_null_count"`
        );
        columnMeta.push({ column, category: 'other' });
      }
    }

    if (selectParts.length === 0) return statsMap;

    try {
      const result = await this.transport.query(
        `SELECT ${selectParts.join(', ')} FROM "${schema}"."${table}"`
      );

      const row = result.rows[0];
      if (!row) return statsMap;

      // Parse the batched result row into per-column stats
      for (const { column, category } of columnMeta) {
        let stats: any = {};

        if (category === 'bool') {
          stats = {
            distinct: 2,
            nonNullCount: parseInt(row[`${column}__non_null_count`]) || 0,
            trueCount: parseInt(row[`${column}__true_count`]) || 0,
            falseCount: parseInt(row[`${column}__false_count`]) || 0,
          };
        } else if (category === 'numeric') {
          stats = {
            distinct: parseInt(row[`${column}__distinct_count`]) || 0,
            nonNullCount: parseInt(row[`${column}__non_null_count`]) || 0,
            min: row[`${column}__min_value`] != null ? Number(row[`${column}__min_value`]) : undefined,
            max: row[`${column}__max_value`] != null ? Number(row[`${column}__max_value`]) : undefined,
            avg: row[`${column}__avg_value`] != null ? Number(row[`${column}__avg_value`]) : undefined,
          };
        } else if (category === 'date') {
          stats = {
            distinct: parseInt(row[`${column}__distinct_count`]) || 0,
            nonNullCount: parseInt(row[`${column}__non_null_count`]) || 0,
            min: row[`${column}__min_value`] ? String(row[`${column}__min_value`]).split('T')[0] : undefined,
            max: row[`${column}__max_value`] ? String(row[`${column}__max_value`]).split('T')[0] : undefined,
          };
        } else {
          stats = {
            distinct: parseInt(row[`${column}__distinct_count`]) || 0,
            nonNullCount: parseInt(row[`${column}__non_null_count`]) || 0,
          };
        }

        // Calculate cardinality classification
        if (stats.distinct !== undefined && rowCount > 0) {
          stats.cardinality = this.determineCardinality(stats.distinct, rowCount);
        }

        statsMap.set(column, stats);
      }
    } catch {
      // If batched query fails, return empty map
    }

    return statsMap;
  }

  /**
   * Determine cardinality level based on distinct count vs total rows
   */
  private determineCardinality(distinctCount: number, totalCount: number): 'unique' | 'low' | 'medium' | 'high' {
    if (totalCount === 0) return 'low';

    const ratio = distinctCount / totalCount;

    // Unique: 95%+ distinct or matches total
    if (ratio >= 0.95 || distinctCount === totalCount) {
      return 'unique';
    }
    // Low: 5% or less distinct values, good for GROUP BY
    if (ratio <= 0.05 || distinctCount <= 10) {
      return 'low';
    }
    // Medium: 5-25% distinct values
    if (ratio <= 0.25 || distinctCount <= 100) {
      return 'medium';
    }
    // High: more than 25% distinct values
    return 'high';
  }

  /**
   * Get sample values for low cardinality columns
   */
  private async getSampleValues(
    schema: string,
    table: string,
    column: string
  ): Promise<string[] | null> {
    try {
      const result = await this.transport.query(`
        SELECT DISTINCT "${column}"
        FROM "${schema}"."${table}"
        WHERE "${column}" IS NOT NULL
        ORDER BY "${column}"
        LIMIT 50
      `);
      return result.rows.map((r: any) => String(r[column])).filter((v: string) => v !== 'null' && v !== '');
    } catch {
      return null;
    }
  }

  /**
   * Generate table description based on name patterns
   */
  private generateTableDescription(tableName: string): string {
    const patterns: Record<string, string> = {
      'users': 'User accounts and profiles',
      'customers': 'Customer master data',
      'products': 'Product catalog',
      'orders': 'Customer orders',
      'order_items': 'Line items within orders',
      'invoices': 'Invoice records',
      'payments': 'Payment transactions',
      'inventory': 'Inventory levels',
      'categories': 'Category hierarchy',
      'addresses': 'Address records',
      'transactions': 'Financial transactions',
      'shipments': 'Shipping records',
      'employees': 'Employee records',
      'departments': 'Department structure',
    };

    const lower = tableName.toLowerCase();
    for (const [pattern, desc] of Object.entries(patterns)) {
      if (lower === pattern || lower === pattern.slice(0, -1)) {
        return desc;
      }
    }

    // Junction table pattern
    if (tableName.includes('_') && tableName.split('_').length === 2) {
      const parts = tableName.split('_');
      return `Links ${parts[0]} and ${parts[1]}`;
    }

    return `${tableName.replace(/_/g, ' ')} records`;
  }

  /**
   * Generate column description based on name and type
   */
  private generateColumnDescription(
    tableName: string,
    columnName: string,
    _dataType: string,
    isPrimaryKey: boolean,
    isForeignKey: boolean
  ): string {
    if (isPrimaryKey) {
      return `Primary key for ${tableName.replace(/_/g, ' ')}`;
    }

    if (isForeignKey || columnName.endsWith('_id')) {
      const refEntity = columnName.replace(/_id$/, '').replace(/_/g, ' ');
      return `Reference to ${refEntity}`;
    }

    const patterns: Record<string, string> = {
      'created_at': 'Record creation timestamp',
      'updated_at': 'Last update timestamp',
      'deleted_at': 'Soft delete timestamp',
      'name': 'Name or title',
      'email': 'Email address',
      'phone': 'Phone number',
      'status': 'Current status',
      'type': 'Type or category',
      'price': 'Price amount',
      'amount': 'Amount',
      'total': 'Total amount',
      'quantity': 'Quantity',
      'description': 'Description text',
      'address': 'Address',
      'city': 'City name',
      'country': 'Country',
      'is_active': 'Whether active',
      'is_deleted': 'Whether deleted',
    };

    const lower = columnName.toLowerCase();
    if (patterns[lower]) {
      return patterns[lower];
    }

    // Pattern-based
    if (lower.startsWith('is_')) return `Whether ${lower.slice(3).replace(/_/g, ' ')}`;
    if (lower.startsWith('has_')) return `Whether has ${lower.slice(4).replace(/_/g, ' ')}`;
    if (lower.endsWith('_at')) return `${lower.slice(0, -3).replace(/_/g, ' ')} timestamp`;
    if (lower.endsWith('_date')) return `${lower.slice(0, -5).replace(/_/g, ' ')} date`;
    if (lower.endsWith('_count')) return `Count of ${lower.slice(0, -6).replace(/_/g, ' ')}`;
    if (lower.endsWith('_amount')) return `${lower.slice(0, -7).replace(/_/g, ' ')} amount`;

    return columnName.replace(/_/g, ' ');
  }

  /**
   * Execute query
   */
  async execute(params: { sql: string; params?: Record<string, any> }): Promise<QueryResult> {
    let { sql } = params;
    const { params: queryParams } = params;
    const startTime = Date.now();

    // Authorization seam — write policy + AST rewrite. See BaseSource.prepareSql.
    sql = await this.prepareSql(sql);

    console.log(`[PostgresInstance:${this.getName()}] Executing query:`, sql.substring(0, 100) + (sql.length > 100 ? '...' : ''));

    // Translate named placeholders to positional values once, then hand the
    // pre-bound form to the transport. Direct + bridge transports both expect
    // positional bindings for the postgres dialect.
    let preparedSql = sql;
    let values: any[] | undefined;
    if (queryParams && Object.keys(queryParams).length > 0) {
      const { text, values: v } = this.convertNamedParams(sql, queryParams);
      preparedSql = text;
      values = v;
    }

    try {
      const result = await this.transport.query(preparedSql, values);
      console.log(`[PostgresInstance:${this.getName()}] Query executed successfully, rows: ${result.rowCount}`);
      return {
        data: result.rows,
        count: result.rows.length,
        metadata: {
          executionTime: Date.now() - startTime,
          totalCount: result.totalCount ?? result.rowCount,
        },
      };
    } catch (error: any) {
      console.error(`[PostgresInstance:${this.getName()}] Query error:`, error.message || error);
      throw error;
    }
  }

  /**
   * Convert @param to $1
   */
  private convertNamedParams(sql: string, params: Record<string, any>): { text: string; values: any[] } {
    const values: any[] = [];
    let paramIndex = 1;
    const paramMap = new Map<string, number>();

    const text = sql.replace(/[@$](\w+)/g, (match, paramName) => {
      // Skip PostgreSQL positional params like $1, $2 (digits only)
      if (match.startsWith('$') && /^\d+$/.test(paramName)) return match;
      if (!paramMap.has(paramName)) {
        paramMap.set(paramName, paramIndex++);
        values.push(params[paramName]);
      }
      return `$${paramMap.get(paramName)}`;
    });

    return { text, values };
  }

  // ============================================
  // Tool Generation
  // ============================================

  protected buildToolDescription(): string {
    const cfg = this.getConnectionConfig();
    const schemaInfo = this.formatSchemaForMainAgent();
    const sourceContext = this.getSourceContext();
    const domainHints = this.getDataDomainHints();
    const relationships = this.formatRelationshipsForLLM();

    return `Query ${this.config.name} (PostgreSQL database: ${cfg.database}).${sourceContext}${domainHints}

Available tables:
${schemaInfo}${relationships}`;
  }

  protected getToolParams(): Record<string, string> {
    return {
      sql: 'string - PostgreSQL query to execute',
      params: 'object (optional) - Named parameters { "name": "value" }',
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
