/**
 * MSSQL Source Instance
 *
 * Delegates DB I/O to a SourceTransport (DirectMssqlTransport or
 * BridgeTransport). Owns dialect concerns: SQL validation/repair, error
 * hints, dialect-specific extractSchema queries, tool description generation.
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
import { DirectMssqlTransport } from '../core/transports/direct-mssql';
import { BridgeTransport } from '../core/transports/bridge-transport';
import { detectUnboundParam } from '../core/unbound-param';

interface MSSQLConfig {
  server: string;
  port: number;
  database?: string;
  user: string;
  password: string;
  schema?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  /** When true, route queries through the db-bridge over WebSocket. */
  bridge?: boolean;
}

export class MSSQLInstance extends BaseSource {
  private _transport: SourceTransport | null = null;

  private getConnectionConfig(): MSSQLConfig {
    return this.config.config as MSSQLConfig;
  }

  private get transport(): SourceTransport {
    if (this._transport) return this._transport;
    const cfg = this.getConnectionConfig();
    if (cfg.bridge) {
      this._transport = new BridgeTransport({
        wsUrl: process.env.SA_WEBSOCKET_URL || 'wss://ws.superatom.ai/websocket',
        projectId: this.config.projectId,
        apiKey: process.env.SUPERATOM_API_KEY,
        dialect: 'mssql',
      });
      console.log(`[MSSQLInstance:${this.getName()}] Using BridgeTransport (projectId=${this.config.projectId})`);
    } else {
      this._transport = new DirectMssqlTransport({
        server: cfg.server,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        encrypt: cfg.encrypt,
        trustServerCertificate: cfg.trustServerCertificate,
        schema: cfg.schema,
        logTag: this.getName(),
      });
    }
    return this._transport;
  }

  /**
   * Validate and fix common SQL syntax errors (like unbalanced parentheses, aggregates in WHERE)
   */
  private validateAndFixSql(sqlQuery: string): { query: string; fixed: boolean; fixMessage?: string } {
    let query = sqlQuery;
    let fixed = false;
    const fixes: string[] = [];

    // FIX 1: Move aggregate functions from WHERE to HAVING
    const aggregateFunctions = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'];
    const aggregatePattern = new RegExp(
      `(WHERE\\s+.*)\\s+AND\\s+((?:COALESCE\\s*\\(\\s*)?(?:${aggregateFunctions.join('|')})\\s*\\([^)]+\\)[^)]*(?:\\))?\\s*(?:=|>|<|>=|<=|<>|!=)\\s*[^\\s]+)(.*)`,
      'i'
    );

    const aggregateMatch = query.match(aggregatePattern);
    if (aggregateMatch) {
      const beforeAggregate = aggregateMatch[1];
      const aggregateCondition = aggregateMatch[2].trim();
      let afterAggregate = aggregateMatch[3];

      const hasHaving = /\bHAVING\b/i.test(afterAggregate);
      const hasGroupBy = /\bGROUP\s+BY\b/i.test(query);

      if (hasGroupBy) {
        if (hasHaving) {
          afterAggregate = afterAggregate.replace(
            /(\bHAVING\b)/i,
            `HAVING ${aggregateCondition} AND `
          );
        } else {
          const orderByMatch = afterAggregate.match(/(\s+ORDER\s+BY\s+.*)/i);
          if (orderByMatch) {
            afterAggregate = afterAggregate.replace(
              orderByMatch[1],
              ` HAVING ${aggregateCondition}${orderByMatch[1]}`
            );
          } else {
            afterAggregate = afterAggregate + ` HAVING ${aggregateCondition}`;
          }
        }

        query = beforeAggregate + afterAggregate;
        fixed = true;
        fixes.push('Moved aggregate function from WHERE to HAVING');
        console.warn(`[MSSQLInstance:${this.getName()}] SQL Fix Applied: Moved aggregate function from WHERE to HAVING`);
      }
    }

    // FIX 2: Reorder SELECT TOP N DISTINCT → SELECT DISTINCT TOP N
    const topDistinctFixed = query.replace(
      /\bSELECT\s+(TOP\s+\d+)\s+DISTINCT\b/gi,
      'SELECT DISTINCT $1'
    );
    if (topDistinctFixed !== query) {
      query = topDistinctFixed;
      fixed = true;
      fixes.push('Reordered SELECT TOP N DISTINCT → SELECT DISTINCT TOP N');
      console.warn(`[MSSQLInstance:${this.getName()}] SQL Fix Applied: Reordered SELECT TOP N DISTINCT → SELECT DISTINCT TOP N`);
    }

    // FIX 3: Correct rolling-month date ranges → complete calendar months
    // Haiku often generates DATEADD(MONTH, -N, CAST(GETDATE() AS DATE)) which is a
    // rolling window including the current partial month. Convert to the first-of-month
    // anchor so "last N months" means N complete calendar months.
    const rollingMonthFixed = query.replace(
      /DATEADD\s*\(\s*MONTH\s*,\s*(-\d+)\s*,\s*CAST\s*\(\s*GETDATE\s*\(\s*\)\s*AS\s*DATE\s*\)\s*\)/gi,
      (_, n) => `DATEADD(MONTH, ${n}, DATEADD(MONTH, DATEDIFF(MONTH, 0, GETDATE()), 0))`
    );
    if (rollingMonthFixed !== query) {
      query = rollingMonthFixed;
      fixed = true;
      fixes.push('Converted rolling DATEADD(MONTH,-N,CAST(GETDATE() AS DATE)) → complete-calendar-month anchor');
      console.warn(`[MSSQLInstance:${this.getName()}] SQL Fix Applied: Converted rolling month range to complete calendar months`);
    }
    // Also fix the upper bound: <= CAST(GETDATE() AS DATE) used alongside a month-start lower bound
    // should become < first-of-current-month (exclusive) to exclude the current partial month.
    // Only fire when a DATEDIFF(MONTH,0,GETDATE()) start anchor already appears in the query,
    // meaning we've either written or already fixed the lower bound to be month-aligned.
    if (query.includes('DATEDIFF(MONTH, 0, GETDATE())')) {
      const upperBoundFixed = query.replace(
        /<=\s*CAST\s*\(\s*GETDATE\s*\(\s*\)\s*AS\s*DATE\s*\)/gi,
        '< DATEADD(MONTH, DATEDIFF(MONTH, 0, GETDATE()), 0)'
      );
      if (upperBoundFixed !== query) {
        query = upperBoundFixed;
        fixed = true;
        fixes.push('Converted <= CAST(GETDATE() AS DATE) upper bound → < first-of-current-month');
        console.warn(`[MSSQLInstance:${this.getName()}] SQL Fix Applied: Converted upper date bound to exclude current partial month`);
      }
    }

    // FIX 4: Balance parentheses
    let openCount = 0;
    let closeCount = 0;
    let inString = false;
    let stringChar = '';

    for (let i = 0; i < query.length; i++) {
      const char = query[i];
      const prevChar = i > 0 ? query[i - 1] : '';

      if ((char === "'" || char === '"') && prevChar !== '\\') {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          if (i + 1 < query.length && query[i + 1] === char) {
            i++;
          } else {
            inString = false;
          }
        }
        continue;
      }

      if (!inString) {
        if (char === '(') openCount++;
        else if (char === ')') closeCount++;
      }
    }

    if (openCount > closeCount) {
      const missingClose = openCount - closeCount;
      query = query.trimEnd();
      const hasSemicolon = query.endsWith(';');
      if (hasSemicolon) {
        query = query.slice(0, -1);
      }
      query = query + ')'.repeat(missingClose);
      if (hasSemicolon) {
        query = query + ';';
      }
      fixed = true;
      fixes.push(`Added ${missingClose} missing closing parenthesis(es)`);
      console.warn(`[MSSQLInstance:${this.getName()}] SQL Fix Applied: Added ${missingClose} missing closing parenthesis(es)`);
    } else if (closeCount > openCount) {
      console.warn(`[MSSQLInstance:${this.getName()}] SQL Warning: Query has ${closeCount - openCount} extra closing parenthesis(es)`);
    }

    // FIX 5: Convert malformed JS Date.toString() literals to ISO date format
    // The LLM sometimes interpolates a raw JS Date object into a SQL string instead of
    // converting it first (e.g. via .toISOString().split('T')[0]) — this happens when a
    // persisted script's date parameter reaches the SQL template unconverted. The result
    // looks like 'Mon Apr 01 2024 05:30:00 GMT+0530 (India Standard Time)', which SQL
    // Server cannot parse ("Conversion failed when converting date and/or time from
    // character string"). Prompt-level warnings alone don't fully prevent this, so catch
    // and rewrite it here regardless of which step authored the SQL.
    const jsDateToStringPattern = /'((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}(?: \([^)]*\))?)'/g;
    const jsDateFixed = query.replace(jsDateToStringPattern, (fullMatch, dateStr) => {
      const parsed = new Date(dateStr);
      if (isNaN(parsed.getTime())) return fullMatch;
      const iso = parsed.toISOString().replace('T', ' ').replace('Z', '');
      return `'${iso}'`;
    });
    if (jsDateFixed !== query) {
      query = jsDateFixed;
      fixed = true;
      fixes.push('Converted malformed JS Date.toString() literal(s) to ISO date format');
      console.warn(`[MSSQLInstance:${this.getName()}] SQL Fix Applied: Converted malformed JS Date.toString() literal(s) to ISO date format`);
    }

    return { query, fixed, fixMessage: fixes.length > 0 ? fixes.join('; ') : undefined };
  }

  /**
   * Enrich cryptic MSSQL error messages with clear fix instructions.
   * These hints are appended to the error message so the LLM can self-correct on retry.
   */
  private getErrorHint(errorMsg: string, sql?: string): string {
    // UNBOUND SCRIPT PARAMETER — check BEFORE the column/date branches, which
    // both misread it: MSSQL parses a bare `undefined` as a column name, and a
    // JS-stringified Date as a bad literal. Two confirmed runs burned every
    // retry regenerating identical SQL because the hint sent the model to
    // search_schema instead of to its own params.
    const unbound = sql ? detectUnboundParam(sql) : null;
    if (unbound) return unbound;

    const lower = errorMsg.toLowerCase();

    // "Operand type clash: date is incompatible with int"
    if (lower.includes('operand type clash') && lower.includes('date') && lower.includes('int')) {
      return '\n\nFIX: You are comparing a date/datetime column with an integer. Use string date literals instead: WHERE col >= \'2024-01-01\' AND col < \'2025-01-01\'. Or extract the integer part: WHERE YEAR(col) = 2024. Never write WHERE date_col = 2024 or BETWEEN 2024 AND 2025.';
    }

    // "invalid in the ORDER BY clause because it is not contained in ... GROUP BY"
    if (lower.includes('invalid in the order by clause') && lower.includes('group by')) {
      return '\n\nFIX: When using GROUP BY, the ORDER BY expression must exactly match a GROUP BY expression or use a column alias from SELECT. Use ORDER BY <column_alias> instead of writing a new CASE/expression in ORDER BY.';
    }

    // "Incorrect syntax near the keyword '<word>'" — reserved keyword or structural syntax error
    const reservedMatch = errorMsg.match(/Incorrect syntax near the keyword '(\w+)'/i);
    if (reservedMatch) {
      const keyword = reservedMatch[1];
      // Common structural keywords indicate query structure issues, not alias problems
      if (['AS', 'FROM', 'WHERE', 'SELECT', 'UNION', 'ORDER', 'GROUP', 'BY', 'ON', 'JOIN', 'AND', 'OR', 'SET'].includes(keyword.toUpperCase())) {
        return `\n\nFIX: Syntax error near "${keyword}". Common causes:\n- UNION/UNION ALL: TOP and ORDER BY must be on the outermost query only, not on individual branches. Wrap UNION in a subquery: SELECT TOP 10 * FROM (SELECT ... UNION ALL SELECT ...) AS combined ORDER BY col\n- Missing commas between columns or extra commas before FROM\n- Unbalanced parentheses in subqueries or CASE expressions\n- Semicolon (;) in the middle of a query`;
      }
      if (keyword.toUpperCase() === 'DISTINCT') {
        return `\n\nFIX: In MSSQL, DISTINCT must come BEFORE TOP N, not after. Write "SELECT DISTINCT TOP 10 col FROM ..." not "SELECT TOP 10 DISTINCT col FROM ...". Fix the query order: SELECT DISTINCT TOP N [columns] FROM table WHERE ...`;
      }
      return `\n\nFIX: "${keyword}" is a reserved keyword in MSSQL and cannot be used as a column alias. Rename the alias to something else, e.g., Total${keyword}s, ${keyword}Value, or ${keyword}Result.`;
    }

    // "text, ntext, and image data types cannot be compared or sorted"
    if (lower.includes('text') && lower.includes('ntext') && lower.includes('cannot be compared')) {
      return '\n\nFIX: text/ntext columns cannot be used in WHERE =, ORDER BY, GROUP BY, or DISTINCT. Wrap with CAST(column AS NVARCHAR(MAX)) before any comparison or sorting.';
    }

    // "Error converting data type varchar/nvarchar to numeric/int/decimal"
    if (lower.includes('converting') && (lower.includes('varchar') || lower.includes('nvarchar')) && (lower.includes('numeric') || lower.includes('int') || lower.includes('decimal') || lower.includes('float'))) {
      return '\n\nFIX: A string (varchar/nvarchar) column is being used in SUM, AVG, or numeric arithmetic. Wrap it with TRY_CAST(column AS DECIMAL(18,2)) before any numeric operation — e.g., SUM(TRY_CAST(column AS DECIMAL(18,2))). TRY_CAST returns NULL for non-numeric values instead of erroring.';
    }

    // "Cannot use an aggregate ... in the WHERE clause"
    if (lower.includes('aggregate') && lower.includes('where')) {
      return '\n\nFIX: Aggregate functions (SUM, COUNT, AVG, etc.) cannot appear in WHERE. Move the condition to HAVING (after GROUP BY), or use a subquery.';
    }

    // "Subquery returned more than 1 value"
    if (lower.includes('subquery returned more than 1 value')) {
      return '\n\nFIX: A subquery used with = or comparison returned multiple rows. Use TOP 1 in the subquery, or change = to IN if multiple matches are acceptable.';
    }

    // "Divide by zero"
    if (lower.includes('divide by zero')) {
      return '\n\nFIX: Division by zero. Wrap the denominator with NULLIF(denominator, 0) to return NULL instead of error.';
    }

    // "Conversion failed when converting date and/or time from character string"
    if (lower.includes('conversion failed') && lower.includes('date') && lower.includes('character string')) {
      return '\n\nFIX: A date string literal in the query is invalid (e.g., \'2025-02-29\' when Feb has 28 days, or a malformed date). Verify all date literals are valid calendar dates. Use EOMONTH(\'2025-02-01\') to get the correct last day of a month instead of hardcoding it. Also check that the column\'s actual type matches — if the column is a string (varchar/nvarchar), do not CAST it to DATE; compare it as a string or use TRY_CAST.';
    }

    // "Invalid column name 'XYZ'"
    const colMatch = errorMsg.match(/Invalid column name '(\w+)'/i);
    if (colMatch) {
      const colName = colMatch[1];
      return `\n\nFIX: Column "${colName}" does not exist in this table. Do NOT guess column names — use search_schema to look up the exact column names, then use ONLY the names returned by the search. The column may have a different prefix, suffix, or naming convention than you expect.`;
    }

    // "Invalid object name 'XYZ'" (table doesn't exist)
    const objMatch = errorMsg.match(/Invalid object name '([^']+)'/i);
    if (objMatch) {
      const objName = objMatch[1];
      return `\n\nFIX: Table "${objName}" does not exist. Use search_schema to find the correct table name. Check for different schemas (dbo vs other), prefixes, or spelling.`;
    }

    // Timeout errors
    if (lower.includes('timeout') || lower.includes('etimeout') || lower.includes('failed to complete')) {
      return '\n\nFIX: Query timed out — it is too slow for this database. Simplify the query:\n- Replace FULL OUTER JOIN with LEFT JOIN or INNER JOIN\n- Avoid wrapping date columns in functions (YEAR(), MONTH()) — use range comparisons instead: WHERE col >= \'2025-04-01\' AND col < \'2026-04-01\'\n- Remove OR conditions across multiple date columns — split into separate queries if needed\n- Reduce the number of JOINed tables\n- Add more selective WHERE filters to reduce rows scanned';
    }

    return '';
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
      await this.transport.query('SELECT 1 AS health');
      return true;
    } catch {
      return false;
    }
  }

  /** Fast (single COUNT query) candidate-table count from INFORMATION_SCHEMA — see SourceInstance.estimateExtractionTime. */
  async estimateExtractionTime(): Promise<{ candidateCount: number; message: string }> {
    const result = await this.transport.query(`
      SELECT COUNT(*) AS count
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
    `);
    const candidateCount = Number(result.rows[0]?.count) || 0;
    return { candidateCount, message: `Found ${candidateCount} table(s) from INFORMATION_SCHEMA, extracting schema...` };
  }

  /**
   * Extract rich schema with statistics, sample values, and descriptions
   */
  async extractSchema(): Promise<SourceSchema> {
    try {
      const extractStart = Date.now();
      console.log(`[MSSQLInstance:${this.getName()}] Extracting rich schema...`);

      // Get tables with row counts
      console.log(`[MSSQLInstance:${this.getName()}] [Schema] Fetching tables...`);
      const tablesResult = await this.transport.query(`
        SELECT
          t.TABLE_SCHEMA,
          t.TABLE_NAME,
          ISNULL(p.rows, 0) AS row_count
        FROM INFORMATION_SCHEMA.TABLES t
        LEFT JOIN sys.partitions p ON p.object_id = OBJECT_ID(t.TABLE_SCHEMA + '.' + t.TABLE_NAME)
          AND p.index_id IN (0, 1)
        WHERE t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME
      `);

      console.log(`[MSSQLInstance:${this.getName()}] [Schema] Found ${tablesResult.rows.length} tables in ${Date.now() - extractStart}ms`);

      // Get columns with constraints
      console.log(`[MSSQLInstance:${this.getName()}] [Schema] Fetching columns & constraints...`);
      const columnsResult = await this.transport.query(`
        SELECT
          c.TABLE_SCHEMA,
          c.TABLE_NAME,
          c.COLUMN_NAME,
          c.DATA_TYPE,
          c.IS_NULLABLE,
          CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY,
          fk.REFERENCED_TABLE_NAME,
          fk.REFERENCED_COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
          SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
            ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        ) pk ON c.TABLE_SCHEMA = pk.TABLE_SCHEMA
          AND c.TABLE_NAME = pk.TABLE_NAME
          AND c.COLUMN_NAME = pk.COLUMN_NAME
        LEFT JOIN (
          SELECT
            cu.TABLE_SCHEMA,
            cu.TABLE_NAME,
            cu.COLUMN_NAME,
            cu2.TABLE_NAME AS REFERENCED_TABLE_NAME,
            cu2.COLUMN_NAME AS REFERENCED_COLUMN_NAME
          FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE cu
            ON rc.CONSTRAINT_NAME = cu.CONSTRAINT_NAME
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE cu2
            ON rc.UNIQUE_CONSTRAINT_NAME = cu2.CONSTRAINT_NAME
        ) fk ON c.TABLE_SCHEMA = fk.TABLE_SCHEMA
          AND c.TABLE_NAME = fk.TABLE_NAME
          AND c.COLUMN_NAME = fk.COLUMN_NAME
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
      `);

      console.log(`[MSSQLInstance:${this.getName()}] [Schema] Found ${columnsResult.rows.length} columns in ${Date.now() - extractStart}ms`);

      // Build entities
      const entityMap = new Map<string, SchemaEntity>();
      const relationships: Array<{ from: string; to: string; type: 'one-to-one' | 'one-to-many' | 'many-to-many'; fromField: string; toField: string }> = [];

      let skippedEmpty = 0;
      for (const row of tablesResult.rows) {
        const rowCount = row.row_count || 0;

        // sys.partitions.rows is an estimate and can be stale — it may report 0 for non-empty tables
        // or non-zero for empty tables. Always do a quick existence check to be sure.
        try {
          const existsResult = await this.transport.query(
            `SELECT TOP 1 1 FROM [${row.TABLE_SCHEMA}].[${row.TABLE_NAME}]`
          );
          if (existsResult.rows.length === 0) {
            skippedEmpty++;
            continue;
          }
        } catch {
          skippedEmpty++;
          continue;
        }

        const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
        entityMap.set(key, {
          name: row.TABLE_NAME,
          fullName: key,
          description: this.generateTableDescription(row.TABLE_NAME),
          fields: [],
          rowCount: rowCount || 1,
          primaryKey: [],
        });
      }
      if (skippedEmpty > 0) {
        console.log(`[MSSQLInstance:${this.getName()}] Skipped ${skippedEmpty} empty tables`);
      }

      // Group columns by table for processing
      const tableColumns = new Map<string, Array<{ row: any; entity: SchemaEntity }>>();

      for (const row of columnsResult.rows) {
        const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
        const entity = entityMap.get(key);
        if (entity) {
          if (!tableColumns.has(key)) {
            tableColumns.set(key, []);
          }
          tableColumns.get(key)!.push({ row, entity });
        }
      }

      // Extraction strategy: always collect full stats + sample values.
      // ≤50 tables: sequential (simple, low overhead)
      // 51+:        parallel batches of 10 (faster for large schemas)
      const totalTables = tableColumns.size;
      const PARALLEL_BATCH_SIZE = 10;
      const useParallel = totalTables > 50;

      if (useParallel) {
        console.log(`[MSSQLInstance:${this.getName()}] [Schema] ${totalTables} tables — parallel mode (batches of ${PARALLEL_BATCH_SIZE})`);
      } else {
        console.log(`[MSSQLInstance:${this.getName()}] [Schema] ${totalTables} tables — full extraction mode`);
      }

      // Helper: process a single table's columns (build fields + optionally fetch stats)
      const processTable = async (tableKey: string, columns: Array<{ row: any; entity: SchemaEntity }>) => {
        const [tableSchema, tableName] = tableKey.split('.');
        const entity = entityMap.get(tableKey)!;
        const rowCount = entity.rowCount || 0;

        // Build all fields (no queries needed)
        const fields: Array<{ field: SchemaField; row: any }> = [];
        for (const { row } of columns) {
          const field: SchemaField = {
            name: row.COLUMN_NAME,
            type: this.normalizeType(row.DATA_TYPE),
            nativeType: row.DATA_TYPE,
            nullable: row.IS_NULLABLE === 'YES',
            isPrimaryKey: row.IS_PRIMARY_KEY === 1,
            description: this.generateColumnDescription(tableName, row.COLUMN_NAME, row.DATA_TYPE, row.IS_PRIMARY_KEY === 1, !!row.REFERENCED_TABLE_NAME),
          };

          if (row.IS_PRIMARY_KEY === 1) {
            entity.primaryKey!.push(row.COLUMN_NAME);
          }

          if (row.REFERENCED_TABLE_NAME) {
            field.isForeignKey = true;
            field.references = {
              entity: row.REFERENCED_TABLE_NAME,
              field: row.REFERENCED_COLUMN_NAME,
            };
            relationships.push({
              from: tableName,
              to: row.REFERENCED_TABLE_NAME,
              type: 'one-to-many',
              fromField: row.COLUMN_NAME,
              toField: row.REFERENCED_COLUMN_NAME,
            });
          }

          fields.push({ field, row });
          entity.fields.push(field);
        }

        if (rowCount === 0) return;

        // Batch statistics: single query for all columns in this table
        try {
          const statsMap = await this.getBatchedColumnStatistics(tableSchema, tableName, fields.map(f => ({ column: f.row.COLUMN_NAME, dataType: f.row.DATA_TYPE })), rowCount);
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
          console.warn(`[MSSQLInstance:${this.getName()}] Could not get batched stats for ${tableKey}: ${statsError instanceof Error ? statsError.message : String(statsError)}`);
        }

        // Get sample values for low-cardinality columns (≤100 distinct values)
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

      // Execute: parallel batches or sequential
      const tableEntries = Array.from(tableColumns.entries());

      if (useParallel) {
        for (let i = 0; i < tableEntries.length; i += PARALLEL_BATCH_SIZE) {
          const batch = tableEntries.slice(i, i + PARALLEL_BATCH_SIZE);
          const batchNum = Math.floor(i / PARALLEL_BATCH_SIZE) + 1;
          const totalBatches = Math.ceil(tableEntries.length / PARALLEL_BATCH_SIZE);
          console.log(`[MSSQLInstance:${this.getName()}] [Schema] Batch ${batchNum}/${totalBatches} (tables ${i + 1}-${Math.min(i + PARALLEL_BATCH_SIZE, tableEntries.length)}/${totalTables})`);

          await Promise.all(batch.map(([key, cols]) => processTable(key, cols)));
        }
      } else {
        let tableIndex = 0;
        for (const [tableKey, columns] of tableEntries) {
          tableIndex++;
          console.log(`[MSSQLInstance:${this.getName()}] [Schema] [${tableIndex}/${totalTables}] Processing ${tableKey}...`);
          await processTable(tableKey, columns);
        }
      }

      const totalDuration = ((Date.now() - extractStart) / 1000).toFixed(1);
      console.log(`[MSSQLInstance:${this.getName()}] [Schema] All ${totalTables} tables processed in ${totalDuration}s`);

      const schema: SourceSchema = {
        entities: Array.from(entityMap.values()),
        relationships,
        extractedAt: new Date().toISOString(),
      };

      this.setSchema(schema);
      console.log(`[MSSQLInstance:${this.getName()}] Extracted rich schema: ${schema.entities.length} tables${skippedEmpty > 0 ? ` (skipped ${skippedEmpty} empty)` : ''}, ${relationships.length} relationships`);
      return schema;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to extract schema: ${errorMsg}`);
    }
  }

  /**
   * Fast sample value pass for large schemas (metadata-only mode).
   * Runs on top 50 scored tables only. For each table:
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
    const numericTypes = ['int', 'bigint', 'smallint', 'tinyint', 'numeric', 'decimal', 'float', 'real', 'money', 'smallmoney'];
    const textTypes = ['varchar', 'nvarchar', 'char', 'nchar', 'uniqueidentifier'];
    const lobTypes = ['text', 'ntext', 'image']; // LOB types cannot use DISTINCT, comparisons, or sorting
    const dateTypes = ['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'];
    const boolTypes = ['bit'];

    const statsMap = new Map<string, any>();

    // Build a single SELECT with all column stats
    const selectParts: string[] = [];
    const columnMeta: Array<{ column: string; category: 'numeric' | 'text' | 'date' | 'bool' | 'other' }> = [];

    for (const { column, dataType } of columns) {
      const lowerType = dataType.toLowerCase();
      const col = `[${column}]`;

      if (boolTypes.includes(lowerType)) {
        selectParts.push(
          `SUM(CASE WHEN ${col} = 1 THEN 1 ELSE 0 END) as [${column}__true_count]`,
          `SUM(CASE WHEN ${col} = 0 THEN 1 ELSE 0 END) as [${column}__false_count]`,
          `COUNT(${col}) as [${column}__non_null_count]`
        );
        columnMeta.push({ column, category: 'bool' });
      } else if (numericTypes.includes(lowerType)) {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as [${column}__distinct_count]`,
          `COUNT(${col}) as [${column}__non_null_count]`,
          `MIN(${col}) as [${column}__min_value]`,
          `MAX(${col}) as [${column}__max_value]`,
          `ROUND(AVG(CAST(${col} AS FLOAT)), 2) as [${column}__avg_value]`
        );
        columnMeta.push({ column, category: 'numeric' });
      } else if (dateTypes.includes(lowerType)) {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as [${column}__distinct_count]`,
          `COUNT(${col}) as [${column}__non_null_count]`,
          `MIN(${col}) as [${column}__min_value]`,
          `MAX(${col}) as [${column}__max_value]`
        );
        columnMeta.push({ column, category: 'date' });
      } else if (lobTypes.includes(lowerType)) {
        // text/ntext/image cannot use DISTINCT or comparisons — only COUNT non-null
        selectParts.push(
          `COUNT(${col}) as [${column}__non_null_count]`
        );
        columnMeta.push({ column, category: 'other' });
      } else if (textTypes.includes(lowerType)) {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as [${column}__distinct_count]`,
          `COUNT(${col}) as [${column}__non_null_count]`
        );
        columnMeta.push({ column, category: 'text' });
      } else {
        selectParts.push(
          `COUNT(DISTINCT ${col}) as [${column}__distinct_count]`,
          `COUNT(${col}) as [${column}__non_null_count]`
        );
        columnMeta.push({ column, category: 'other' });
      }
    }

    if (selectParts.length === 0) return statsMap;

    try {
      const result = await this.transport.query(
        `SELECT ${selectParts.join(', ')} FROM [${schema}].[${table}]`
      );

      const row = result.rows[0];
      if (!row) return statsMap;

      // Parse the batched result row into per-column stats
      for (const { column, category } of columnMeta) {
        let stats: any = {};

        if (category === 'bool') {
          stats = {
            distinct: 2,
            nonNullCount: row[`${column}__non_null_count`] || 0,
            trueCount: row[`${column}__true_count`] || 0,
            falseCount: row[`${column}__false_count`] || 0,
          };
        } else if (category === 'numeric') {
          stats = {
            distinct: row[`${column}__distinct_count`] || 0,
            nonNullCount: row[`${column}__non_null_count`] || 0,
            min: row[`${column}__min_value`] != null ? Number(row[`${column}__min_value`]) : undefined,
            max: row[`${column}__max_value`] != null ? Number(row[`${column}__max_value`]) : undefined,
            avg: row[`${column}__avg_value`] != null ? Number(row[`${column}__avg_value`]) : undefined,
          };
        } else if (category === 'date') {
          stats = {
            distinct: row[`${column}__distinct_count`] || 0,
            nonNullCount: row[`${column}__non_null_count`] || 0,
            min: row[`${column}__min_value`] ? String(row[`${column}__min_value`]).split('T')[0] : undefined,
            max: row[`${column}__max_value`] ? String(row[`${column}__max_value`]).split('T')[0] : undefined,
          };
        } else {
          stats = {
            distinct: row[`${column}__distinct_count`] || 0,
            nonNullCount: row[`${column}__non_null_count`] || 0,
          };
        }

        // Calculate cardinality classification
        if (stats.distinct !== undefined && rowCount > 0) {
          stats.cardinality = this.determineCardinality(stats.distinct, rowCount);
        }

        statsMap.set(column, stats);
      }
    } catch {
      // If batched query fails, return empty map (fields will have no statistics)
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
        SELECT DISTINCT TOP 50 [${column}]
        FROM [${schema}].[${table}]
        WHERE [${column}] IS NOT NULL
        ORDER BY [${column}]
      `);
      return result.rows
        .map(r => {
          const val = r[column];
          // Date columns come back as native JS Date objects. String(date) invokes
          // Date.prototype.toString(), producing e.g.
          // "Mon Jun 22 2026 05:30:00 GMT+0530 (India Standard Time)" -- a format
          // SQL Server cannot parse if copied verbatim into a query literal.
          if (val instanceof Date) {
            return val.toISOString().replace('T', ' ').replace('Z', '');
          }
          return String(val).replace(/\u0000/g, '');
        })
        .filter(v => v !== 'null' && v !== '');
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

    if (isForeignKey || columnName.toLowerCase().endsWith('_id') || columnName.toLowerCase().endsWith('id')) {
      const refEntity = columnName.replace(/_id$/i, '').replace(/id$/i, '').replace(/_/g, ' ');
      if (refEntity) {
        return `Reference to ${refEntity}`;
      }
    }

    const patterns: Record<string, string> = {
      'created_at': 'Record creation timestamp',
      'createdat': 'Record creation timestamp',
      'createddate': 'Record creation timestamp',
      'updated_at': 'Last update timestamp',
      'updatedat': 'Last update timestamp',
      'modifieddate': 'Last update timestamp',
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
      'isactive': 'Whether active',
      'is_deleted': 'Whether deleted',
      'isdeleted': 'Whether deleted',
    };

    const lower = columnName.toLowerCase();
    if (patterns[lower]) {
      return patterns[lower];
    }

    // Pattern-based
    if (lower.startsWith('is_') || lower.startsWith('is')) {
      const suffix = lower.startsWith('is_') ? lower.slice(3) : lower.slice(2);
      return `Whether ${suffix.replace(/_/g, ' ')}`;
    }
    if (lower.startsWith('has_') || lower.startsWith('has')) {
      const suffix = lower.startsWith('has_') ? lower.slice(4) : lower.slice(3);
      return `Whether has ${suffix.replace(/_/g, ' ')}`;
    }
    if (lower.endsWith('_at') || lower.endsWith('at')) {
      return `${lower.replace(/_at$/, '').replace(/at$/, '').replace(/_/g, ' ')} timestamp`;
    }
    if (lower.endsWith('_date') || lower.endsWith('date')) {
      return `${lower.replace(/_date$/, '').replace(/date$/, '').replace(/_/g, ' ')} date`;
    }
    if (lower.endsWith('_count')) return `Count of ${lower.slice(0, -6).replace(/_/g, ' ')}`;
    if (lower.endsWith('_amount')) return `${lower.slice(0, -7).replace(/_/g, ' ')} amount`;

    return columnName.replace(/_/g, ' ');
  }

  /**
   * Execute query
   */
  async execute(params: { sql: string; params?: Record<string, any> }): Promise<QueryResult> {
    const { sql: sqlQuery, params: queryParams } = params;
    const startTime = Date.now();

    const validated = this.validateAndFixSql(sqlQuery);
    const { fixed, fixMessage } = validated;
    let validatedQuery = validated.query;
    if (fixed) {
      console.log(`[MSSQLInstance:${this.getName()}] Original query had syntax issues, applied fix:`, fixMessage);
    }

    // Authorization seam — write policy + AST rewrite. See BaseSource.prepareSql.
    validatedQuery = await this.prepareSql(validatedQuery);

    // Convert $paramName/@paramName placeholders (the convention every prompt
    // generates) into the literal @paramName syntax node-mssql's request.input()
    // binding requires. Without this, "$paramName" reaches SQL Server unconverted,
    // where "$identifier" is real T-SQL pseudocolumn syntax ($IDENTITY, $ROWGUID,
    // ...) — causing "Invalid pseudocolumn '$paramName'." on every parameterized
    // query. Mirrors PostgresInstance.convertNamedParams, minus positional
    // re-indexing since Tedious binds by name already.
    const preparedQuery = queryParams && Object.keys(queryParams).length > 0
      ? this.convertNamedParams(validatedQuery, queryParams)
      : validatedQuery;

    console.log(`[MSSQLInstance:${this.getName()}] Executing query:`, preparedQuery.substring(0, 100) + (preparedQuery.length > 100 ? '...' : ''));

    try {
      const result = await this.transport.query(preparedQuery, queryParams);
      console.log(`[MSSQLInstance:${this.getName()}] Query executed successfully, rows: ${result.rowCount}`);
      return {
        data: result.rows,
        count: result.rowCount,
        metadata: {
          executionTime: Date.now() - startTime,
          totalCount: result.totalCount,
        },
      };
    } catch (error: any) {
      console.error(`[MSSQLInstance:${this.getName()}] Query error:`, error.message || error);
      // Decorate transport errors with the dialect-specific hint when we can.
      const msg = error.message || 'Unknown database error';
      const hint = this.getErrorHint(msg, preparedQuery);
      if (hint && !msg.includes(hint)) {
        throw new Error(`${msg}${hint}`);
      }
      throw error;
    }
  }

  /**
   * Convert $paramName/@paramName placeholders to @paramName (node-mssql's
   * native named-parameter syntax). Only rewrites tokens that have a matching
   * key in `params`, so real T-SQL pseudocolumns (e.g. $IDENTITY) that aren't
   * bound parameters are left untouched.
   */
  private convertNamedParams(sql: string, params: Record<string, any>): string {
    return sql.replace(/[@$](\w+)/g, (match, paramName) => (
      paramName in params ? `@${paramName}` : match
    ));
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

    return `Query ${this.config.name} (Microsoft SQL Server: ${cfg.database || 'user default database'}).${sourceContext}${domainHints}

Available tables:
${schemaInfo}${relationships}`;
  }

  protected getToolParams(): Record<string, string> {
    return {
      sql: 'string - T-SQL query to execute',
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
