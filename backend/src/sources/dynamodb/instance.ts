/**
 * DynamoDB Source Instance
 *
 * DynamoDB is schemaless and request/response (no persistent connection). This
 * instance:
 *  - "connects" by building an AWS SDK v3 DocumentClient and verifying creds
 *  - extracts a best-effort schema: DescribeTable gives the authoritative key
 *    schema + GSIs + approximate item count; a bounded Scan sample discovers the
 *    non-key attributes and sample values (different items may carry different
 *    attributes, so this is inference, not a guarantee)
 *  - executes PartiQL via ExecuteStatement. DynamoDB runs an efficient
 *    Query/GetItem when the WHERE pins the partition key, and only falls back to
 *    a bounded Scan otherwise. PartiQL has NO JOIN and NO aggregation — the
 *    scripts-flow JS layer folds the returned rows for analytics.
 */

import {
  BaseSource,
  SourceSchema,
  QueryResult,
  SourceTool,
  SchemaEntity,
  SchemaField,
} from '../core';
import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  ExecuteStatementCommand,
} from '@aws-sdk/lib-dynamodb';

interface DynamoDBConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint?: string;
  /** Comma-separated allowlist of tables. Blank = auto-discover all. */
  tables?: string;
}

// How many items to sample per table when inferring attributes.
const SCHEMA_SAMPLE_SIZE = 300;
// Hard ceiling on items pulled by a single PartiQL execution — protects the
// client's table from a runaway "scan everything" query. The base tool wrapper
// trims further to the caller's row limit.
const MAX_EXECUTE_ITEMS = 10000;

export class DynamoDBInstance extends BaseSource {
  private _raw: DynamoDBClient | null = null;
  private _doc: DynamoDBDocumentClient | null = null;

  private getConnectionConfig(): DynamoDBConfig {
    return this.config.config as DynamoDBConfig;
  }

  private get doc(): DynamoDBDocumentClient {
    if (this._doc) return this._doc;
    const cfg = this.getConnectionConfig();
    this._raw = new DynamoDBClient({
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        ...(cfg.sessionToken ? { sessionToken: cfg.sessionToken } : {}),
      },
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    });
    // DocumentClient marshals plain JS objects <-> DynamoDB wire format so the
    // rest of the pipeline sees normal rows ({ price: 42 }) not { price: { N } }.
    this._doc = DynamoDBDocumentClient.from(this._raw, {
      marshallOptions: { removeUndefinedValues: true },
    });
    return this._doc;
  }

  /**
   * "Connect" — build the client and verify credentials/reachability.
   */
  async connect(): Promise<void> {
    try {
      await this.doc.send(new ListTablesCommand({ Limit: 1 }));
      this.setConnected(true);
    } catch (error) {
      this.setConnected(false);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      this._raw?.destroy();
    } catch {
      // ignore
    }
    this._raw = null;
    this._doc = null;
    this.setConnected(false);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.doc.send(new ListTablesCommand({ Limit: 1 }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List the tables to expose: the config allowlist, else every table in the
   * account/region (paginated).
   */
  private async listTables(): Promise<string[]> {
    const cfg = this.getConnectionConfig();
    if (cfg.tables && cfg.tables.trim()) {
      return cfg.tables.split(',').map(t => t.trim()).filter(Boolean);
    }

    const names: string[] = [];
    let exclusiveStart: string | undefined;
    do {
      const res: any = await this.doc.send(
        new ListTablesCommand({ ExclusiveStartTableName: exclusiveStart, Limit: 100 })
      );
      names.push(...(res.TableNames || []));
      exclusiveStart = res.LastEvaluatedTableName;
    } while (exclusiveStart);
    return names;
  }

  /**
   * Extract a best-effort schema for each table:
   *  - DescribeTable: partition/sort keys (authoritative), GSIs, item count
   *  - Scan sample: infer non-key attributes, types, sample values
   */
  async extractSchema(): Promise<SourceSchema> {
    const tableNames = await this.listTables();
    console.log(`[DynamoDBInstance:${this.getName()}] Extracting schema for ${tableNames.length} table(s)...`);

    const entities: SchemaEntity[] = [];

    for (const tableName of tableNames) {
      try {
        const desc: any = await this.doc.send(new DescribeTableCommand({ TableName: tableName }));
        const table = desc.Table || {};
        const keySchema: Array<{ AttributeName: string; KeyType: string }> = table.KeySchema || [];
        const pk = keySchema.find(k => k.KeyType === 'HASH')?.AttributeName;
        const sk = keySchema.find(k => k.KeyType === 'RANGE')?.AttributeName;
        const itemCount = Number(table.ItemCount || 0);

        // GSIs — the attributes users can filter on WITHOUT a full scan.
        const gsis: Array<{ name: string; keys: string[] }> = (table.GlobalSecondaryIndexes || []).map((g: any) => ({
          name: g.IndexName,
          keys: (g.KeySchema || []).map((k: any) => k.AttributeName),
        }));

        // Sample items to discover non-key attributes and values.
        let sample: any[] = [];
        try {
          const scan: any = await this.doc.send(
            new ScanCommand({ TableName: tableName, Limit: SCHEMA_SAMPLE_SIZE })
          );
          sample = scan.Items || [];
        } catch (e) {
          console.warn(`[DynamoDBInstance:${this.getName()}] Could not sample ${tableName}: ${e instanceof Error ? e.message : String(e)}`);
        }

        const fields = this.inferFields(sample, pk, sk);

        const gsiNote = gsis.length
          ? `. GSIs (queryable without a full scan): ${gsis.map(g => `${g.name}(${g.keys.join(', ')})`).join('; ')}`
          : '';
        const keyNote = pk
          ? `Partition key: ${pk}${sk ? `, sort key: ${sk}` : ''}${gsiNote}`
          : gsiNote.replace(/^\. /, '');

        entities.push({
          name: tableName,
          fullName: tableName,
          description: keyNote || undefined,
          fields,
          rowCount: itemCount || sample.length,
          primaryKey: [pk, sk].filter(Boolean) as string[],
        });
      } catch (error) {
        console.warn(`[DynamoDBInstance:${this.getName()}] Failed to describe ${tableName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const schema: SourceSchema = {
      entities,
      extractedAt: new Date().toISOString(),
    };

    this.setSchema(schema);
    console.log(`[DynamoDBInstance:${this.getName()}] Extracted schema: ${entities.length} table(s)`);
    return schema;
  }

  /**
   * Infer fields from sampled items. DynamoDB items are heterogeneous, so we
   * take the union of attributes seen across the sample, pick the dominant type
   * per attribute, and keep a few distinct sample values. Key attributes are
   * always present even if the sample was empty.
   */
  private inferFields(items: any[], pk?: string, sk?: string): SchemaField[] {
    const attrs = new Map<string, { typeCounts: Map<string, number>; samples: any[]; nonNull: number }>();

    const touch = (name: string) => {
      if (!attrs.has(name)) attrs.set(name, { typeCounts: new Map(), samples: [], nonNull: 0 });
      return attrs.get(name)!;
    };

    // Keys always exist on the table even if absent from the sample.
    if (pk) touch(pk);
    if (sk) touch(sk);

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      for (const [name, value] of Object.entries(item)) {
        const a = touch(name);
        if (value === null || value === undefined) continue;
        a.nonNull++;
        const t = this.inferType(value);
        a.typeCounts.set(t, (a.typeCounts.get(t) || 0) + 1);
        if (a.samples.length < 5) {
          const display = t === 'JSON' ? JSON.stringify(value) : value;
          if (!a.samples.includes(display)) a.samples.push(display);
        }
      }
    }

    const fields: SchemaField[] = [];
    for (const [name, info] of attrs) {
      // Dominant inferred type (fall back to TEXT).
      let type = 'TEXT';
      let best = -1;
      for (const [t, c] of info.typeCounts) {
        if (c > best) { best = c; type = t; }
      }
      fields.push({
        name,
        type,
        nativeType: type,
        nullable: info.nonNull < items.length,
        isPrimaryKey: name === pk || name === sk,
        sampleValues: info.samples.slice(0, 5),
      });
    }
    return fields;
  }

  private inferType(value: any): string {
    if (typeof value === 'number') return 'NUMBER';
    if (typeof value === 'boolean') return 'BOOLEAN';
    if (typeof value === 'string') return 'TEXT';
    if (value instanceof Set) return 'JSON';
    if (typeof value === 'object') return 'JSON';
    return 'TEXT';
  }

  /**
   * Execute a PartiQL statement. Pages through results up to MAX_EXECUTE_ITEMS
   * so a bounded Scan completes but a runaway one is capped.
   *
   * DynamoDB PartiQL rejects a `LIMIT` clause and an `ORDER BY` clause *inside*
   * the statement (LIMIT is a request parameter; ordering isn't expressible).
   * The LLM naturally writes `... ORDER BY sk DESC LIMIT 10`, so we lift both
   * out and apply them ourselves — server-side `Limit` when we can stop early,
   * ordering and the final slice client-side.
   */
  async execute(params: { sql: string; params?: Record<string, any> }): Promise<QueryResult> {
    let { sql } = params;
    const { params: queryParams } = params;
    const startTime = Date.now();

    // Authorization seam. PartiQL DML uses the same INSERT/UPDATE/DELETE leading
    // keywords, so the regex guard applies directly; the AST rewriter does NOT run
    // here (SQLGlot has no PartiQL dialect) — see DIALECTS in sql-rewrite.ts.
    sql = await this.prepareSql(sql);

    const { statement, limit, orderBy } = this.stripUnsupportedClauses(
      this.substituteParams(sql, queryParams)
    );
    console.log(
      `[DynamoDBInstance:${this.getName()}] PartiQL:`,
      statement.substring(0, 120) + (statement.length > 120 ? '...' : ''),
      limit ? `(limit ${limit}${orderBy ? `, order ${orderBy.col} ${orderBy.dir}` : ''})` : ''
    );

    const data: any[] = [];
    let nextToken: string | undefined;
    let truncated = false;

    try {
      do {
        const res: any = await this.doc.send(
          new ExecuteStatementCommand({
            Statement: statement,
            NextToken: nextToken,
            // Only push the limit to the server when no ordering is needed —
            // ordering requires the full (bounded) result set before slicing.
            ...(!orderBy && limit ? { Limit: Math.min(limit, MAX_EXECUTE_ITEMS) } : {}),
          })
        );
        if (res.Items?.length) data.push(...res.Items);
        nextToken = res.NextToken;

        if (!orderBy && limit && data.length >= limit) break;
        if (data.length >= MAX_EXECUTE_ITEMS) {
          truncated = true;
          break;
        }
      } while (nextToken);

      if (orderBy) this.sortRows(data, orderBy.col, orderBy.dir);
      const finalData = limit ? data.slice(0, limit) : data;

      return {
        data: finalData,
        count: finalData.length,
        metadata: {
          executionTime: Date.now() - startTime,
          totalCount: finalData.length,
          ...(truncated ? { truncated: true, note: `Hit the ${MAX_EXECUTE_ITEMS}-item scan cap before ${orderBy ? 'ordering' : 'filtering'} completed — narrow the filter (ideally by partition key) for a complete answer.` } : {}),
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[DynamoDBInstance:${this.getName()}] PartiQL error:`, msg);
      throw new Error(`DynamoDB PartiQL failed: ${msg}\nStatement: ${statement}`);
    }
  }

  /**
   * Lift a trailing `... [ORDER BY col [ASC|DESC]] [LIMIT n]` out of a PartiQL
   * statement (DynamoDB supports neither as a clause). LIMIT is stripped first
   * since it trails ORDER BY in SQL; the connector re-applies both.
   */
  private stripUnsupportedClauses(sql: string): { statement: string; limit?: number; orderBy?: { col: string; dir: 'ASC' | 'DESC' } } {
    let statement = sql.trim().replace(/;\s*$/, '');
    let limit: number | undefined;
    let orderBy: { col: string; dir: 'ASC' | 'DESC' } | undefined;

    const limitMatch = statement.match(/\s+LIMIT\s+(\d+)\s*$/i);
    if (limitMatch) {
      limit = parseInt(limitMatch[1], 10);
      statement = statement.slice(0, limitMatch.index).trimEnd();
    }

    const orderMatch = statement.match(/\s+ORDER\s+BY\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(ASC|DESC)?\s*$/i);
    if (orderMatch) {
      orderBy = { col: orderMatch[1], dir: (orderMatch[2] || 'ASC').toUpperCase() as 'ASC' | 'DESC' };
      statement = statement.slice(0, orderMatch.index).trimEnd();
    }

    return { statement, limit, orderBy };
  }

  /**
   * Sort rows in place by a column, numeric-aware — the sort key (sk) holds
   * epoch-millis timestamps stored as strings, which must not sort lexically.
   */
  private sortRows(rows: any[], col: string, dir: 'ASC' | 'DESC'): void {
    const sign = dir === 'DESC' ? -1 : 1;
    rows.sort((a, b) => {
      const av = a?.[col];
      const bv = b?.[col];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const an = Number(av);
      const bn = Number(bv);
      if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * sign;
      return String(av).localeCompare(String(bv)) * sign;
    });
  }

  /**
   * Inline named parameters ($name / @name) into the PartiQL string. PartiQL
   * uses single-quoted string literals, same as SQL, so the quoting matches the
   * other SQL sources.
   */
  private substituteParams(sql: string, params?: Record<string, any>): string {
    if (!params || Object.keys(params).length === 0) return sql;
    return sql.replace(/[@$](\w+)/g, (match, paramName) => {
      if (match.startsWith('$') && /^\d+$/.test(paramName)) return match;
      if (!(paramName in params)) return match;
      const value = params[paramName];
      if (value === null || value === undefined) return 'NULL';
      if (typeof value === 'number') return String(value);
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      return `'${String(value).replace(/'/g, "''")}'`;
    });
  }

  // ============================================
  // Tool Generation — SQL (PartiQL) pattern
  // ============================================

  protected buildToolDescription(): string {
    const cfg = this.getConnectionConfig();
    const schemaInfo = this.formatSchemaForMainAgent();
    const sourceContext = this.getSourceContext();
    const domainHints = this.getDataDomainHints();

    return `Query ${this.config.name} (Amazon DynamoDB, region ${cfg.region}) using PartiQL.${sourceContext}${domainHints}

Available tables (partition/sort keys and any GSIs are shown per table):
${schemaInfo}

PartiQL usage and constraints (READ THESE — DynamoDB is NOT a relational database):
- Wrap table names in double quotes: SELECT * FROM "Orders" WHERE ...
- ALWAYS filter by the partition key when the question names a specific entity — that makes the read fast and cheap (an internal Query/GetItem). A query without the partition key scans the whole table.
- If you must filter by a non-key attribute, prefer one that is a GSI key (listed per table above) — DynamoDB will use the index. Otherwise the read is a full-table scan; keep it bounded with a WHERE and a small LIMIT.
- Supported in WHERE: =, <>, <, <=, >, >=, IN, BETWEEN, AND/OR/NOT, begins_with(attr, 'prefix'), contains(attr, 'x'), attribute_exists(attr).
- NOT supported: JOIN, GROUP BY, aggregate functions (COUNT/SUM/AVG/MIN/MAX), ORDER BY on non-key attributes, HAVING. Do NOT write these — the statement will fail.
- To answer an aggregation/analytics question: SELECT the rows you need (filtered as tightly as possible) and let the calling script compute totals/groupings/rankings in JS.
- Use LIMIT to cap rows.`;
  }

  protected getToolParams(): Record<string, string> {
    return {
      sql: 'string - PartiQL SELECT statement. Quote table names: SELECT * FROM "Table" WHERE pk = \'value\'. Filter by the partition key when possible.',
      params: 'object (optional) - Named parameters { "name": "value" }',
    };
  }

  protected getToolOutputSchema(): SourceTool['outputSchema'] {
    return {
      description: `Items from ${this.config.name}. Output attributes depend on the SELECT clause; DynamoDB items may be heterogeneous.`,
      fields: [
        { name: 'data', type: 'array', description: 'Array of matching items (rows)' },
        { name: 'count', type: 'number', description: 'Number of items returned' },
      ],
    };
  }
}
