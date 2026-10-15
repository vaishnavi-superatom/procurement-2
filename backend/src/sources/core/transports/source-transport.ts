/**
 * SourceTransport — the layer below a Source instance that actually moves
 * SQL and rows.
 *
 * Each SQL source (PostgresInstance, MssqlInstance, MysqlInstance) carries
 * exactly one SourceTransport, chosen at construction time from its config:
 *
 *   • DirectXxxTransport — talks to the DB via the dialect's native driver
 *     (pg, mysql2, mssql). This is today's behavior, just factored out.
 *
 *   • BridgeTransport — sends {sql, params} over a WebSocket to a db-bridge
 *     process running in a network that CAN reach the DB. Used when the
 *     backend itself cannot.
 *
 * Higher layers (BaseSource, source agent, scripts, direct tools, dashboards)
 * see only the BaseSource API. They never know which transport is in play.
 */

export type QueryParams = any[] | Record<string, any>;

export interface TransportQueryResult {
  rows: Record<string, any>[];
  rowCount: number;
  /** Total rows the underlying query matched before any caller-applied LIMIT. */
  totalCount?: number;
  /** Wall-clock execution time of the underlying query, in ms. */
  executionTimeMs?: number;
}

export interface TransportTable {
  schema: string;
  table: string;
}

export interface TransportColumn {
  column: string;
  type: string;
  nullable: boolean;
}

export interface SourceTransport {
  /** Lazy connect; safe to call multiple times. */
  connect?(): Promise<void>;

  /** Run a SQL statement with optional parameters. */
  query(sql: string, params?: QueryParams): Promise<TransportQueryResult>;

  /** Enumerate user tables/views the transport can see. */
  listTables(): Promise<TransportTable[]>;

  /** Describe columns for a single table by name. */
  getSchema(table: string): Promise<TransportColumn[]>;

  /** Cleanup — close pools, sockets, etc. */
  disconnect?(): Promise<void>;
}
