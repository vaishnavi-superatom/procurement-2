/**
 * DirectMssqlTransport
 *
 * Wraps the existing mssql ConnectionPool-based connection management — lazy
 * pool creation, health-checked reconnects, named-input binding via
 * pool.request().input(name, value). Extracted from mssql/instance.ts so the
 * instance can pick between this and BridgeTransport.
 */

import sql from 'mssql';
import {
  SourceTransport,
  TransportQueryResult,
  TransportTable,
  TransportColumn,
  QueryParams,
} from './source-transport';

const HEALTH_CHECK_INTERVAL = 30_000;

export interface DirectMssqlConfig {
  server: string;
  port?: number;
  database?: string;
  user: string;
  password: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  schema?: string;
  logTag?: string;
}

export class DirectMssqlTransport implements SourceTransport {
  private pool: sql.ConnectionPool | null = null;
  private lastHealthCheck = 0;
  private poolReady: Promise<sql.ConnectionPool> | null = null;
  private readonly cfg: DirectMssqlConfig;
  private readonly tag: string;

  constructor(cfg: DirectMssqlConfig) {
    this.cfg = cfg;
    this.tag = cfg.logTag ?? `${cfg.server}/${cfg.database || '(user default)'}`;
  }

  async connect(): Promise<void> {
    await this.getPool();
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
      this.lastHealthCheck = 0;
      console.log(`[DirectMssql:${this.tag}] Connection pool closed`);
    }
  }

  async query(sqlText: string, params?: QueryParams): Promise<TransportQueryResult> {
    // Retry once on connection errors.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const pool = await this.getPool();
      const startedAt = Date.now();
      try {
        const request = pool.request();
        if (params && !Array.isArray(params) && typeof params === 'object') {
          for (const [name, value] of Object.entries(params)) {
            request.input(name, value as any);
          }
        } else if (Array.isArray(params)) {
          // Caller chose positional; expose them as @p0, @p1, ...
          params.forEach((value, idx) => request.input(`p${idx}`, value as any));
        }
        const result = await request.query(sqlText);
        return {
          rows: result.recordset || [],
          rowCount: result.recordset?.length ?? 0,
          totalCount: result.rowsAffected?.[0],
          executionTimeMs: Date.now() - startedAt,
        };
      } catch (error: any) {
        const isConnErr = this.isConnectionError(error);
        if (isConnErr && attempt === 1) {
          console.warn(`[DirectMssql:${this.tag}] Connection error, resetting pool and retrying:`, error.message || error.code);
          await this.resetPool();
          continue;
        }
        const msg = error.message || 'Unknown database error';
        const detail = error.originalError?.message ? ` (${error.originalError.message})` : '';
        const code = (error.code || error.number) ? ` [${error.code || error.number}]` : '';
        throw new Error(`Database query failed: ${msg}${detail}${code}`);
      }
    }
    throw new Error('Database query failed: unexpected execution path');
  }

  async listTables(): Promise<TransportTable[]> {
    const result = await this.query(
      `SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [table]
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );
    return result.rows as TransportTable[];
  }

  async getSchema(table: string): Promise<TransportColumn[]> {
    const result = await this.query(
      `SELECT COLUMN_NAME AS [column],
              DATA_TYPE AS [type],
              CASE WHEN IS_NULLABLE = 'YES' THEN 1 ELSE 0 END AS nullable
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_NAME = @table
       ORDER BY ORDINAL_POSITION`,
      { table },
    );
    return result.rows.map((r: any) => ({ column: r.column, type: r.type, nullable: !!r.nullable }));
  }

  // ----------------------------------------------------------------
  // Pool lifecycle (extracted from mssql/instance.ts)
  // ----------------------------------------------------------------

  private async validatePoolConnection(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.request().query('SELECT 1 as health_check');
      return true;
    } catch (error) {
      console.warn(`[DirectMssql:${this.tag}] Pool health check failed:`, (error as Error).message);
      return false;
    }
  }

  private async resetPool(): Promise<void> {
    if (this.pool) {
      try {
        console.log(`[DirectMssql:${this.tag}] Closing stale connection pool...`);
        await this.pool.close();
      } catch (error) {
        console.warn(`[DirectMssql:${this.tag}] Error closing stale pool:`, (error as Error).message);
      }
      this.pool = null;
    }
  }

  private isConnectionError(error: any): boolean {
    const code = error.code || '';
    const message = (error.message || '').toLowerCase();
    if (error instanceof TypeError) return true;
    if (['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EPIPE', 'ESOCKET'].includes(code)) return true;
    if (
      message.includes('connection lost') ||
      message.includes('connection is closed') ||
      message.includes('connection terminated') ||
      message.includes('connection refused') ||
      message.includes('timeout') ||
      message.includes('socket error') ||
      message.includes('cannot read properties of null') ||
      message.includes('pool is closed')
    ) return true;
    return false;
  }

  private getPool(): Promise<sql.ConnectionPool> {
    if (this.poolReady) return this.poolReady;

    const now = Date.now();
    if (this.pool && this.pool.connected && (now - this.lastHealthCheck) <= HEALTH_CHECK_INTERVAL) {
      return Promise.resolve(this.pool);
    }

    this.poolReady = (async () => {
      try {
        if (this.pool && this.pool.connected && (Date.now() - this.lastHealthCheck) <= HEALTH_CHECK_INTERVAL) {
          return this.pool;
        }

        if (this.pool && this.pool.connected) {
          console.log(`[DirectMssql:${this.tag}] Validating pool connection after idle period...`);
          const isHealthy = await this.validatePoolConnection();
          if (isHealthy) {
            this.lastHealthCheck = Date.now();
            console.log(`[DirectMssql:${this.tag}] Pool connection validated successfully`);
            return this.pool;
          }
          console.warn(`[DirectMssql:${this.tag}] Pool connection is stale, recreating...`);
          await this.resetPool();
        }

        console.log(`[DirectMssql:${this.tag}] Creating new connection pool...`);
        const poolConfig: sql.config = {
          server: this.cfg.server,
          port: this.cfg.port || 1433,
          ...(this.cfg.database ? { database: this.cfg.database } : {}),
          user: this.cfg.user,
          password: this.cfg.password,
          requestTimeout: 300000,
          connectionTimeout: 30000,
          options: {
            encrypt: this.cfg.encrypt ?? true,
            trustServerCertificate: this.cfg.trustServerCertificate ?? true,
            enableArithAbort: true,
          },
          // max was 10 — a dashboard with many widgets (KPIs/charts/filters) can
          // burst well past that on a single filter change, since every widget
          // currently refetches on any filter change regardless of whether its
          // own SQL references that filter's params. Requests beyond the pool
          // cap queue for a free connection and fail with "operation timed out
          // for an unknown reason" once the wait exceeds the driver's timeout.
          // acquireTimeoutMillis: tarn.js default is 30s. Raised to match requestTimeout
          // (5 min) so queries that queue behind a slow view survive even on cold SQL Server
          // cache (after a server restart, the first vw_sgtpl_billwiseoutstanding scan can
          // take 2-4 minutes while pages reload from disk vs 30-50s on warm cache).
          pool: { max: 30, min: 0, idleTimeoutMillis: 20000, acquireTimeoutMillis: 300000 },
        };

        this.pool = await new sql.ConnectionPool(poolConfig).connect();

        const result = await this.pool.request().query('SELECT GETDATE() as server_time');
        console.log(`[DirectMssql:${this.tag}] Connected to ${this.cfg.server}/${this.cfg.database || '(user default)'}, server time:`, result.recordset[0].server_time);

        this.lastHealthCheck = Date.now();
        return this.pool;
      } catch (error) {
        console.error(`[DirectMssql:${this.tag}] Error initializing connection pool:`, error);
        this.pool = null;
        throw error;
      } finally {
        this.poolReady = null;
      }
    })();

    return this.poolReady;
  }
}
