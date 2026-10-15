/**
 * Bridge WebSocket Client
 *
 * Holds at most ONE WebSocket connection per (wsUrl, projectId). Every
 * BridgeTransport bound to the same projectId multiplexes its queries
 * through this shared connection — one TLS/socket setup serves all sources.
 *
 * Each outbound message carries a unique `id`. Responses are routed back to
 * the awaiting Promise by matching that id. Reconnects happen automatically
 * with a small backoff; any queries in flight when the socket drops reject
 * cleanly so the caller can retry.
 *
 * The DB-bridge wire format is defined in ~/superatom/db-bridge/src/types.ts.
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';

/** Subset of the BroadcastMessage shape we send. */
interface OutboundMessage {
  id: string;
  type: 'query' | 'list-tables' | 'get-schema' | 'ping-bridge';
  to: { type: 'db-bridge' };
  payload: any;
}

/** Subset of the BroadcastMessage shape we receive. */
interface InboundMessage {
  id?: string;
  type: string;
  from?: { type?: string; id?: string };
  to?: { type?: string; id?: string };
  payload: any;
}

interface PendingCall {
  resolve: (payload: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  type: string;
}

export interface BridgeClientOptions {
  wsUrl: string;
  projectId: string;
  apiKey?: string;
  /** Default per-call timeout in ms (default 5min — matches db-bridge's own requestTimeout). */
  defaultTimeoutMs?: number;
}

/**
 * Cache key — one client per (wsUrl, projectId, apiKey?) tuple. ApiKey
 * participates so swapping creds yields a fresh connection rather than
 * silently reusing the old one.
 */
function clientKey(opts: BridgeClientOptions): string {
  return `${opts.wsUrl}::${opts.projectId}::${opts.apiKey ?? ''}`;
}

const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 3_000;
// Matches db-bridge's own MSSQL requestTimeout (300000ms) — previously this
// client gave up at 60s while db-bridge kept the query running for up to 5
// minutes, so a merely-slow-but-alive query was killed client-side long
// before db-bridge itself would have given up.
const DEFAULT_TIMEOUT_MS = 300_000;

export class BridgeWsClient {
  private static instances: Map<string, BridgeWsClient> = new Map();

  /** Get-or-create the shared client for a (wsUrl, projectId) tuple. */
  static getOrCreate(opts: BridgeClientOptions): BridgeWsClient {
    const key = clientKey(opts);
    let client = BridgeWsClient.instances.get(key);
    if (!client) {
      client = new BridgeWsClient(opts);
      BridgeWsClient.instances.set(key, client);
    }
    return client;
  }

  private readonly opts: BridgeClientOptions;
  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private pending: Map<string, PendingCall> = new Map();
  private pingTimer: NodeJS.Timeout | null = null;
  private closedExplicitly = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private constructor(opts: BridgeClientOptions) {
    this.opts = opts;
  }

  /**
   * Send a query message and await the matching response by id.
   * `messageType` selects which db-bridge handler will respond — the bridge
   * routes by `type` and echoes the same id in the reply.
   */
  async sendQuery(
    messageType: 'query' | 'list-tables' | 'get-schema',
    payload: any,
    timeoutMs?: number,
  ): Promise<any> {
    await this.ensureOpen();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('[BridgeWsClient] WebSocket not open after ensureOpen');
    }

    const id = randomUUID();
    const message: OutboundMessage = {
      id,
      type: messageType,
      to: { type: 'db-bridge' },
      payload,
    };

    const wallMs = timeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[BridgeWsClient] ${messageType} timed out after ${wallMs}ms (id=${id.substring(0, 8)})`));
      }, wallMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        type: messageType,
      });

      try {
        // The bridge replies with `to: { id: msg.from.id }`. The relay also
        // broadcasts on type, so the from.id only matters when multiple
        // runtime clients share a project — for safety include a stable
        // per-call id matching the outbound message id.
        this.ws!.send(JSON.stringify({
          ...message,
          from: { type: 'runtime', id },
        }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Force-close the client and drop the cached instance. */
  async close(): Promise<void> {
    this.closedExplicitly = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('[BridgeWsClient] Client closed'));
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    BridgeWsClient.instances.delete(clientKey(this.opts));
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private ensureOpen(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = this.openSocket().finally(() => { this.opening = null; });
    return this.opening;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Server-side data-plane connection: authenticate with the project API
      // key, not a browser session. 'data-agent' is a KEY_REQUIRED_TYPE the
      // worker validates + marks authenticated. 'runtime' (a browser type) now
      // demands a session JWT under WS_AUTH_ENFORCE and would be rejected 401.
      const params = new URLSearchParams({
        projectId: this.opts.projectId,
        type: 'data-agent',
      });
      if (this.opts.apiKey) params.set('apiKey', this.opts.apiKey);
      const url = `${this.opts.wsUrl}?${params}`;

      const ws = new WebSocket(url);
      this.ws = ws;

      const onOpen = () => {
        console.log(`[BridgeWsClient] Connected to ${this.opts.wsUrl} (projectId=${this.opts.projectId})`);
        ws.off('error', onErrorBeforeOpen);
        this.startPing();
        resolve();
      };

      const onErrorBeforeOpen = (err: Error) => {
        ws.off('open', onOpen);
        reject(err);
      };

      ws.once('open', onOpen);
      ws.once('error', onErrorBeforeOpen);

      ws.on('message', (raw) => this.handleMessage(raw));
      ws.on('close', (code, reason) => this.handleClose(code, reason?.toString()));
      ws.on('error', (err) => {
        console.warn(`[BridgeWsClient] WebSocket error:`, (err as Error).message);
      });
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: InboundMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg.id) return;

    const pending = this.pending.get(msg.id);
    if (!pending) return; // unmatched — could be a stray broadcast

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);

    if (msg.type === 'query-error') {
      pending.reject(new Error(msg.payload?.error || 'query-error from bridge'));
      return;
    }

    pending.resolve(msg.payload);
  }

  private handleClose(code: number, reason?: string): void {
    console.warn(`[BridgeWsClient] Disconnected (code=${code}, reason=${reason || 'none'})`);
    this.stopPing();
    this.ws = null;
    this.rejectAllPending(new Error(`[BridgeWsClient] WebSocket closed mid-call (code=${code})`));
    if (!this.closedExplicitly) this.scheduleReconnect();
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket().catch(err => {
        console.warn(`[BridgeWsClient] Reconnect failed:`, (err as Error).message);
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ type: 'PING' })); } catch { /* ignore */ }
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
