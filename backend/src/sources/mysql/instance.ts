/**
 * MySQL Source Instance
 *
 * Delegates DB I/O to a SourceTransport (DirectMysqlTransport or
 * BridgeTransport). Owns dialect concerns: extractSchema queries, batched
 * column statistics, named-to-positional parameter conversion (`@param` → `?`),
 * tool description generation.
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
import { DirectMysqlTransport } from '../core/transports/direct-mysql';
import { BridgeTransport } from '../core/transports/bridge-transport';

interface MySQLConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  timezone?: string;
  /** When true, route queries through the db-bridge over WebSocket. */
  bridge?: boolean;
}

export class MySQLInstance extends BaseSource {
  private _transport: SourceTransport | null = null;

  private getConnectionConfig(): MySQLConfig {
    return this.config.config as MySQLConfig;
  }

  private get transport(): SourceTransport {
    if (this._transport) return this._transport;
    const cfg = this.getConnectionConfig();
    if (cfg.bridge) {
      this._transport = new BridgeTransport({
        wsUrl: process.env.SA_WEBSOCKET_URL || 'wss://ws.superatom.ai/websocket',
        projectId: this.config.projectId,
        apiKey: process.env.SUPERATOM_API_KEY,
        dialect: 'mysql',
      });
      console.log(`[MySQLInstance:${this.getName()}] Using BridgeTransport (projectId=${this.config.projectId})`);
    } else {
      this._transport = new DirectMysqlTransport({
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        ssl: cfg.ssl,
        timezone: cfg.timezone,
        logTag: this.getName(),
      });
    }
    return this._transport;
  }

  /**
   * Connect (lazy — the underlying transport opens on first use).
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
    const databaseName = this.getConnectionConfig().database;
    const result = await this.transport.query(`
      SELECT COUNT(*) AS count
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
    `, [databaseName]);
    const candidateCount = Number(result.rows[0]?.count) || 0;
    return { candidateCount, message: `Found ${candidateCount} table(s) from information_schema, extracting schema...` };
  }

  /**
   * Extract rich schema with statistics, sample values, and descriptions
   */
  async extractSchema(): Promise<SourceSchema> {
    const cfg = this.getConnectionConfig();
    const databaseName = cfg.database;

    try {
      console.log(`[MySQLInstance:${this.getName()}] Extracting rich schema...`);

      // Get tables with row counts
      const tablesResult = await this.transport.query(`
        SELECT
          TABLE_SCHEMA as table_schema,
          TABLE_NAME as table_name,
          TABLE_ROWS as row_count
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
          AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME
      `, [databaseName]);

      // Get columns with constraints
      const columnsResult = await this.transport.query(`
        SELECT
          c.TABLE_SCHEMA as table_schema,
          c.TABLE_NAME as table_name,
          c.COLUMN_NAME as column_name,
          c.DATA_TYPE as data_type,
          c.COLUMN_TYPE as column_type,
          c.IS_NULLABLE as is_nullable,
          c.COLUMN_KEY as column_key,
          k.REFERENCED_TABLE_NAME as referenced_table,
          k.REFERENCED_COLUMN_NAME as referenced_column
        FROM information_schema.COLUMNS c
        LEFT JOIN information_schema.KEY_COLUMN_USAGE k
          ON c.TABLE_SCHEMA = k.TABLE_SCHEMA
          AND c.TABLE_NAME = k.TABLE_NAME
          AND c.COLUMN_NAME = k.COLUMN_NAME
          AND k.REFERENCED_TABLE_NAME IS NOT NULL
        WHERE c.TABLE_SCHEMA = ?
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
      `, [databaseName]);

      // Build entities
      const entityMap = new Map<string, SchemaEntity>();
      const relationships: Array<{ from: string; to: string; type: 'one-to-one' | 'one-to-many' | 'many-to-many'; fromField: string; toField: string }> = [];

      let skippedEmpty = 0;
      for (const row of tablesResult.rows as any[]) {
        const rowCount = parseInt(row.row_count) || 0;

        // TABLE_ROWS is an estimate and can be stale — it may report 0 for non-empty tables
        // or non-zero for empty tables. Always do a quick existence check to be sure.
        try {
          const existsResult = await this.transport.query(
            `SELECT 1 FROM \`${row.table_schema}\`.\`${row.table_name}\` LIMIT 1`
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
        console.log(`[MySQLInstance:${this.getName()}] Skipped ${skippedEmpty} empty tables`);
      }

      // Group columns by table
      const tableColumns = new Map<string, Array<{ row: any; entity: SchemaEntity }>>();

      for (const row of columnsResult.rows as any[]) {
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
        console.log(`[MySQLInstance:${this.getName()}] [Schema] ${totalTables} tables — parallel mode (batches of ${PARALLEL_BATCH_SIZE})`);
      }

      const processTable = async (tableKey: string, columns: Array<{ row: any; entity: SchemaEntity }>) => {
        const entity = entityMap.get(tableKey)!;
        const rowCount = entity.rowCount || 0;

        const fields: Array<{ field: SchemaField; row: any }> = [];
        for (const { row } of columns) {
          const isPrimaryKey = row.column_key === 'PRI';
          const isForeignKey = !!row.referenced_table;

          const field: SchemaField = {
            name: row.column_name,
            type: this.normalizeType(row.data_type),
            nativeType: row.column_type || row.data_type,
            nullable: row.is_nullable === 'YES',
            isPrimaryKey,
            description: this.generateColumnDescription(entity.name, row.column_name, row.data_type, isPrimaryKey, isForeignKey),
          };

          if (isPrimaryKey) {
            entity.primaryKey!.push(row.column_name);
          }

          if (isForeignKey) {
            field.isForeignKey = true;
            field.references = {
              entity: row.referenced_table,
              field: row.referenced_column,
            };
            relationships.push({
              from: entity.name,
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
          const statsMap = await this.getBatchedColumnStatistics(databaseName, entity.name, fields.map(f => ({ column: f.row.column_name, dataType: f.row.data_type, columnType: f.row.column_type })), rowCount);
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
          console.warn(`[MySQLInstance:${this.getName()}] Could not get batched stats for ${tableKey}: ${statsError instanceof Error ? statsError.message : String(statsError)}`);
        }

        for (const { field } of fields) {
          if (field.statistics?.distinct && field.statistics.distinct <= 100) {
            try {
              const sampleValues = await this.getSampleValues(databaseName, entity.name, field.name);
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
          console.log(`[MySQLInstance:${this.getName()}] [Schema] Processing tables ${i + 1}-${Math.min(i + PARALLEL_BATCH_SIZE, tableEntries.length)}/${totalTables}`);
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
      console.log(`[MySQLInstance:${this.getName()}] Extracted rich schema: ${schema.entities.length} tables${skippedEmpty > 0 ? ` (skipped ${skippedEmpty} empty)` : ''}, ${relationships.length} relationships`);
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
    database: string,
    table: string,
    columns: Array<{ column: string; dataType: string; columnType?: string }>,
    rowCount: number
  ): Promise<Map<string, { distinct?: number; min?: any; max?: any; avg?: number; nonNullCount?: number; cardinality?: 'unique' | 'low' | 'medium' | 'high'; trueCount?: number; falseCount?: number }>> {
    const numericTypes = ['int', 'bigint', 'smallint', 'tinyint', 'mediumint', 'decimal', 'numeric', 'float', 'double', 'real'];
    const textTypes = ['varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext', 'enum', 'set'];
    const dateTypes = ['date', 'datetime', 'timestamp', 'time', 'year'];
    const boolTypes = ['tinyint(1)', 'bit', 'bool', 'boolean'];

    const statsMap = new Map<string, any>();

    // Build a single SELECT with all column stats
    const selectParts: string[] = [];
    const columnMeta: Array<{ column: string; category: 'numeric' | 'text' | 'date' | 'bool' | 'other' }> = [];

    for (const { column, dataType, columnType } of columns) {
      const lowerType = dataType.toLowerCase();
      const fullType = (columnType || dataType).toLowerCase();
      const col = `\`${column}\``;

      if (boolTypes.some(t => fullType.includes(t))) {
        selectParts.push(
          `SUM(CASE WHEN ${col} = 1 THEN 1 ELSE 0 END) as \`${column}__true_count\``,
          `SUM(CASE WHEN ${col} = 0 THEN 1 ELSE 0 END) as \`${column}__false_count\``,
          `COUNT(${col}) as \`${column}__non_null_count\``
        );
        columnMeta.push({ column, category: 'bool' });
      } else if (numericTypes.some(t => lowerType.includes(t))) {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as \`${column}__distinct_count\``,
          `COUNT(${col}) as \`${column}__non_null_count\``,
          `MIN(${col}) as \`${column}__min_value\``,
          `MAX(${col}) as \`${column}__max_value\``,
          `ROUND(AVG(${col}), 2) as \`${column}__avg_value\``
        );
        columnMeta.push({ column, category: 'numeric' });
      } else if (dateTypes.some(t => lowerType.includes(t))) {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as \`${column}__distinct_count\``,
          `COUNT(${col}) as \`${column}__non_null_count\``,
          `MIN(${col}) as \`${column}__min_value\``,
          `MAX(${col}) as \`${column}__max_value\``
        );
        columnMeta.push({ column, category: 'date' });
      } else if (textTypes.some(t => lowerType.includes(t))) {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as \`${column}__distinct_count\``,
          `COUNT(${col}) as \`${column}__non_null_count\``
        );
        columnMeta.push({ column, category: 'text' });
      } else {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as \`${column}__distinct_count\``,
          `COUNT(${col}) as \`${column}__non_null_count\``
        );
        columnMeta.push({ column, category: 'other' });
      }
    }

    if (selectParts.length === 0) return statsMap;

    try {
      const result = await this.transport.query(
        `SELECT ${selectParts.join(', ')} FROM \`${database}\`.\`${table}\``
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
    database: string,
    table: string,
    column: string
  ): Promise<string[] | null> {
    try {
      const result = await this.transport.query(`
        SELECT DISTINCT \`${column}\`
        FROM \`${database}\`.\`${table}\`
        WHERE \`${column}\` IS NOT NULL
        ORDER BY \`${column}\`
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

    console.log(`[MySQLInstance:${this.getName()}] Executing query:`, sql.substring(0, 100) + (sql.length > 100 ? '...' : ''));

    // Translate named placeholders to positional `?` once, then hand the
    // pre-bound form to the transport.
    let preparedSql = sql;
    let values: any[] | undefined;
    if (queryParams && Object.keys(queryParams).length > 0) {
      const { text, values: v } = this.convertNamedParams(sql, queryParams);
      preparedSql = text;
      values = v;
    }

    try {
      const result = await this.transport.query(preparedSql, values);
      console.log(`[MySQLInstance:${this.getName()}] Query executed successfully, rows: ${result.rowCount}`);
      return {
        data: result.rows,
        count: result.rowCount,
        metadata: {
          executionTime: Date.now() - startTime,
          totalCount: result.totalCount ?? result.rowCount,
        },
      };
    } catch (error: any) {
      console.error(`[MySQLInstance:${this.getName()}] Query error:`, error.message || error);
      throw error;
    }
  }

  /**
   * Convert @param or $param to ? placeholders for MySQL
   */
  private convertNamedParams(sql: string, params: Record<string, any>): { text: string; values: any[] } {
    const values: any[] = [];
    const paramOrder: string[] = [];

    // Find all @paramName or $paramName occurrences and track their order
    const text = sql.replace(/[@$](\w+)/g, (match, paramName) => {
      // Skip pure numeric like $1 (shouldn't appear in MySQL but be safe)
      if (match.startsWith('$') && /^\d+$/.test(paramName)) return match;
      paramOrder.push(paramName);
      return '?';
    });

    // Build values array in the order params appear in SQL
    for (const paramName of paramOrder) {
      values.push(params[paramName]);
    }

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

    return `Query ${this.config.name} (MySQL database: ${cfg.database}).${sourceContext}${domainHints}

Available tables:
${schemaInfo}${relationships}`;
  }

  protected getToolParams(): Record<string, string> {
    return {
      sql: 'string - MySQL query to execute',
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
