import { db, schema } from './drizzle-db';
import { getAllConcepts, type ConceptRecord } from './concepts';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'crypto';

const { graphNodes, graphDomainMembers, graphDomainTerms, graphRoutes } = schema;

/**
 * COMPOSITION GRAPH — reading the published graph, and recording what it decided.
 *
 * Storage and search only. Composition itself lives in the backend, because it
 * writes a workspace; this file answers "what is published" and "what did we
 * route".
 */

export type NodeKind = 'domain' | 'part' | 'file' | 'setting' | 'program';
/** `domain`: a link to another domain, whose concepts and instructions this one builds on. */
export type MemberRole = 'prompt' | 'concept' | 'file' | 'setting' | 'program' | 'domain';

export interface GraphNode {
	id: number;
	kind: NodeKind;
	name: string;
	title: string | null;
	body: string;
	meta: Record<string, any>;
	hash: string;
}

/** A node's identity is its content: same content, same hash, no recomposition. */
export function nodeHash(kind: string, name: string, body: string, meta: unknown): string {
	return createHash('sha256')
		.update(`${kind}\u0000${name.toLowerCase()}\u0000${body}\u0000${JSON.stringify(meta ?? {})}`)
		.digest('hex');
}

/**
 * The domain's hash covers its MEMBERS in order, not just its own body: editing
 * a part five domains share must re-place all five workspaces, and nothing else.
 */
export function domainHash(domain: GraphNode, members: DomainMember[]): string {
	const h = createHash('sha256').update(domain.hash);
	for (const m of [...members].sort((a, b) => a.role.localeCompare(b.role) || a.position - b.position)) {
		// A concept has no hash column of its own, so its rendered identity is
		// hashed here: a definition edit must re-place every domain that names it.
		const id = m.node ? m.node.hash
			: nodeHash('concept', m.concept!.name, m.concept!.body, { aliases: m.concept!.aliases ?? [], requires: m.concept!.requires ?? [] });
		h.update(`\u0000${m.role}:${m.position}:${id}`);
	}
	return h.digest('hex');
}

/**
 * A member is either a graph node (a part, a file, a setting, a program) or a
 * concept resolved out of the concept store. `concept` members carry no body of
 * their own in the graph — the store is the single source of truth.
 */
export interface DomainMember {
	role: MemberRole;
	position: number;
	node?: GraphNode;
	concept?: ConceptRecord;
	/** Set when a named concept resolved to nothing: an authoring error, surfaced not swallowed. */
	missingConcept?: string;
}

export interface ComposedDomain {
	domain: GraphNode;
	hash: string;
	members: DomainMember[];
	/** Concept names the domain asks for that the store does not have. */
	missing: string[];
}

/**
 * Exact name/alias lookup over the concept store. Deliberately NOT the fuzzy
 * repair `resolveConcepts` does for the agent: a typo corrected at RUNTIME is
 * visible in the transcript, while one corrected at COMPOSE time is silent and
 * permanent. Measured on the first authored graph, fuzzy turned "vehicle type"
 * into "vendor list by route" in four domains.
 */
async function conceptIndex(): Promise<Map<string, ConceptRecord>> {
	const byKey = new Map<string, ConceptRecord>();
	const all = (await getAllConcepts({ verifiedOnly: true })).data as ConceptRecord[];
	for (const c of all) {
		byKey.set(conceptKey(c.name), c);
		for (const a of c.aliases ?? []) if (a) byKey.set(conceptKey(a), c);
	}
	return byKey;
}

const conceptKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * How many domain → domain links deep a composition follows. The platform
 * refuses loops when a link is saved and at publish; this is the guard that
 * still holds if one slips through.
 */
const MAX_DOMAIN_DEPTH = 8;

/**
 * Everything one domain is made of, published only, in composition order —
 * including what it builds on: a `domain` link adds that domain's concepts and
 * instructions after this domain's own (and, through ITS links, theirs).
 * Anything already included is skipped, so shared concepts appear once.
 */
export async function getPublishedDomain(name: string): Promise<ComposedDomain | null> {
	return composeWithLinks(name, new Set(), 0);
}

async function composeWithLinks(name: string, path: Set<string>, depth: number): Promise<ComposedDomain | null> {
	const own = await readPublishedDomain(name);
	if (!own) return null;

	const links = own.members.filter(m => m.role === 'domain' && m.node).sort((a, b) => a.position - b.position);
	const members = own.members.filter(m => m.role !== 'domain');
	const missing = [...own.missing];

	if (links.length && depth < MAX_DOMAIN_DEPTH) {
		const key = name.trim().toLowerCase();
		path.add(key);
		const seenConcepts = new Set(members.filter(m => m.concept).map(m => conceptKey(m.concept!.name)));
		const seenNodes = new Set(members.filter(m => m.node).map(m => m.node!.id));
		// Linked members go after this domain's own, in link order.
		const nextPosition = (role: MemberRole) => Math.max(0, ...members.filter(m => m.role === role).map(m => m.position)) + 1;

		for (const link of links) {
			const childKey = link.node!.name.trim().toLowerCase();
			if (path.has(childKey)) continue; // a loop back up the chain
			const child = await composeWithLinks(link.node!.name, path, depth + 1);
			if (!child) continue; // not published: nothing to add
			for (const m of child.members) {
				if (m.role === 'concept') {
					if (!m.concept || seenConcepts.has(conceptKey(m.concept.name))) continue;
					seenConcepts.add(conceptKey(m.concept.name));
				} else {
					if (!m.node || seenNodes.has(m.node.id)) continue;
					seenNodes.add(m.node.id);
				}
				members.push({ ...m, position: nextPosition(m.role) });
			}
			for (const n of child.missing) if (!missing.includes(n)) missing.push(n);
		}
		path.delete(key);
	}

	// The hash covers what was pulled in, so editing a linked domain re-places
	// every workspace that builds on it.
	return { domain: own.domain, hash: domainHash(own.domain, members), members, missing };
}

/** One domain's own members (domain links included, not yet followed). */
async function readPublishedDomain(name: string): Promise<{ domain: GraphNode; members: DomainMember[]; missing: string[] } | null> {
	const rows: any = await db.execute(sql`
		SELECT d.id, d.kind, d.name, d.title, d.body, d.meta, d.hash,
		       m.role, m.position, m.concept_name AS "conceptName",
		       n.id AS n_id, n.kind AS n_kind, n.name AS n_name, n.title AS n_title,
		       n.body AS n_body, n.meta AS n_meta, n.hash AS n_hash
		FROM graph_nodes d
		LEFT JOIN graph_domain_members m ON m.domain_id = d.id
		LEFT JOIN graph_nodes n ON n.id = m.node_id AND n.status = 'published'
		WHERE d.kind = 'domain' AND lower(d.name) = ${name.trim().toLowerCase()}
		  AND d.status = 'published'
		ORDER BY m.role, m.position
	`);
	const rs = rows.rows as any[];
	if (!rs.length) return null;

	const r0 = rs[0];
	const domain: GraphNode = { id: r0.id, kind: 'domain', name: r0.name, title: r0.title, body: r0.body, meta: r0.meta ?? {}, hash: r0.hash };

	// Only touch the concept store when this domain actually names concepts.
	const wantsConcepts = rs.some(r => r.role === 'concept' && r.conceptName);
	const concepts = wantsConcepts ? await conceptIndex() : new Map<string, ConceptRecord>();

	const members: DomainMember[] = [];
	const missing: string[] = [];
	for (const r of rs) {
		if (r.role === 'concept' && r.conceptName) {
			const c = concepts.get(conceptKey(r.conceptName));
			// A named concept that no longer exists is an authoring error. It is
			// reported and skipped, never quietly replaced with something close.
			if (!c) { missing.push(r.conceptName); members.push({ role: 'concept', position: r.position, missingConcept: r.conceptName }); continue; }
			members.push({ role: 'concept', position: r.position, concept: c });
			continue;
		}
		// A member whose node is a draft is simply absent — published composes from
		// published, and the viewer is where an unpublished edit is visible.
		if (!r.n_id) continue;
		members.push({
			role: r.role as MemberRole,
			position: r.position as number,
			node: { id: r.n_id, kind: r.n_kind, name: r.n_name, title: r.n_title, body: r.n_body, meta: r.n_meta ?? {}, hash: r.n_hash } as GraphNode,
		});
	}
	return { domain, members, missing };
}

/**
 * Every published domain's terms, for the router's index. `priority` breaks a
 * tie the scores cannot: authored, so the outcome is reviewable instead of
 * depending on the order Postgres happened to return rows in.
 */
export async function getDomainTerms(): Promise<Array<{
	domainId: number; domainName: string; term: string; weight: number; priority: number;
}>> {
	const res: any = await db.execute(sql`
		SELECT t.domain_id AS "domainId", d.name AS "domainName", t.term, t.weight,
		       COALESCE((d.meta->>'priority')::int, 0) AS priority
		FROM graph_domain_terms t
		JOIN graph_nodes d ON d.id = t.domain_id AND d.kind = 'domain' AND d.status = 'published'
		ORDER BY d.name, t.term
	`);
	return res.rows as any[];
}

/** Written BEFORE the run, so a misroute is visible even when the run fails. */
export async function recordRoute(row: {
	question: string; domainId?: number | null; domainHash?: string | null;
	score?: number | null; runnerUpId?: number | null; runnerUpScore?: number | null;
	matchedTerms?: unknown; decidedBy: 'index' | 'llm' | 'tie' | 'sticky' | 'fallback';
	threadId?: string | null; userId?: string | null;
}): Promise<number | null> {
	const rows: any[] = await db.insert(graphRoutes).values({
		question: row.question,
		domainId: row.domainId ?? null,
		domainHash: row.domainHash ?? null,
		score: row.score ?? null,
		runnerUpId: row.runnerUpId ?? null,
		runnerUpScore: row.runnerUpScore ?? null,
		matchedTerms: (row.matchedTerms ?? []) as any,
		decidedBy: row.decidedBy,
		threadId: row.threadId ?? null,
		userId: row.userId ?? null,
	} as any).returning({ id: graphRoutes.id });
	return rows[0]?.id ?? null;
}

/** What one answer needed that its routed domain lacked; read by the gap report. */
export async function saveRouteGaps(routeId: number, gaps: unknown): Promise<void> {
	await db.update(graphRoutes).set({ gaps: gaps as any }).where(eq(graphRoutes.id, routeId));
}

/** Each published domain's concept names, lowercased: which domain already carries a concept. */
export async function publishedDomainConcepts(): Promise<Array<{ domain: string; concepts: string[] }>> {
	const res: any = await db.execute(sql`
		SELECT d.name AS domain, COALESCE(array_agg(lower(m.concept_name)) FILTER (WHERE m.concept_name IS NOT NULL), '{}') AS concepts
		FROM graph_nodes d LEFT JOIN graph_domain_members m ON m.domain_id = d.id
		WHERE d.kind = 'domain' AND d.status = 'published'
		GROUP BY d.name
	`);
	return res.rows as Array<{ domain: string; concepts: string[] }>;
}

/** Questions that found no domain — the gap list the team authors against. */
export async function routeGaps(sinceDays = 7, limit = 50) {
	const res: any = await db.execute(sql`
		SELECT question, count(*)::int AS asked, max(created_at) AS last_asked
		FROM graph_routes
		WHERE decided_by = 'fallback' AND created_at > now() - (${sinceDays} || ' days')::interval
		GROUP BY question ORDER BY asked DESC, last_asked DESC LIMIT ${limit}
	`);
	return res.rows as Array<{ question: string; asked: number; last_asked: string }>;
}

/** One domain as the viewer shows it: authored membership, not a composition. */
export interface DomainView {
	id: number;
	name: string;
	title: string | null;
	body: string;
	meta: Record<string, any>;
	status: string;
	origin: string | null;
	updatedAt: string | null;
	members: Array<{
		role: MemberRole;
		position: number;
		/** Concept members: the authored name, and what it resolves to in the store. */
		conceptName: string | null;
		concept: { name: string; kind: string; description: string | null; body?: string } | null;
		missing: boolean;
		/** Node members (prompt / file / setting / program parts). */
		node: { id: number; kind: string; name: string; title: string | null; body?: string } | null;
	}>;
	terms: Array<{ term: string; weight: number }>;
}

/**
 * Every domain with its members and terms, for the viewer. Unlike
 * getPublishedDomain this shows drafts too (retired only on request), and
 * reports concepts that don't resolve instead of dropping them. Bodies are
 * left out unless asked for — the list view doesn't need them.
 */
export async function listDomainViews(opts: { name?: string; includeRetired?: boolean; withBodies?: boolean } = {}): Promise<DomainView[]> {
	const name = opts.name?.trim().toLowerCase() ?? null;
	const res: any = await db.execute(sql`
		SELECT d.id, d.name, d.title, d.body, d.meta, d.status, d.origin, d.updated_at AS "updatedAt",
		       COALESCE((
		         SELECT json_agg(json_build_object(
		           'role', m.role, 'position', m.position, 'conceptName', m.concept_name,
		           'nodeId', n.id, 'nodeKind', n.kind, 'nodeName', n.name, 'nodeTitle', n.title, 'nodeBody', n.body
		         ) ORDER BY m.role, m.position)
		         FROM graph_domain_members m LEFT JOIN graph_nodes n ON n.id = m.node_id
		         WHERE m.domain_id = d.id
		       ), '[]'::json) AS members,
		       COALESCE((
		         SELECT json_agg(json_build_object('term', t.term, 'weight', t.weight) ORDER BY t.weight DESC, t.term)
		         FROM graph_domain_terms t WHERE t.domain_id = d.id
		       ), '[]'::json) AS terms
		FROM graph_nodes d
		WHERE d.kind = 'domain'
		  ${name ? sql`AND lower(d.name) = ${name}` : sql``}
		  ${opts.includeRetired ? sql`` : sql`AND d.status <> 'retired'`}
		ORDER BY d.name
	`);
	const rows = res.rows as any[];
	const concepts = rows.some(r => (r.members ?? []).some((m: any) => m.conceptName)) ? await conceptIndex() : new Map<string, ConceptRecord>();

	return rows.map(r => ({
		id: r.id, name: r.name, title: r.title, body: r.body, meta: r.meta ?? {},
		status: r.status, origin: r.origin, updatedAt: r.updatedAt,
		terms: r.terms ?? [],
		members: (r.members ?? []).map((m: any) => {
			const c = m.conceptName ? concepts.get(conceptKey(m.conceptName)) : undefined;
			return {
				role: m.role, position: m.position, conceptName: m.conceptName ?? null,
				concept: c ? { name: c.name, kind: c.kind, description: c.description, ...(opts.withBodies ? { body: c.body } : {}) } : null,
				missing: !!m.conceptName && !c,
				node: m.nodeName ? { id: m.nodeId, kind: m.nodeKind, name: m.nodeName, title: m.nodeTitle, ...(opts.withBodies ? { body: m.nodeBody } : {}) } : null,
			};
		}),
	}));
}

/** One node by kind and name, whatever its status. */
export async function getNode(kind: NodeKind, name: string): Promise<(GraphNode & { status: string }) | null> {
	const rows = await db.select().from(graphNodes)
		.where(and(eq(graphNodes.kind, kind), sql`lower(${graphNodes.name}) = ${name.trim().toLowerCase()}`)).limit(1);
	return (rows[0] as any) ?? null;
}

export async function setDomainStatus(domainId: number, status: 'draft' | 'published' | 'retired'): Promise<void> {
	await db.update(graphNodes).set({ status, updatedAt: sql`CURRENT_TIMESTAMP` as any }).where(eq(graphNodes.id, domainId));
}

/**
 * Hard delete: the domain, its members and its terms. Route audit rows keep
 * their domain_id but it no longer resolves — retire instead when the history
 * should stay readable.
 */
export async function deleteDomain(domainId: number): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(graphDomainMembers).where(eq(graphDomainMembers.domainId, domainId));
		await tx.delete(graphDomainTerms).where(eq(graphDomainTerms.domainId, domainId));
		await tx.delete(graphNodes).where(and(eq(graphNodes.id, domainId), eq(graphNodes.kind, 'domain')));
	});
}

/** Which of these names don't match a verified concept (name or alias) exactly. */
export async function unknownConceptNames(names: string[]): Promise<string[]> {
	const index = await conceptIndex();
	return names.filter(n => !index.has(conceptKey(n)));
}

/** Every routing decision in the window, newest first, with domain names resolved. */
export async function listRoutes(sinceDays = 7, limit = 500) {
	const res: any = await db.execute(sql`
		SELECT r.id, r.question, r.decided_by AS "decidedBy", r.score,
		       r.matched_terms AS "matchedTerms", r.runner_up_score AS "runnerUpScore",
		       r.thread_id AS "threadId", r.user_id AS "userId", r.created_at AS "createdAt",
		       d.name AS "domainName", d.title AS "domainTitle",
		       ru.name AS "runnerUpName", ru.title AS "runnerUpTitle"
		FROM graph_routes r
		LEFT JOIN graph_nodes d ON d.id = r.domain_id
		LEFT JOIN graph_nodes ru ON ru.id = r.runner_up_id
		WHERE r.created_at > now() - (${sinceDays} || ' days')::interval
		ORDER BY r.created_at DESC
		LIMIT ${limit}
	`);
	return res.rows as Array<{
		id: number; question: string; decidedBy: 'index' | 'llm' | 'sticky' | 'fallback';
		score: number | null; matchedTerms: Array<{ term: string; weight: number }>; runnerUpScore: number | null;
		threadId: string | null; userId: string | null; createdAt: string;
		domainName: string | null; domainTitle: string | null; runnerUpName: string | null; runnerUpTitle: string | null;
	}>;
}

/** Upsert used by the seeder and, later, by the authoring UI. */
export async function putNode(n: {
	kind: NodeKind; name: string; title?: string; body: string;
	meta?: Record<string, any>; status?: 'draft' | 'published'; origin?: string;
}): Promise<GraphNode> {
	const meta = n.meta ?? {};
	const hash = nodeHash(n.kind, n.name, n.body, meta);
	const existing = await db.select().from(graphNodes)
		.where(and(eq(graphNodes.kind, n.kind), sql`lower(${graphNodes.name}) = ${n.name.toLowerCase()}`)).limit(1);
	if (existing.length) {
		await db.update(graphNodes).set({
			title: n.title ?? null, body: n.body, meta: meta as any, hash,
			status: n.status ?? existing[0].status, origin: n.origin ?? existing[0].origin,
			updatedAt: sql`CURRENT_TIMESTAMP` as any,
		}).where(eq(graphNodes.id, existing[0].id));
		return { ...(existing[0] as any), ...n, meta, hash } as GraphNode;
	}
	const [row] = await db.insert(graphNodes).values({
		kind: n.kind, name: n.name, title: n.title ?? null, body: n.body,
		meta: meta as any, hash, status: n.status ?? 'draft', origin: n.origin ?? 'human',
	} as any).returning();
	return row as any as GraphNode;
}

/** Replace a domain's membership wholesale — the authored file is authoritative. */
export async function setDomainMembers(domainId: number, members: Array<{
	nodeId?: number; conceptName?: string; role: MemberRole; position: number;
}>): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(graphDomainMembers).where(eq(graphDomainMembers.domainId, domainId));
		if (members.length) {
			await tx.insert(graphDomainMembers).values(members.map(m => ({
				domainId, nodeId: m.nodeId ?? null, conceptName: m.conceptName ?? null,
				role: m.role, position: m.position,
			})) as any);
		}
	});
}

/**
 * Retire every published domain the authored file no longer contains. Retiring
 * rather than deleting keeps the route audit rows meaningful — they point at a
 * domain id that still exists and can be read.
 */
export async function retireDomainsExcept(keep: string[]): Promise<string[]> {
	const keepKeys = keep.map(n => n.trim().toLowerCase());
	const res: any = await db.execute(sql`
		UPDATE graph_nodes SET status = 'retired', updated_at = CURRENT_TIMESTAMP
		WHERE kind = 'domain' AND status = 'published'
		  AND lower(name) <> ALL(${sql.param(keepKeys)}::text[])
		RETURNING name
	`);
	return (res.rows as any[]).map(r => r.name);
}

export async function setDomainTerms(domainId: number, terms: Array<{ term: string; weight?: number }>): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(graphDomainTerms).where(eq(graphDomainTerms.domainId, domainId));
		if (terms.length) {
			await tx.insert(graphDomainTerms).values(terms.map(t => ({ domainId, term: t.term.toLowerCase(), weight: t.weight ?? 1 })) as any);
		}
	});
}

// ── Import ───────────────────────────────────────────────────────────────────

/** The export file, as the platform UI writes it. */
export interface GraphImportFile {
	/** Written by older exports only; not used. */
	version?: number;
	/** The project the file was exported from; ids are only trusted in that project. */
	projectId?: string;
	/** Every concept, once. Domains refer to them by name. */
	concepts: Array<{
		id?: number; name: string; kind?: string; description?: string | null; body: string;
		aliases?: string[]; requires?: string[]; returns?: Record<string, unknown>; sourceId?: string | null;
	}>;
	domains: Array<{
		id?: number;
		name: string;
		title?: string | null;
		body: string;
		status?: string;
		meta?: Record<string, any>;
		terms?: Array<{ term: string; weight?: number }>;
		/** Concept names, in order (position 1, 2, …). */
		concepts?: string[];
		parts?: Array<{ role: string; name: string; position: number }>;
	}>;
	/** Present only when the export included the shared instructions and fallback. */
	parts?: Array<{ id?: number; kind: string; name: string; title?: string | null; body: string }>;
}

type Tally = { created: number; updated: number; unchanged: number; removed: number; renamed: number };
export interface GraphImportResult {
	mode: 'merge' | 'replace';
	dryRun: boolean;
	/** Whether rows were matched by id first (same project) or by name only. */
	matchedByIds: boolean;
	concepts: Tally;
	domains: Tally;
	parts: Tally;
}

const ENGINE_OWNED = ['shared', 'generic'];
const ROLE_KIND: Record<string, NodeKind> = { prompt: 'part', file: 'file', setting: 'setting', program: 'program' };
const normName = (s: string) => s.trim().replace(/\s+/g, ' ');
const sameList = (a: unknown[] = [], b: unknown[] = []) => JSON.stringify(a) === JSON.stringify(b);
const blank = (): Tally => ({ created: 0, updated: 0, unchanged: 0, removed: 0, renamed: 0 });
class DryRunRollback extends Error {}

/**
 * Apply an exported graph in one transaction. Each concept, part and domain is
 * matched by id first, then by name, else created — so ids (and the route
 * history and pending revisions that point at them) stay. A row matched by id
 * whose name differs is renamed; renaming a concept also renames it in every
 * domain that uses it and every concept that requires it. Ids are only used
 * when `useIds` (the file came from this project): elsewhere an id could name
 * an unrelated row.
 *
 *   merge    create what's new, update what changed, leave the rest alone
 *   replace  also retire domains the file doesn't list (never shared/generic),
 *            and delete verified concepts the file doesn't list that no
 *            remaining domain uses. Unreviewed proposals are never touched.
 *
 * Concepts written here are verified (a person imported them). Parts are
 * applied only when the file carries them; otherwise they're left as they are.
 * `dryRun` does all of it and rolls back, so the counts are exactly what an
 * import would do.
 */
export async function importGraph(file: GraphImportFile, opts: { mode: 'merge' | 'replace'; dryRun: boolean; useIds: boolean }): Promise<GraphImportResult> {
	const result: GraphImportResult = {
		mode: opts.mode, dryRun: opts.dryRun, matchedByIds: opts.useIds, concepts: blank(), domains: blank(), parts: blank(),
	};
	const idOf = (id: unknown) => (opts.useIds && typeof id === 'number' && Number.isInteger(id) ? id : null);
	try {
		await db.transaction(async (tx) => {
			const rows = async (q: any) => ((await tx.execute(q)) as any).rows as any[];

			// 1. Concepts: the file's list, each once.
			const fileConcepts = new Map<string, GraphImportFile['concepts'][number]>();
			for (const c of file.concepts ?? []) if (!fileConcepts.has(conceptKey(c.name))) fileConcepts.set(conceptKey(c.name), c);

			for (const c of fileConcepts.values()) {
				const name = normName(c.name);
				const next = {
					body: c.body.trim(), kind: c.kind || 'definition', description: c.description?.trim() || null,
					aliases: (c.aliases ?? []).map(normName).filter(Boolean), requires: (c.requires ?? []).map(normName).filter(Boolean),
					returns: c.returns ?? {}, sourceId: c.sourceId ?? null,
				};
				// By id first (same project only), then by name.
				const cols = sql`id, name, body, kind, description, aliases, requires, returns, source_id AS "sourceId", verified`;
				const id = idOf(c.id);
				let [cur] = id !== null
					? await rows(sql`SELECT ${cols} FROM concepts WHERE id = ${id} AND supersedes IS NULL`)
					: [];
				if (!cur) {
					[cur] = await rows(sql`
						SELECT ${cols} FROM concepts WHERE lower(name) = ${name.toLowerCase()} AND supersedes IS NULL
						ORDER BY verified DESC, id LIMIT 1`);
				}
				// Matched by id under another name: rename it, and everything that refers to it by name.
				if (cur && conceptKey(cur.name) !== conceptKey(name)) {
					const [clash] = await rows(sql`
						SELECT id FROM concepts WHERE lower(name) = ${name.toLowerCase()} AND supersedes IS NULL AND id <> ${cur.id} LIMIT 1`);
					if (clash) throw new Error(`concept ${cur.id} can't be renamed from "${cur.name}" to "${name}": another concept already has that name`);
					const oldKey = conceptKey(cur.name);
					await tx.execute(sql`UPDATE concepts SET name = ${name}, updated_at = CURRENT_TIMESTAMP WHERE id = ${cur.id}`);
					await tx.execute(sql`
						UPDATE graph_domain_members SET concept_name = ${name}
						WHERE concept_name IS NOT NULL AND lower(regexp_replace(trim(concept_name), '\\s+', ' ', 'g')) = ${oldKey}`);
					await tx.execute(sql`
						UPDATE concepts SET requires = ARRAY(
						  SELECT CASE WHEN lower(regexp_replace(trim(r), '\\s+', ' ', 'g')) = ${oldKey} THEN ${name} ELSE r END
						  FROM unnest(requires) AS r)
						WHERE EXISTS (SELECT 1 FROM unnest(requires) AS r WHERE lower(regexp_replace(trim(r), '\\s+', ' ', 'g')) = ${oldKey})`);
					result.concepts.renamed++;
				}
				// Exports leave requires out: a file without it keeps the concept's own.
				if (c.requires === undefined && cur) next.requires = cur.requires ?? [];
				if (!cur) {
					await tx.execute(sql`
						INSERT INTO concepts (name, body, kind, requires, returns, aliases, description, origin, source_id, verified, status)
						VALUES (${name}, ${next.body}, ${next.kind}, ${sql.param(next.requires)}::text[], ${JSON.stringify(next.returns)}::jsonb,
						        ${sql.param(next.aliases)}::text[], ${next.description}, 'platform', ${next.sourceId}, true, 'approved')`);
					result.concepts.created++;
					continue;
				}
				const same = cur.body === next.body && cur.kind === next.kind && (cur.description ?? null) === next.description
					&& sameList(cur.aliases ?? [], next.aliases) && sameList(cur.requires ?? [], next.requires)
					&& JSON.stringify(cur.returns ?? {}) === JSON.stringify(next.returns) && (cur.sourceId ?? null) === next.sourceId && cur.verified;
				// A rename alone is counted under `renamed`, not as an update.
				if (same) { if (conceptKey(cur.name) === conceptKey(name)) result.concepts.unchanged++; continue; }
				await tx.execute(sql`
					UPDATE concepts SET body = ${next.body}, kind = ${next.kind}, description = ${next.description},
					       aliases = ${sql.param(next.aliases)}::text[], requires = ${sql.param(next.requires)}::text[],
					       returns = ${JSON.stringify(next.returns)}::jsonb, source_id = ${next.sourceId}, verified = true, status = 'approved',
					       updated_at = CURRENT_TIMESTAMP
					WHERE id = ${cur.id}`);
				result.concepts.updated++;
			}

			// 2. Parts (shared / fallback instructions) — only when the file has them.
			for (const p of file.parts ?? []) {
				const pid = idOf(p.id);
				let [cur] = pid !== null
					? await rows(sql`SELECT id, name, title, body, meta FROM graph_nodes WHERE id = ${pid} AND kind = ${p.kind}`)
					: [];
				if (!cur) [cur] = await rows(sql`SELECT id, name, title, body, meta FROM graph_nodes WHERE kind = ${p.kind} AND lower(name) = ${p.name.toLowerCase()} LIMIT 1`);
				// Matched by id under another name: rename (domains reference parts by id, so nothing else changes).
				if (cur && cur.name.toLowerCase() !== p.name.toLowerCase()) {
					const [clash] = await rows(sql`SELECT id FROM graph_nodes WHERE kind = ${p.kind} AND lower(name) = ${p.name.toLowerCase()} AND id <> ${cur.id} LIMIT 1`);
					if (clash) throw new Error(`instruction ${cur.id} can't be renamed from "${cur.name}" to "${p.name}": that name is taken`);
					await tx.execute(sql`UPDATE graph_nodes SET name = ${p.name}, hash = ${nodeHash(p.kind, p.name, cur.body, cur.meta ?? {})}, updated_at = CURRENT_TIMESTAMP WHERE id = ${cur.id}`);
					result.parts.renamed++;
				}
				const title = p.title ?? null;
				if (!cur) {
					await tx.execute(sql`
						INSERT INTO graph_nodes (kind, name, title, body, meta, hash, status, origin)
						VALUES (${p.kind}, ${p.name}, ${title}, ${p.body}, '{}'::jsonb, ${nodeHash(p.kind, p.name, p.body, {})}, 'published', 'import')`);
					result.parts.created++;
				} else if (cur.body === p.body && (cur.title ?? null) === title) {
					if (cur.name.toLowerCase() === p.name.toLowerCase()) result.parts.unchanged++;
				} else {
					await tx.execute(sql`
						UPDATE graph_nodes SET name = ${p.name}, title = ${title}, body = ${p.body}, hash = ${nodeHash(p.kind, p.name, p.body, cur.meta ?? {})},
						       updated_at = CURRENT_TIMESTAMP
						WHERE id = ${cur.id}`);
					result.parts.updated++;
				}
			}

			// 3. Domains: node, then terms and members replaced wholesale.
			for (const d of file.domains) {
				const name = d.name.trim();
				const meta = d.meta ?? {};
				const status = ['draft', 'published', 'retired'].includes(d.status ?? '') ? d.status! : 'draft';
				const title = d.title ?? null;
				const hash = nodeHash('domain', name, d.body, meta);

				const members: Array<{ nodeId: number | null; conceptName: string | null; role: string; position: number }> = [];
				// Concepts by name, in the order listed. The stored name comes from the
				// file's concept list, so the domain links to the concept as it's saved.
				(d.concepts ?? []).forEach((ref, i) => {
					const c = fileConcepts.get(conceptKey(ref));
					if (!c) throw new Error(`domain "${name}" names concept "${ref}", which isn't in the file's concept list`);
					members.push({ nodeId: null, conceptName: normName(c.name), role: 'concept', position: i + 1 });
				});
				for (const p of d.parts ?? []) {
					const kind = ROLE_KIND[p.role];
					if (!kind) throw new Error(`domain "${name}": unknown part role "${p.role}"`);
					const [node] = await rows(sql`SELECT id FROM graph_nodes WHERE kind = ${kind} AND lower(name) = ${p.name.toLowerCase()} LIMIT 1`);
					if (!node) throw new Error(`domain "${name}": part "${p.name}" isn't in the file or the graph`);
					members.push({ nodeId: node.id, conceptName: null, role: p.role, position: p.position });
				}
				const terms = (d.terms ?? []).map(t => ({ term: t.term.trim().toLowerCase(), weight: t.weight ?? 1 })).filter(t => t.term);

				const did = idOf(d.id);
				let [cur] = did !== null
					? await rows(sql`SELECT id, name, title, hash, status FROM graph_nodes WHERE id = ${did} AND kind = 'domain'`)
					: [];
				if (!cur) [cur] = await rows(sql`SELECT id, name, title, hash, status FROM graph_nodes WHERE kind = 'domain' AND lower(name) = ${name.toLowerCase()} LIMIT 1`);
				// Matched by id under another name: rename. The built-in pair keep their names (the router looks them up).
				if (cur && cur.name.toLowerCase() !== name.toLowerCase()) {
					if (ENGINE_OWNED.includes(cur.name.toLowerCase())) throw new Error(`domain "${cur.name}" is built-in and can't be renamed to "${name}"`);
					const [clash] = await rows(sql`SELECT id FROM graph_nodes WHERE kind = 'domain' AND lower(name) = ${name.toLowerCase()} AND id <> ${cur.id} LIMIT 1`);
					if (clash) throw new Error(`domain ${cur.id} can't be renamed from "${cur.name}" to "${name}": another domain already has that name`);
					result.domains.renamed++;
				}
				let domainId: number;
				if (!cur) {
					const [ins] = await rows(sql`
						INSERT INTO graph_nodes (kind, name, title, body, meta, hash, status, origin)
						VALUES ('domain', ${name}, ${title}, ${d.body}, ${JSON.stringify(meta)}::jsonb, ${hash}, ${status}, 'import')
						RETURNING id`);
					domainId = ins.id;
					result.domains.created++;
				} else {
					domainId = cur.id;
					const curMembers = await rows(sql`
						SELECT node_id AS "nodeId", concept_name AS "conceptName", role, position
						FROM graph_domain_members WHERE domain_id = ${domainId} ORDER BY role, position`);
					const curTerms = await rows(sql`SELECT term, weight FROM graph_domain_terms WHERE domain_id = ${domainId} ORDER BY term`);
					const sig = (ms: typeof members) => JSON.stringify([...ms].sort((a, b) => a.role.localeCompare(b.role) || a.position - b.position)
						.map(m => [m.role, m.position, m.nodeId ?? null, m.conceptName ? conceptKey(m.conceptName) : null]));
					const termSig = (ts: Array<{ term: string; weight: number }>) => JSON.stringify([...ts].sort((a, b) => a.term.localeCompare(b.term)).map(t => [t.term, t.weight]));
					const same = cur.hash === hash && (cur.title ?? null) === title && cur.status === status
						&& sig(curMembers) === sig(members) && termSig(curTerms) === termSig(terms);
					if (same) { result.domains.unchanged++; continue; }
					await tx.execute(sql`
						UPDATE graph_nodes SET name = ${name}, title = ${title}, body = ${d.body}, meta = ${JSON.stringify(meta)}::jsonb, hash = ${hash},
						       status = ${status}, updated_at = CURRENT_TIMESTAMP
						WHERE id = ${domainId}`);
					// A rename with nothing else changed is counted under `renamed` only.
					const onlyRenamed = cur.name.toLowerCase() !== name.toLowerCase()
						&& (cur.title ?? null) === title && cur.status === status
						&& sig(curMembers) === sig(members) && termSig(curTerms) === termSig(terms)
						&& cur.hash === nodeHash('domain', cur.name, d.body, meta);
					if (!onlyRenamed) result.domains.updated++;
				}
				await tx.delete(graphDomainMembers).where(eq(graphDomainMembers.domainId, domainId));
				if (members.length) {
					await tx.insert(graphDomainMembers).values(members.map(m => ({ domainId, nodeId: m.nodeId, conceptName: m.conceptName, role: m.role, position: m.position })) as any);
				}
				await tx.delete(graphDomainTerms).where(eq(graphDomainTerms.domainId, domainId));
				if (terms.length) await tx.insert(graphDomainTerms).values(terms.map(t => ({ domainId, ...t })) as any);
			}

			// 4. Replace: retire domains the file doesn't list, then delete verified
			//    concepts it doesn't list that no remaining domain still uses.
			if (opts.mode === 'replace') {
				const keep = [...file.domains.map(d => d.name.trim().toLowerCase()), ...ENGINE_OWNED];
				const retired = await rows(sql`
					UPDATE graph_nodes SET status = 'retired', updated_at = CURRENT_TIMESTAMP
					WHERE kind = 'domain' AND status <> 'retired' AND lower(name) <> ALL(${sql.param(keep)}::text[])
					RETURNING id`);
				result.domains.removed = retired.length;

				const keepConcepts = [...fileConcepts.keys()];
				const deleted = await rows(sql`
					DELETE FROM concepts c
					WHERE c.verified = true AND c.supersedes IS NULL
					  AND lower(regexp_replace(trim(c.name), '\\s+', ' ', 'g')) <> ALL(${sql.param(keepConcepts)}::text[])
					  AND NOT EXISTS (
					    SELECT 1 FROM graph_domain_members m JOIN graph_nodes d ON d.id = m.domain_id
					    WHERE d.status <> 'retired' AND m.concept_name IS NOT NULL
					      AND lower(regexp_replace(trim(m.concept_name), '\\s+', ' ', 'g')) = lower(regexp_replace(trim(c.name), '\\s+', ' ', 'g'))
					  )
					RETURNING id`);
				result.concepts.removed = deleted.length;
			}

			if (opts.dryRun) throw new DryRunRollback();
		});
	} catch (e) {
		if (!(e instanceof DryRunRollback)) throw e;
	}
	return result;
}
