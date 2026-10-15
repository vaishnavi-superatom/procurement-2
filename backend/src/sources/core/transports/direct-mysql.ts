/**
 * DirectMysqlTransport
 *
 * Wraps the existing mysql2 pool-based connection management for MySQL — lazy
 * pool creation, health-checked reconnects, positional ? bindings. Extracted
 * from mysql/instance.ts so the instance can pick between this and
 * BridgeTransport at construction time.
 */

import * as mysql from 'mysql2/promise';
import {
  SourceTransport,
  TransportQueryResult,
  TransportTable,
  TransportColumn,
  QueryParams,
} from './source-transport';

const HEALTH_CHECK_INTERVAL = 30_000;

export interface DirectMysqlConfig {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  timezone?: string;
  logTag?: string;
}

export class DirectMysqlTransport implements SourceTransport {
  private pool: mysql.Pool | null = null;
  private lastHealthCheck = 0;
  private poolReady: Promise<mysql.Pool> | null = null;
  private readonly cfg: DirectMysqlConfig;
  private readonly tag: string;

  constructor(cfg: DirectMysqlConfig) {
    this.cfg = cfg;
    this.tag = cfg.logTag ?? `${cfg.host}/${cfg.database}`;
  }

  async connect(): Promise<void> {
    await this.getPool();
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.lastHealthCheck = 0;
      console.log(`[DirectMysql:${this.tag}] Connection pool closed`);
    }
  }

  async query(sqlText: string, params?: QueryParams): Promise<TransportQueryResult> {
    // mysql2 binds positionally — array shape only. Object shape ignored.
    const values = Array.isArray(params) ? params : undefined;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const pool = await this.getPool();
      const startedAt = Date.now();
      try {
        const [rows, resultInfo] = values && values.length > 0
          ? await pool.query(sqlText, values)
          : await pool.query(sqlText);
        const isArray = Array.isArray(rows);
        const data = isArray ? (rows as any[]) : [];
        const count = isArray ? data.length : ((resultInfo as any)?.affectedRows || 0);
        return {
          rows: data,
          rowCount: count,
          totalCount: count,
          executionTimeMs: Date.now() - startedAt,
        };
      } catch (error: any) {
        const isConnErr = this.isConnectionError(error);
        if (isConnErr && attempt === 1) {
          console.warn(`[DirectMysql:${this.tag}] Connection error, resetting pool and retrying:`, error.message || error.code);
          await this.resetPool();
          continue;
        }
        const msg = error.sqlMessage || error.message || 'Unknown database error';
        const code = error.code ? ` [${error.code}]` : '';
        throw new Error(`Database query failed: ${msg}${code}`);
      }
    }
    throw new Error('Database query failed: unexpected execution path');
  }

  async listTables(): Promise<TransportTable[]> {
    const result = await this.query(
      `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [this.cfg.database],
    );
    return result.rows as TransportTable[];
  }

  async getSchema(table: string): Promise<TransportColumn[]> {
    const result = await this.query(
      `SELECT COLUMN_NAME AS \`column\`,
              DATA_TYPE AS \`type\`,
              CASE WHEN IS_NULLABLE = 'YES' THEN 1 ELSE 0 END AS nullable
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [this.cfg.database, table],
    );
    return result.rows.map((r: any) => ({ column: r.column, type: r.type, nullable: !!r.nullable }));
  }

  // ----------------------------------------------------------------
  // Pool lifecycle (extracted from mysql/instance.ts)
  // ----------------------------------------------------------------

  private createPool(): mysql.Pool {
    const cfg = this.cfg;
    return mysql.createPool({
      host: cfg.host,
      port: cfg.port || 3306,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      timezone: cfg.timezone || 'UTC',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      idleTimeout: 20000,
    });
  }

  private async validatePoolConnection(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const connection = await this.pool.getConnection();
      await connection.query('SELECT 1 as health_check');
      connection.release();
      return true;
    } catch (error) {
      console.warn(`[DirectMysql:${this.tag}] Pool health check failed:`, (error as Error).message);
      return false;
    }
  }

  private async resetPool(): Promise<void> {
    if (this.pool) {
      try {
        console.log(`[DirectMysql:${this.tag}] Closing stale connection pool...`);
        await this.pool.end();
      } catch (error) {
        console.warn(`[DirectMysql:${this.tag}] Error closing stale pool:`, (error as Error).message);
      }
      this.pool = null;
    }
  }

  private isConnectionError(error: any): boolean {
    const code = error.code || '';
    const message = (error.message || '').toLowerCase();
    if (error instanceof TypeError) return true;
    if (['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EPIPE', 'PROTOCOL_CONNECTION_LOST'].includes(code)) return true;
    if (
      message.includes('connection lost') ||
      message.includes('connection terminated') ||
      message.includes('connection refused') ||
      message.includes('timeout') ||
      message.includes('cannot enqueue') ||
      message.includes('cannot read properties of null') ||
      message.includes('pool is closed')
    ) return true;
    return false;
  }

  private getPool(): Promise<mysql.Pool> {
    if (this.poolReady) return this.poolReady;

    const now = Date.now();
    if (this.pool && (now - this.lastHealthCheck) <= HEALTH_CHECK_INTERVAL) {
      return Promise.resolve(this.pool);
    }

    this.poolReady = (async () => {
      try {
        if (this.pool && (Date.now() - this.lastHealthCheck) <= HEALTH_CHECK_INTERVAL) {
          return this.pool;
        }

        if (this.pool) {
          console.log(`[DirectMysql:${this.tag}] Validating pool connection after idle period...`);
          const isHealthy = await this.validatePoolConnection();
          if (isHealthy) {
            this.lastHealthCheck = Date.now();
            console.log(`[DirectMysql:${this.tag}] Pool connection validated successfully`);
            return this.pool;
          }
          console.warn(`[DirectMysql:${this.tag}] Pool connection is stale, recreating...`);
          await this.resetPool();
        }

        console.log(`[DirectMysql:${this.tag}] Creating new connection pool...`);
        this.pool = this.createPool();

        const connection = await this.pool.getConnection();
        const [rows] = await connection.query('SELECT NOW() as server_time');
        const serverTime = (rows as any[])[0]?.server_time;
        connection.release();

        console.log(`[DirectMysql:${this.tag}] Connected to ${this.cfg.host}/${this.cfg.database}, server time:`, serverTime);

        this.lastHealthCheck = Date.now();
        return this.pool;
      } catch (error) {
        console.error(`[DirectMysql:${this.tag}] Error initializing connection pool:`, error);
        this.pool = null;
        throw error;
      } finally {
        this.poolReady = null;
      }
    })();

    return this.poolReady;
  }
}
