/**
 * DirectPostgresTransport
 *
 * Wraps the existing pg.Pool-based connection management for PostgreSQL — lazy
 * pool creation, health-checked reconnects, TCP keepalive, named-to-positional
 * param conversion. Extracted from postgres/instance.ts so the instance can
 * pick between this and BridgeTransport at construction time.
 */

import pg from 'pg';
import {
  SourceTransport,
  TransportQueryResult,
  TransportTable,
  TransportColumn,
  QueryParams,
} from './source-transport';

const { Pool } = pg;

// Validate the pool's connection only when it has been idle for this long.
const HEALTH_CHECK_INTERVAL = 30_000;

export interface DirectPostgresConfig {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  schema?: string;
  /** Tag used in log lines; usually the source name. */
  logTag?: string;
}

export class DirectPostgresTransport implements SourceTransport {
  private pool: pg.Pool | null = null;
  private lastHealthCheck = 0;
  private poolReady: Promise<pg.Pool> | null = null;
  private readonly cfg: DirectPostgresConfig;
  private readonly tag: string;

  constructor(cfg: DirectPostgresConfig) {
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
      console.log(`[DirectPostgres:${this.tag}] Connection pool closed`);
    }
  }

  async query(sql: string, params?: QueryParams): Promise<TransportQueryResult> {
    // pg binds positionally — caller (PostgresInstance) is expected to have
    // already converted any named placeholders to $1,$2,... and passed values
    // as an array. Object-shape params are ignored here.
    const values = Array.isArray(params) ? params : undefined;

    // Retry once on connection errors (pool may have stale connections after idle)
    for (let attempt = 1; attempt <= 2; attempt++) {
      const pool = await this.getPool();
      const startedAt = Date.now();
      try {
        const result = values && values.length > 0
          ? await pool.query(sql, values)
          : await pool.query(sql);
        return {
          rows: result.rows,
          rowCount: result.rowCount ?? result.rows.length,
          totalCount: result.rowCount ?? result.rows.length,
          executionTimeMs: Date.now() - startedAt,
        };
      } catch (error: any) {
        const isConnErr = this.isConnectionError(error);
        if (isConnErr && attempt === 1) {
          console.warn(`[DirectPostgres:${this.tag}] Connection error, resetting pool and retrying:`, error.message || error.code);
          await this.resetPool();
          continue;
        }
        const msg = error.message || 'Unknown database error';
        const detail = error.detail ? ` (${error.detail})` : '';
        const code = error.code ? ` [${error.code}]` : '';
        throw new Error(`Database query failed: ${msg}${detail}${code}`);
      }
    }
    throw new Error('Database query failed: unexpected execution path');
  }

  async listTables(): Promise<TransportTable[]> {
    const result = await this.query(
      `SELECT table_schema AS schema, table_name AS table
       FROM information_schema.tables
       WHERE table_type = 'BASE TABLE'
         AND table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name`,
    );
    return result.rows as TransportTable[];
  }

  async getSchema(table: string): Promise<TransportColumn[]> {
    const result = await this.query(
      `SELECT column_name AS "column",
              data_type AS "type",
              CASE WHEN is_nullable = 'YES' THEN true ELSE false END AS nullable
       FROM information_schema.columns
       WHERE table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );
    return result.rows as TransportColumn[];
  }

  // ----------------------------------------------------------------
  // Pool lifecycle (extracted from postgres/instance.ts)
  // ----------------------------------------------------------------

  private createPool(): pg.Pool {
    const cfg = this.cfg;
    const newPool = new Pool({
      host: cfg.host,
      port: cfg.port || 5432,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      ssl: cfg.ssl ? { rejectUnauthorized: false, servername: cfg.host } : undefined,
      max: 10,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 30000,
      allowExitOnIdle: false,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    newPool.on('connect', () => {
      console.log(`[DirectPostgres:${this.tag}] New client connected`);
    });
    newPool.on('error', (err) => {
      console.warn(`[DirectPostgres:${this.tag}] Idle client error (pool will auto-recover):`, err.message);
    });
    return newPool;
  }

  private async validatePoolConnection(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1 as health_check');
      return true;
    } catch (error) {
      console.warn(`[DirectPostgres:${this.tag}] Pool health check failed:`, (error as Error).message);
      return false;
    }
  }

  private async resetPool(): Promise<void> {
    if (this.pool) {
      try {
        console.log(`[DirectPostgres:${this.tag}] Closing stale connection pool...`);
        await this.pool.end();
      } catch (error) {
        console.warn(`[DirectPostgres:${this.tag}] Error closing stale pool:`, (error as Error).message);
      }
      this.pool = null;
    }
  }

  private getPool(): Promise<pg.Pool> {
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
          console.log(`[DirectPostgres:${this.tag}] Validating pool connection after idle period...`);
          const isHealthy = await this.validatePoolConnection();
          if (isHealthy) {
            this.lastHealthCheck = Date.now();
            console.log(`[DirectPostgres:${this.tag}] Pool connection validated successfully`);
            return this.pool;
          }
          console.warn(`[DirectPostgres:${this.tag}] Pool connection is stale, recreating...`);
          await this.resetPool();
        }

        console.log(`[DirectPostgres:${this.tag}] Creating new connection pool...`);
        this.pool = this.createPool();

        const result = await this.pool.query('SELECT NOW() as server_time');
        console.log(`[DirectPostgres:${this.tag}] Connected to ${this.cfg.host}/${this.cfg.database}, server time:`, result.rows[0].server_time);

        this.lastHealthCheck = Date.now();
        return this.pool;
      } catch (error) {
        console.error(`[DirectPostgres:${this.tag}] Error initializing connection pool:`, error);
        this.pool = null;
        throw error;
      } finally {
        this.poolReady = null;
      }
    })();

    return this.poolReady;
  }

  private isConnectionError(error: any): boolean {
    if (!error) return false;
    const code = error.code;
    const message = (error.message || '').toLowerCase();
    const connectionErrorCodes = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'EAI_AGAIN',
    ];
    if (code && connectionErrorCodes.includes(code)) return true;
    const connectionErrorPatterns = [
      'connection terminated',
      'connection refused',
      'connection reset',
      'connection timeout',
      'connection ended',
      'connection lost',
      'server closed the connection',
      'client has encountered',
      'pool is ending',
      'pool ended',
      'pool was destroyed',
      'pool already destroyed',
      'connection pool destroyed',
      'connection has been closed',
      'connection is closed',
    ];
    return connectionErrorPatterns.some((p) => message.includes(p));
  }
}
