/**
 * Proxy Connection System
 *
 * One WebSocket from this deployment to the project's Durable Object. The DO
 * owns the data-source→proxy routing; this client is dumb about location. It
 * has two roles over the single socket (see docs/cross-machine-source-proxy.md):
 *
 *   1. Registrar — on connect, announces this proxy's `proxyId` and the
 *      Data Source IDs it currently manages via REGISTER_PROXY. Re-announced on
 *      every (re)connect so the DO's records point at the live connection.
 *   2. Requester — remoteQuery(dataSourceId, sql) sends a DS_QUERY (with NO
 *      target) to the DO and awaits the reply; the DO forwards it to whichever
 *      proxy owns the data source. The requester never learns which proxy that is.
 *   3. Responder — a DS_QUERY the DO forwarded to us is served from the local
 *      Data Source Manager: check the data source exists and is connected, ACK
 *      immediately, run it, return DS_RESULT (or DS_ERROR right away).
 *
 * Request/reply correlation is by the message `id` (the Request ID), reusing the
 * pattern from sources/core/transports/ws-client.ts.
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getSourceManager } from '../sources';
import { runAsSystem } from '@superatomai/sdk-node';

const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 3_000;
// Fast fail if the DO can't even ack (no owner / offline); longer wait once a
// remote proxy has acked that it's querying.
const ACK_TIMEOUT_MS = 15_000;
const RESULT_TIMEOUT_MS = 60_000;

/** DS_ERROR codes that mean "the data source isn't reachable" → surfaced as 404. */
const UNAVAILABLE_CODES = new Set(['NO_OWNER', 'NOT_FOUND', 'NOT_CONNECTED']);

interface PendingCall {
	resolve: (payload: any) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
	dataSourceId: string;
	onAck: () => void;
}

/** Thrown when no connected proxy in the project can serve the data source. */
export class SourceUnavailableError extends Error {
	constructor(dataSourceId: string, detail?: string) {
		super(detail || `Data source '${dataSourceId}' is not available on any connected proxy`);
		this.name = 'SourceUnavailableError';
	}
}

export interface SourceProxyOptions {
	wsUrl: string;
	projectId: string;
	proxyId: string;
	apiKey?: string;
}

export class SourceProxyClient {
	private readonly opts: SourceProxyOptions;
	private ws: WebSocket | null = null;
	private opening: Promise<void> | null = null;
	private pending: Map<string, PendingCall> = new Map();
	private pingTimer: NodeJS.Timeout | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private closedExplicitly = false;

	constructor(opts: SourceProxyOptions) {
		this.opts = opts;
	}

	// ----------------------------------------------------------------
	// Public API
	// ----------------------------------------------------------------

	async start(): Promise<void> {
		await this.ensureOpen();
	}

	/** The Data Source IDs this deployment currently has connected. */
	private ownedDataSourceIds(): string[] {
		const mgr = getSourceManager();
		if (!mgr) return [];
		return mgr.getStatus().sources.filter(s => s.connected).map(s => s.id);
	}

	/** (Re)announce this proxy's data sources to the DO. Fire-and-forget. */
	register(): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		const dataSourceIds = this.ownedDataSourceIds();
		try {
			this.ws.send(JSON.stringify({
				id: randomUUID(),
				type: 'REGISTER_PROXY',
				from: { type: 'runtime' },
				payload: { proxyId: this.opts.proxyId, dataSourceIds },
			}));
			console.log(`[ProxyConn] Registered proxyId=${this.opts.proxyId} → [${dataSourceIds.join(', ')}]`);
		} catch (err) {
			console.warn('[ProxyConn] register failed:', (err as Error).message);
		}
	}

	/**
	 * Run SQL against a data source by id. Sends DS_QUERY to the DO (no target);
	 * the DO routes it to the owning proxy. Returns {data, count}. Throws
	 * SourceUnavailableError when nothing in the project can serve it.
	 */
	async remoteQuery(dataSourceId: string, sql: string, params?: any): Promise<{ data: any[]; count: number }> {
		await this.ensureOpen();
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new SourceUnavailableError(dataSourceId, 'Proxy connection to the Durable Object is not open');
		}

		const id = randomUUID();
		const payload = await new Promise<any>((resolve, reject) => {
			const entry: PendingCall = {
				resolve,
				reject,
				dataSourceId,
				timer: setTimeout(() => {
					this.pending.delete(id);
					reject(new SourceUnavailableError(dataSourceId, `No proxy acknowledged data source '${dataSourceId}' within ${ACK_TIMEOUT_MS}ms`));
				}, ACK_TIMEOUT_MS),
				// Once a remote proxy acks, extend the deadline to allow the query to run.
				onAck: () => {
					clearTimeout(entry.timer);
					entry.timer = setTimeout(() => {
						this.pending.delete(id);
						reject(new Error(`DS_QUERY for '${dataSourceId}' timed out after ack (${RESULT_TIMEOUT_MS}ms)`));
					}, RESULT_TIMEOUT_MS);
				},
			};
			this.pending.set(id, entry);

			try {
				this.ws!.send(JSON.stringify({
					id,
					type: 'DS_QUERY',
					from: { type: 'runtime', id },
					payload: { dataSourceId, sql, params },
				}));
			} catch (err) {
				clearTimeout(entry.timer);
				this.pending.delete(id);
				reject(err as Error);
			}
		});

		const data: any[] = payload?.data ?? [];
		return { data, count: payload?.count ?? data.length };
	}

	async close(): Promise<void> {
		this.closedExplicitly = true;
		this.stopPing();
		if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
		this.rejectAllPending(new Error('[ProxyConn] client closed'));
		if (this.ws) {
			try { this.ws.send(JSON.stringify({ type: 'UNREGISTER_PROXY', from: { type: 'runtime' }, payload: {} })); } catch { /* ignore */ }
			try { this.ws.close(); } catch { /* ignore */ }
			this.ws = null;
		}
	}

	// ----------------------------------------------------------------
	// Socket lifecycle
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
			// worker validates + marks authenticated, so REGISTER_PROXY/DS_QUERY are
			// allowed. 'runtime' (a browser type) now demands a session JWT under
			// WS_AUTH_ENFORCE and would be rejected 401.
			const params = new URLSearchParams({ projectId: this.opts.projectId, type: 'data-agent' });
			if (this.opts.apiKey) params.set('apiKey', this.opts.apiKey);
			const url = `${this.opts.wsUrl}?${params}`;

			const ws = new WebSocket(url);
			this.ws = ws;

			const onOpen = () => {
				console.log(`[ProxyConn] Connected to ${this.opts.wsUrl} (projectId=${this.opts.projectId})`);
				ws.off('error', onErrorBeforeOpen);
				this.startPing();
				this.register();
				resolve();
			};
			const onErrorBeforeOpen = (err: Error) => { ws.off('open', onOpen); reject(err); };

			ws.once('open', onOpen);
			ws.once('error', onErrorBeforeOpen);
			ws.on('message', (raw) => this.handleMessage(raw));
			ws.on('close', (code, reason) => this.handleClose(code, reason?.toString()));
			ws.on('error', (err) => console.warn('[ProxyConn] WebSocket error:', (err as Error).message));
		});
	}

	private async handleMessage(raw: WebSocket.RawData): Promise<void> {
		let msg: any;
		try { msg = JSON.parse(raw.toString()); } catch { return; }

		// (1) A reply to one of our own DS_QUERY requests?
		if (msg.id && this.pending.has(msg.id)) {
			const p = this.pending.get(msg.id)!;
			if (msg.type === 'DS_ACK') { p.onAck(); return; } // keep waiting for DS_RESULT
			clearTimeout(p.timer);
			this.pending.delete(msg.id);
			if (msg.type === 'DS_ERROR') {
				const code = msg.payload?.code;
				p.reject(UNAVAILABLE_CODES.has(code)
					? new SourceUnavailableError(p.dataSourceId, msg.payload?.error)
					: new Error(msg.payload?.error || 'DS_ERROR'));
			} else {
				p.resolve(msg.payload); // DS_RESULT
			}
			return;
		}

		// (2) A DS_QUERY the DO forwarded to us — answer as a responder.
		if (msg.type === 'DS_QUERY') {
			await this.handleDsQuery(msg);
			return;
		}
		// Everything else (connected, PONG, PROXY_REGISTERED, strays) is ignored.
	}

	/**
	 * Responder: serve a forwarded DS_QUERY from the local Data Source Manager.
	 * No re-resolution here, so a query can never loop back out to the DO.
	 */
	private async handleDsQuery(msg: any): Promise<void> {
		const replyTo = msg.from?.id;
		const dataSourceId = msg.payload?.dataSourceId;

		const sendErr = (error: string, code: string) => {
			if (!replyTo || this.ws?.readyState !== WebSocket.OPEN) return;
			this.ws.send(JSON.stringify({ id: msg.id, type: 'DS_ERROR', from: { type: 'runtime' }, to: { id: replyTo }, payload: { error, code } }));
		};
		const sendOpen = (m: any) => { if (replyTo && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); };

		if (!dataSourceId) return sendErr('DS_QUERY missing dataSourceId', 'BAD_REQUEST');

		const mgr = getSourceManager();
		const instance = mgr?.getInstance(dataSourceId);
		if (!instance) return sendErr(`Data source '${dataSourceId}' not found on this proxy`, 'NOT_FOUND');
		if (!instance.isConnected()) return sendErr(`Data source '${dataSourceId}' is not connected`, 'NOT_CONNECTED');

		// Exists and connected — acknowledge immediately, then query.
		sendOpen({ id: msg.id, type: 'DS_ACK', from: { type: 'runtime' }, to: { id: replyTo }, payload: {} });

		try {
			// The asking user is on another machine and their identity does not
			// cross the DS_QUERY wire today. Trusted-by-declaration for now; if
			// policies ever matter here, the identity has to be carried in the
			// message, not assumed. See REQUEST-CONTEXT-DESIGN.md.
			const result = await runAsSystem('cross-machine-proxy', () =>
				instance.execute({ sql: msg.payload?.sql, params: msg.payload?.params }));
			const data = result?.data ?? [];
			sendOpen({
				id: msg.id, type: 'DS_RESULT', from: { type: 'runtime' }, to: { id: replyTo },
				payload: { data, count: result?.count ?? data.length },
			});
		} catch (err) {
			sendErr((err as Error).message, 'QUERY_FAILED');
		}
	}

	private handleClose(code: number, reason?: string): void {
		console.warn(`[ProxyConn] Disconnected (code=${code}, reason=${reason || 'none'})`);
		this.stopPing();
		this.ws = null;
		this.rejectAllPending(new Error(`[ProxyConn] WebSocket closed (code=${code})`));
		if (!this.closedExplicitly) this.scheduleReconnect();
	}

	private rejectAllPending(err: Error): void {
		for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
		this.pending.clear();
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.openSocket().catch(err => {
				console.warn('[ProxyConn] Reconnect failed:', (err as Error).message);
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
		if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
	}
}

// ============================================================
// Module singleton + bootstrap (wired from sa.ts)
// ============================================================

let client: SourceProxyClient | null = null;

/** Stable per-deployment proxyId: SA_PROXY_ID env, else a generated UUID persisted to disk. */
function resolveProxyId(): string {
	if (process.env.SA_PROXY_ID) return process.env.SA_PROXY_ID;
	const file = process.env.SA_PROXY_ID_FILE || path.join(process.cwd(), '.proxy-id');
	try {
		if (fs.existsSync(file)) {
			const existing = fs.readFileSync(file, 'utf8').trim();
			if (existing) return existing;
		}
		const generated = randomUUID();
		fs.writeFileSync(file, generated, 'utf8');
		return generated;
	} catch {
		// If disk is read-only, fall back to an ephemeral id (re-registers on restart).
		return randomUUID();
	}
}

/**
 * Start the Proxy Connection System. No-op (returns null) when disabled. Safe to
 * call after sources + the script bridge are up.
 */
export async function startSourceProxy(projectId: string): Promise<SourceProxyClient | null> {
	if (process.env.SA_PROXY_ENABLED === 'false') {
		console.log('ℹ Proxy connection disabled (SA_PROXY_ENABLED=false)\n');
		return null;
	}
	const wsUrl = process.env.SA_WEBSOCKET_URL || 'wss://ws.superatom.ai/websocket';
	const proxyId = resolveProxyId();

	client = new SourceProxyClient({
		wsUrl,
		projectId,
		proxyId,
		// The project API key the DO validates — the same key the SDK uses.
		apiKey: process.env.SUPERATOM_API_KEY,
	});

	try {
		await client.start();
		console.log(`✓ Proxy connection established (proxyId=${proxyId})\n`);
	} catch (err) {
		// Don't fail startup if the DO is unreachable — local sources still work;
		// remote routing simply won't be available.
		console.warn('⚠ Proxy connection could not be established (remote sources unavailable):', (err as Error).message);
	}
	return client;
}

/** The live proxy connection, or null if disabled/not started. Used by the script bridge. */
export function getSourceProxy(): SourceProxyClient | null {
	return client;
}

/** Re-announce owned data sources (call when the connected-source set changes). */
export function reregisterSourceProxy(): void {
	client?.register();
}
