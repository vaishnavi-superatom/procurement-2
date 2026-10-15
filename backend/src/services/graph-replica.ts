import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { SuperatomSDK } from '@superatomai/sdk-node';
import { applyGraphRelease, type ReplicaItem } from '../../../database/postgres/src/project-data-db/graph-replica';

/**
 * GRAPH REPLICATION — keep this engine's copy of the platform's semantic graph.
 *
 * Off unless SA_GRAPH_REPLICATION=on; with it off, nothing here runs and the
 * engine's graph is edited locally exactly as before.
 *
 * Over the relay (platform_ui/docs/SEMANTIC-GRAPH-VERSIONING.md §3.5–3.6):
 *   engine → DO   GRAPH_HELLO   { engineId, haveReleaseId, haveSeq, haveRootHash, haveEventSeq }
 *   DO → engine   GRAPH_IN_SYNC | GRAPH_NONE | GRAPH_SNAPSHOT (in parts)
 *   engine → DO   GRAPH_ACK { releaseId, seq, rootHash, eventSeq } | GRAPH_NACK { …, error }
 *   DO → engine   GRAPH_RELEASE { releaseId, seq, rootHash, eventSeq } when one is published
 *
 * Hello is sent on every (re)connect, on GRAPH_RELEASE, and on a timer, so a
 * missed push only delays an update. A snapshot is verified (every hash, the
 * root hash, no loops) before it replaces the local copy; a bad one is refused
 * with a NACK and the engine keeps the release it has.
 */

// This engine's id and the graph release it last applied.
const STATE_FILE = process.env.SA_ENGINE_STATE_FILE || path.join(process.cwd(), '.engine-state.json');
const RECHECK_MS = Number(process.env.SA_GRAPH_RECHECK_MS) || 5 * 60 * 1000;
/** Parts of a snapshot that never complete are dropped after this. */
const ASSEMBLY_TIMEOUT_MS = 2 * 60 * 1000;

export function graphReplicationEnabled(): boolean {
	return process.env.SA_GRAPH_REPLICATION === 'on';
}

interface ReplicaState {
	engineId: string;
	releaseId: number | null;
	seq: number | null;
	rootHash: string | null;
	eventSeq: number | null;
	appliedAt?: string;
}

interface ReleaseHead {
	releaseId: number;
	seq: number;
	rootHash: string;
	eventSeq: number;
}

// ── Hashing: must match sa-api's lib/graph/hash.ts exactly ──────────────────

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object' && !(value instanceof Date)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (v !== undefined) out[key] = sortKeys(v);
		}
		return out;
	}
	return value;
}
const canonicalJson = (v: unknown) => JSON.stringify(sortKeys(v));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Checks a complete snapshot before it is applied: the root hash over the item
 * list, every concept's hash, every node's hash over its content and its
 * children's hashes (so the whole tree is verified), and no node → node loops.
 * Returns the problem, or null when it is sound.
 */
function verifySnapshot(head: ReleaseHead, items: ReplicaItem[]): string | null {
	const list = items
		.map(({ entity, id, rev, hash }) => ({ entity, id, rev, hash }))
		.sort((a, b) => a.entity.localeCompare(b.entity) || a.id - b.id);
	if (sha256(canonicalJson(list)) !== head.rootHash) return 'root hash does not match the items received';

	const hashOf = new Map(items.map((i) => [`${i.entity}:${i.id}`, i.hash]));
	for (const item of items) {
		if (item.entity === 'concept') {
			if (sha256(canonicalJson(item.content)) !== item.hash) return `concept ${item.id}: content does not match its hash`;
			continue;
		}
		const edges = (item.content?.edges ?? []) as Array<{ nodeId: number | null; conceptId: number | null }>;
		const children: string[] = [];
		for (const e of edges) {
			const key = e.nodeId != null ? `node:${e.nodeId}` : `concept:${e.conceptId}`;
			const h = hashOf.get(key);
			if (!h) return `node ${item.id} links to ${key}, which is not in the release`;
			children.push(e.nodeId != null ? `n${e.nodeId}:${h}` : `c${e.conceptId}:${h}`);
		}
		children.sort();
		if (sha256(`${canonicalJson(item.content)}\n${children.join('\n')}`) !== item.hash) {
			return `node ${item.id}: content does not match its hash`;
		}
	}

	// No loops among node → node links.
	const links = new Map<number, number[]>();
	for (const item of items) {
		if (item.entity !== 'node') continue;
		links.set(item.id, ((item.content?.edges ?? []) as Array<{ nodeId: number | null }>).flatMap((e) => (e.nodeId != null ? [e.nodeId] : [])));
	}
	const state = new Map<number, 1 | 2>();
	const visit = (id: number): boolean => {
		const s = state.get(id);
		if (s === 2) return false;
		if (s === 1) return true;
		state.set(id, 1);
		for (const child of links.get(id) ?? []) if (visit(child)) return true;
		state.set(id, 2);
		return false;
	};
	for (const id of links.keys()) if (visit(id)) return `the release has a loop through node ${id}`;
	return null;
}

/**
 * A database error in one line. Drizzle's own message carries the whole failed
 * query with every value (every concept's text, for a release), so the cause
 * Postgres gave is used instead: e.g. `null value in column "type" of relation
 * "concepts" violates not-null constraint`.
 */
function shortError(err: unknown): string {
	const cause = (err as { cause?: { message?: string } })?.cause;
	const text = cause?.message ?? (err as Error)?.message ?? String(err);
	const line = text.split('\n')[0].replace(/^Failed query:.*$/, 'database error');
	return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

// ── State file ──────────────────────────────────────────────────────────────

function loadState(): ReplicaState {
	try {
		if (fs.existsSync(STATE_FILE)) {
			const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
			if (s && typeof s.engineId === 'string' && s.engineId) return s;
		}
	} catch (err) {
		console.warn('[graph-replica] could not read state file, starting fresh:', (err as Error).message);
	}
	return { engineId: randomUUID(), releaseId: null, seq: null, rootHash: null, eventSeq: null };
}

function saveState(s: ReplicaState): void {
	try {
		fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
	} catch (err) {
		// Read-only disk: the engine still works, it just asks for a snapshot after a restart.
		console.warn('[graph-replica] could not write state file:', (err as Error).message);
	}
}

// ── Client ──────────────────────────────────────────────────────────────────

const isHead = (p: any): p is ReleaseHead =>
	!!p && Number.isInteger(p.releaseId) && Number.isInteger(p.seq) && Number.isInteger(p.eventSeq) && typeof p.rootHash === 'string';

class GraphReplica {
	private state = loadState();
	/** Snapshot parts being collected, keyed by release + event. */
	private assembling = new Map<string, { head: ReleaseHead; totalParts: number; parts: Map<number, ReplicaItem[]>; startedAt: number }>();
	/** Applies run one at a time. */
	private queue: Promise<void> = Promise.resolve();
	/** "Nothing published yet" has been logged. */
	private reportedNone = false;
	/**
	 * The platform has a published graph that this engine follows. Until it does,
	 * the engine's own graph is the only one, so local edits stay allowed. Starts
	 * from the release last applied; GRAPH_NONE clears it, an applied release sets it.
	 */
	platformHasGraph = this.state.releaseId !== null;

	constructor(private sdk: SuperatomSDK) {
		saveState(this.state); // persist a newly generated engineId straight away
	}

	start(): void {
		// The relay's welcome arrives on every (re)connect.
		this.sdk.onMessageType('connected', () => this.hello('connect'));
		this.sdk.onMessageType('GRAPH_RELEASE', (m: any) => {
			if (m?.payload?.eventSeq !== this.state.eventSeq) this.hello('release');
		});
		this.sdk.onMessageType('GRAPH_IN_SYNC', (m: any) => this.onInSync(m?.payload));
		this.sdk.onMessageType('GRAPH_NONE', () => {
			this.platformHasGraph = false;
			// Said once, not on every check.
			if (this.reportedNone) return;
			this.reportedNone = true;
			console.log('[graph-replica] nothing published for this project yet');
		});
		this.sdk.onMessageType('GRAPH_SNAPSHOT', (m: any) => this.onSnapshotPart(m?.payload));
		setInterval(() => this.hello('recheck'), RECHECK_MS).unref();

		console.log(`[graph-replica] engine ${this.state.engineId} on release ${this.state.seq ?? 'none'}`);
		// The welcome for the current connection may already have arrived.
		if (this.sdk.isConnected()) this.hello('start');
	}

	private hello(reason: string): void {
		// Never queued: the SDK would replay every hello missed while offline at
		// once on reconnect, and the reconnect sends its own hello anyway.
		if (!this.sdk.isConnected()) return;
		this.sdk.send({
			id: `graph_hello_${randomUUID()}`,
			type: 'GRAPH_HELLO',
			from: { type: 'data-agent' },
			payload: {
				engineId: this.state.engineId,
				haveReleaseId: this.state.releaseId,
				haveSeq: this.state.seq,
				haveRootHash: this.state.rootHash,
				haveEventSeq: this.state.eventSeq,
				reason,
				protoVer: 1,
			},
		} as any);
	}

	/** Same content as the current release (e.g. after a rollback to it): just record the new head. */
	private onInSync(p: unknown): void {
		if (!isHead(p) || p.rootHash !== this.state.rootHash) return;
		this.platformHasGraph = true;
		if (p.eventSeq !== this.state.eventSeq || p.releaseId !== this.state.releaseId) {
			this.state = { ...this.state, releaseId: p.releaseId, seq: p.seq, eventSeq: p.eventSeq };
			saveState(this.state);
		}
	}

	private onSnapshotPart(raw: any): void {
		// Read through `p`: the isHead() guard would narrow `raw` to a bare head without the part fields.
		const p = raw as ReleaseHead & { part: number; totalParts: number; items: unknown };
		if (!isHead(raw) || !Number.isInteger(p.part) || !Number.isInteger(p.totalParts) || !Array.isArray(p.items)) {
			console.warn('[graph-replica] ignoring a malformed GRAPH_SNAPSHOT part');
			return;
		}
		const now = Date.now();
		for (const [k, a] of this.assembling) if (now - a.startedAt > ASSEMBLY_TIMEOUT_MS) this.assembling.delete(k);

		const key = `${p.releaseId}:${p.eventSeq}`;
		let a = this.assembling.get(key);
		if (!a) {
			a = { head: { releaseId: p.releaseId, seq: p.seq, rootHash: p.rootHash, eventSeq: p.eventSeq }, totalParts: p.totalParts, parts: new Map(), startedAt: now };
			this.assembling.set(key, a);
		}
		a.parts.set(p.part, p.items as ReplicaItem[]);
		if (a.parts.size < a.totalParts) return;

		this.assembling.delete(key);
		const items = [...a.parts.entries()].sort(([x], [y]) => x - y).flatMap(([, list]) => list);
		const head = a.head;
		this.queue = this.queue.then(() => this.apply(head, items)).catch(() => {});
	}

	private async apply(head: ReleaseHead, items: ReplicaItem[]): Promise<void> {
		// An older event than the one applied is stale (a newer push already won).
		if (this.state.eventSeq !== null && head.eventSeq < this.state.eventSeq) return;
		// Same content already applied: just record the new head and confirm it.
		if (head.rootHash === this.state.rootHash) {
			this.state = { ...this.state, ...head };
			saveState(this.state);
			this.platformHasGraph = true;
			return this.ack(head);
		}

		const problem = verifySnapshot(head, items);
		if (problem) {
			console.error(`[graph-replica] refused release ${head.seq}: ${problem}`);
			return this.nack(head, problem);
		}
		try {
			const counts = await applyGraphRelease(items);
			this.state = { ...this.state, ...head, appliedAt: new Date().toISOString() };
			saveState(this.state);
			this.platformHasGraph = true;
			console.log(`[graph-replica] applied release ${head.seq} (${counts.nodes} nodes, ${counts.concepts} concepts)`);
			this.ack(head);
		} catch (err) {
			const message = shortError(err);
			console.error(`[graph-replica] could not apply release ${head.seq}: ${message}`);
			this.nack(head, message);
		}
	}

	private ack(head: ReleaseHead): void {
		this.sdk.send({
			id: `graph_ack_${randomUUID()}`,
			type: 'GRAPH_ACK',
			from: { type: 'data-agent' },
			payload: { engineId: this.state.engineId, ...head },
		} as any);
	}

	private nack(head: ReleaseHead, error: string): void {
		this.sdk.send({
			id: `graph_nack_${randomUUID()}`,
			type: 'GRAPH_NACK',
			from: { type: 'data-agent' },
			payload: { engineId: this.state.engineId, ...head, error: error.slice(0, 2000) },
		} as any);
	}
}

let replica: GraphReplica | null = null;

/**
 * Local graph edits are refused only while the engine follows a platform
 * release: replication on AND the platform has a published graph. With nothing
 * published, the engine's own graph is the only one and stays editable; the
 * platform's first release then replaces it.
 */
export function graphManagedByPlatform(): boolean {
	return graphReplicationEnabled() && !!replica?.platformHasGraph;
}

/** Starts replication when SA_GRAPH_REPLICATION=on; a no-op otherwise. Call after sdk.connect(). */
export function startGraphReplica(sdk: SuperatomSDK): void {
	if (!graphReplicationEnabled() || replica) return;
	replica = new GraphReplica(sdk);
	replica.start();
}
