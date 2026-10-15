import { sql } from 'drizzle-orm';
import { db, schema } from './drizzle-db';
import { nodeHash } from './graph';

const { concepts, graphNodes, graphDomainMembers, graphDomainTerms } = schema;

/**
 * GRAPH REPLICA — write a platform release into this engine's graph tables.
 *
 * With SA_GRAPH_REPLICATION=on the graph is authored on the platform (Neon) and
 * this engine only holds a copy of the current release: graph_nodes,
 * graph_domain_members, graph_domain_terms and the verified concepts. The copy is
 * replaced as a whole in one transaction, so the router never sees half a
 * release. Ids are kept from the platform, so a release always refers to the
 * same rows.
 *
 * Proposed concepts (verified = false, or supersedes set) are this engine's own
 * and are kept. graph_routes is history and is never touched.
 */

export interface ReplicaItem {
	entity: 'node' | 'concept';
	id: number;
	rev: number;
	hash: string;
	content: any;
}

const CHUNK = 500;

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
	for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

export async function applyGraphRelease(items: ReplicaItem[]): Promise<{ nodes: number; concepts: number }> {
	const conceptItems = items.filter((i) => i.entity === 'concept');
	const nodeItems = items.filter((i) => i.entity === 'node');
	const conceptName = new Map(conceptItems.map((c) => [c.id, String(c.content.name)]));

	const conceptRows = conceptItems.map((c) => ({
		id: c.id,
		name: c.content.name,
		body: c.content.body,
		kind: c.content.kind ?? 'definition',
		type: c.content.type ?? null,
		requires: c.content.requires ?? [],
		returns: c.content.returns ?? {},
		aliases: c.content.aliases ?? [],
		description: c.content.description ?? null,
		sourceId: c.content.sourceId ?? null,
		origin: 'platform',
		// In force: the database requires status 'approved' exactly when verified.
		verified: true,
		status: 'approved',
		supersedes: null,
	}));

	const nodeRows = nodeItems.map((n) => {
		const meta = n.content.meta ?? {};
		return {
			id: n.id,
			kind: n.content.kind,
			name: n.content.name,
			title: n.content.title ?? null,
			body: n.content.body ?? '',
			meta,
			// The engine's own hash, so composition caching works exactly as before.
			hash: nodeHash(n.content.kind, n.content.name, n.content.body ?? '', meta),
			status: n.content.status ?? 'draft',
			origin: 'platform',
		};
	});

	const memberRows = nodeItems.flatMap((n) =>
		((n.content.edges ?? []) as Array<{ role: string; position: number; nodeId: number | null; conceptId: number | null }>).map((e) => {
			if (e.conceptId != null && !conceptName.has(e.conceptId)) {
				throw new Error(`node ${n.id} links to concept ${e.conceptId}, which is not in the release`);
			}
			return {
				// The engine table is named for domains, but any node's links live here.
				domainId: n.id,
				nodeId: e.nodeId ?? null,
				conceptName: e.conceptId != null ? conceptName.get(e.conceptId)! : null,
				role: e.role,
				position: e.position,
			};
		}),
	);

	const termRows = nodeItems.flatMap((n) =>
		((n.content.terms ?? []) as Array<{ term: string; weight: number }>).map((t) => ({
			domainId: n.id,
			term: t.term,
			weight: t.weight ?? 1,
		})),
	);

	await db.transaction(async (tx) => {
		// ── The graph: replaced as a whole.
		await tx.delete(graphDomainTerms);
		await tx.delete(graphDomainMembers);
		await tx.delete(graphNodes);
		await insertChunks(nodeRows, (chunk) => tx.insert(graphNodes).values(chunk as any));
		await insertChunks(memberRows, (chunk) => tx.insert(graphDomainMembers).values(chunk as any));
		await insertChunks(termRows, (chunk) => tx.insert(graphDomainTerms).values(chunk as any));

		// ── Concepts: the verified store is replaced; local proposals stay.
		await tx.execute(sql`DELETE FROM concepts WHERE supersedes IS NULL AND verified = true`);

		const ids = conceptRows.map((c) => c.id);
		if (ids.length) {
			// A proposal that happens to hold one of the platform's ids moves to a
			// fresh id first. The sequence is lifted above every platform id, so
			// nextval can't hand out one of them.
			await tx.execute(sql`
				SELECT setval(pg_get_serial_sequence('concepts', 'id'),
				              GREATEST((SELECT COALESCE(max(id), 0) FROM concepts), ${Math.max(...ids)}, 1))
			`);
			await tx.execute(sql`
				UPDATE concepts SET id = nextval(pg_get_serial_sequence('concepts', 'id'))
				WHERE id = ANY(${sql.param(ids)}::int[])
			`);
			// A proposed NEW concept whose name the platform now has becomes a
			// proposed revision of it, instead of colliding on the unique name.
			await tx.execute(sql`
				UPDATE concepts p SET supersedes = r.id
				FROM jsonb_to_recordset(${JSON.stringify(conceptRows.map((c) => ({ id: c.id, name: c.name, source_id: c.sourceId })))}::jsonb)
				     AS r(id int, name text, source_id text)
				WHERE p.supersedes IS NULL
				  AND lower(p.name) = lower(r.name)
				  AND coalesce(p.source_id, '') = coalesce(r.source_id, '')
			`);
			await insertChunks(conceptRows, (chunk) => tx.insert(concepts).values(chunk as any));
		}

		// Later local inserts (concept-builder proposals) must not collide with platform ids.
		await tx.execute(sql`SELECT setval(pg_get_serial_sequence('concepts', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM concepts), 1))`);
		await tx.execute(sql`SELECT setval(pg_get_serial_sequence('graph_nodes', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM graph_nodes), 1))`);
	});

	return { nodes: nodeRows.length, concepts: conceptRows.length };
}
