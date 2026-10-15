/**
 * BridgeTransport — runs SQL via a remote db-bridge over WebSocket.
 *
 * Implements the SourceTransport contract so a SQL source instance
 * (PostgresInstance / MssqlInstance / MysqlInstance) can use it
 * interchangeably with a direct DB-driver transport.
 *
 * The transport is dialect-aware only for purposes of normalizing the
 * outbound parameter shape: postgres/mysql expect positional arrays at the
 * driver level, while mssql expects a named object. The bridge itself
 * forwards whichever shape arrives — see ~/superatom/db-bridge/.
 */

import {
  SourceTransport,
  TransportQueryResult,
  TransportTable,
  TransportColumn,
  QueryParams,
} from './source-transport';
import { BridgeWsClient } from './ws-client';

export interface BridgeTransportConfig {
  wsUrl: string;
  projectId: string;
  apiKey?: string;
  /** Upstream dialect — controls how we normalize params before sending. */
  dialect: 'postgres' | 'mysql' | 'mssql';
  /** Per-call timeout override (ms). Default 5min — matches db-bridge's own requestTimeout. */
  queryTimeoutMs?: number;
}

export class BridgeTransport implements SourceTransport {
  private readonly client: BridgeWsClient;
  private readonly cfg: BridgeTransportConfig;

  constructor(cfg: BridgeTransportConfig) {
    this.cfg = cfg;
    this.client = BridgeWsClient.getOrCreate({
      wsUrl: cfg.wsUrl,
      projectId: cfg.projectId,
      apiKey: cfg.apiKey,
      defaultTimeoutMs: cfg.queryTimeoutMs,
    });
  }

  /**
   * No-op — the underlying WS client opens lazily on first sendQuery.
   * Provided so callers can pre-warm the socket if they want to surface
   * connection errors early.
   */
  async connect(): Promise<void> {
    // First call to the shared client triggers the WS open. Trigger it with
    // a cheap no-op-like call only when the caller explicitly asks.
  }

  async query(sql: string, params?: QueryParams): Promise<TransportQueryResult> {
    const normalizedParams = this.normalizeParams(params);
    const startedAt = Date.now();
    const payload = await this.client.sendQuery(
      'query',
      normalizedParams === undefined
        ? { sql }
        : { sql, params: normalizedParams },
      this.cfg.queryTimeoutMs,
    );

    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const rowCount = typeof payload?.rowCount === 'number' ? payload.rowCount : rows.length;

    return {
      rows,
      rowCount,
      totalCount: rowCount,
      executionTimeMs: Date.now() - startedAt,
    };
  }

  async listTables(): Promise<TransportTable[]> {
    const payload = await this.client.sendQuery('list-tables', {});
    const tables = Array.isArray(payload?.tables) ? payload.tables : [];
    return tables;
  }

  async getSchema(table: string): Promise<TransportColumn[]> {
    const payload = await this.client.sendQuery('get-schema', { table });
    const columns = Array.isArray(payload?.columns) ? payload.columns : [];
    return columns;
  }

  /**
   * The dialect drivers behind the bridge each prefer one param shape:
   *   - postgres / mysql → positional any[]
   *   - mssql            → named Record<string, any>
   *
   * If the caller passed the dialect's preferred shape, send it as-is.
   * If they passed the other shape, send it through unchanged — the bridge
   * driver will ignore it (postgres/mysql) or coerce it (mssql) — but we
   * log a warning since the callsite should normalize for that dialect.
   */
  private normalizeParams(params?: QueryParams): QueryParams | undefined {
    if (params === undefined) return undefined;
    if (Array.isArray(params) && params.length === 0) return undefined;
    if (!Array.isArray(params) && Object.keys(params).length === 0) return undefined;

    const isArray = Array.isArray(params);
    const preferred =
      (this.cfg.dialect === 'mssql' && !isArray) ||
      ((this.cfg.dialect === 'postgres' || this.cfg.dialect === 'mysql') && isArray);

    if (!preferred) {
      console.warn(
        `[BridgeTransport:${this.cfg.dialect}] Param shape mismatch — got ${isArray ? 'array' : 'object'}, ` +
        `but ${this.cfg.dialect} prefers ${isArray ? 'named object' : 'positional array'}. ` +
        `Passing through; caller should normalize before sending.`,
      );
    }
    return params;
  }
}
