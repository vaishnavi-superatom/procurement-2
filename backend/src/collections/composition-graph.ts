import * as graph from '../../../database/postgres/src/project-data-db/graph';
import type { CollectionContext } from './types';
import { graphManagedByPlatform } from '../services/graph-replica';

/**
 * With SA_GRAPH_REPLICATION=on and a graph published on the platform, this
 * engine only holds a copy of the current release (services/graph-replica.ts):
 * a local edit would be overwritten by the next release, so writes are refused.
 * With replication off, or nothing published yet, the graph is edited locally.
 */
const MANAGED_BY_PLATFORM = {
	success: false,
	error: 'The composition graph is managed on the platform; edit and publish it there',
} as const;

/**
 * Composition graph — the authored domains the router sends questions to, the
 * concepts each one is built from, and the terms that route to it.
 *
 * Read-only for now: authoring still goes through scripts/graph-import.ts.
 */
export async function registerCompositionGraphCollections({ sdk }: CollectionContext): Promise<void> {
	/** Every domain with its members and terms (no bodies). Retired domains only when asked. */
	sdk.addCollection('composition-graph', 'listDomains', async (params: any = {}) => {
		const data = await graph.listDomainViews({ includeRetired: !!params?.includeRetired });
		return { success: true, data, count: data.length };
	});

	/** One domain in full — part and concept bodies included. */
	sdk.addCollection('composition-graph', 'getDomain', async (params: any = {}) => {
		const name = String(params?.name ?? '').trim();
		if (!name) return { success: false, error: 'name is required' };
		const [data] = await graph.listDomainViews({ name, includeRetired: true, withBodies: true });
		if (!data) return { success: false, error: `domain "${name}" not found` };
		return { success: true, data };
	});

	/** Questions that matched no domain — what to author next. */
	sdk.addCollection('composition-graph', 'routeGaps', async (params: any = {}) => {
		const days = Math.min(Math.max(Number(params?.days) || 7, 1), 90);
		const limit = Math.min(Number(params?.limit) || 50, 200);
		const data = await graph.routeGaps(days, limit);
		return { success: true, data, count: data.length };
	});

	/** Every routed question (matched or not), newest first. */
	sdk.addCollection('composition-graph', 'listRoutes', async (params: any = {}) => {
		const days = Math.min(Math.max(Number(params?.days) || 7, 1), 90);
		const limit = Math.min(Number(params?.limit) || 500, 2000);
		const data = await graph.listRoutes(days, limit);
		return { success: true, data, count: data.length };
	});

	/**
	 * Apply an exported graph file in one transaction, matched by id (same
	 * project only) then name. `projectId`: the project being imported into.
	 * `mode`: merge (add + update) or replace (also retire / delete what the file
	 * doesn't list). `dryRun: true` reports the counts and writes nothing.
	 */
	sdk.addCollection('composition-graph', 'importGraph', async (params: any = {}) => {
		if (graphManagedByPlatform() && params?.dryRun === false) return MANAGED_BY_PLATFORM;
		const file = params?.data;
		const mode = params?.mode === 'replace' ? 'replace' : 'merge';
		const problem = checkImportFile(file);
		if (problem) return { success: false, error: problem };
		try {
			// Ids only identify rows in the project the file came from; elsewhere match by name.
			const useIds = !!file.projectId && !!params?.projectId && String(file.projectId) === String(params.projectId);
			const data = await graph.importGraph(file, { mode, dryRun: params?.dryRun !== false, useIds });
			return { success: true, data };
		} catch (e: any) {
			return { success: false, error: e?.message ?? String(e) };
		}
	});

	// ── Writes ─────────────────────────────────────────────────────────────
	// Membership and terms are replaced wholesale, like the import: the caller
	// sends the full edited list. A published domain's hash changes with any
	// edit, so the router recomposes it on the next question — no restart.

	/** New domain, as a draft. */
	sdk.addCollection('composition-graph', 'createDomain', async (params: any = {}) => {
		if (graphManagedByPlatform()) return MANAGED_BY_PLATFORM;
		const name = String(params?.name ?? '').trim();
		if (!/^[a-z0-9_]+$/i.test(name)) return { success: false, error: 'name is required (letters, digits, underscores)' };
		if (await graph.getNode('domain', name)) return { success: false, error: `domain "${name}" already exists` };
		const body = String(params?.body ?? '').trim();
		if (!body) return { success: false, error: 'body (the domain description) is required' };
		const node = await graph.putNode({
			kind: 'domain', name, title: params?.title?.trim() || name.replace(/_/g, ' '), body,
			meta: { threshold: Number(params?.threshold) || 2, fallbackAllowed: true }, status: 'draft', origin: 'human',
		});
		return { success: true, data: node };
	});

	/** Title, description or threshold. The name is the identity and does not change. */
	sdk.addCollection('composition-graph', 'updateDomain', async (params: any = {}) => {
		if (graphManagedByPlatform()) return MANAGED_BY_PLATFORM;
		const found = await requireDomain(params?.name);
		if ('error' in found) return found;
		const d = found.domain;
		const meta = { ...(d.meta ?? {}) };
		if (params?.threshold !== undefined) {
			if (isEngineOwned(d)) return { success: false, error: `"${d.name}" is engine-owned; its threshold is fixed` };
			const t = Number(params.threshold);
			if (!Number.isFinite(t) || t < 0) return { success: false, error: 'threshold must be a number ≥ 0' };
			meta.threshold = t;
		}
		const node = await graph.putNode({
			kind: 'domain', name: d.name,
			title: params?.title !== undefined ? String(params.title).trim() : (d.title ?? undefined),
			body: params?.body !== undefined ? String(params.body).trim() : d.body,
			meta,
		});
		return { success: true, data: node };
	});

	/** Publish, unpublish (draft) or retire. */
	sdk.addCollection('composition-graph', 'setDomainStatus', async (params: any = {}) => {
		if (graphManagedByPlatform()) return MANAGED_BY_PLATFORM;
		const status = params?.status;
		if (!['draft', 'published', 'retired'].includes(status)) return { success: false, error: 'status must be draft, published or retired' };
		const found = await requireDomain(params?.name);
		if ('error' in found) return found;
		if (isEngineOwned(found.domain) && status !== 'published') return { success: false, error: `"${found.domain.name}" is engine-owned and must stay published` };
		await graph.setDomainStatus(found.domain.id, status);
		return { success: true };
	});

	/** Retire by default (keeps route history readable); `hard: true` removes it with its members and terms. */
	sdk.addCollection('composition-graph', 'deleteDomain', async (params: any = {}) => {
		if (graphManagedByPlatform()) return MANAGED_BY_PLATFORM;
		const found = await requireDomain(params?.name);
		if ('error' in found) return found;
		if (isEngineOwned(found.domain)) return { success: false, error: `"${found.domain.name}" is engine-owned and cannot be deleted` };
		if (params?.hard) await graph.deleteDomain(found.domain.id);
		else await graph.setDomainStatus(found.domain.id, 'retired');
		return { success: true };
	});

	/** Replace the domain's concepts with this ordered list. Every name must match a verified concept exactly. */
	sdk.addCollection('composition-graph', 'setDomainConcepts', async (params: any = {}) => {
		if (graphManagedByPlatform()) return MANAGED_BY_PLATFORM;
		const found = await requireDomain(params?.name);
		if ('error' in found) return found;
		if (!Array.isArray(params?.concepts)) return { success: false, error: 'concepts must be an array of concept names' };
		const names: string[] = [...new Set<string>(params.concepts.map((c: any) => String(c).trim()).filter(Boolean))];
		const unknown = await graph.unknownConceptNames(names);
		if (unknown.length) return { success: false, error: `not in the concept store: ${unknown.join(', ')}`, unknown };
		// Keep the domain's prompt / file / setting / program members; only concepts are replaced.
		const keep = await nonConceptMembers(found.domain.name);
		await graph.setDomainMembers(found.domain.id, [
			...keep,
			...names.map((conceptName, i) => ({ conceptName, role: 'concept' as const, position: i + 1 })),
		]);
		return { success: true, count: names.length };
	});

	/** Replace the domain's routing terms. */
	sdk.addCollection('composition-graph', 'setDomainTerms', async (params: any = {}) => {
		if (graphManagedByPlatform()) return MANAGED_BY_PLATFORM;
		const found = await requireDomain(params?.name);
		if ('error' in found) return found;
		if (isEngineOwned(found.domain)) return { success: false, error: `"${found.domain.name}" is engine-owned and is never routed to by terms` };
		if (!Array.isArray(params?.terms)) return { success: false, error: 'terms must be an array of { term, weight }' };
		const seen = new Set<string>();
		const terms: Array<{ term: string; weight: number }> = [];
		for (const t of params.terms) {
			const term = String(t?.term ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
			if (!term || seen.has(term)) continue;
			if (term.length > 64) return { success: false, error: `term too long (max 64): "${term}"` };
			const weight = Number(t?.weight ?? 1);
			if (!Number.isFinite(weight) || weight < 0) return { success: false, error: `invalid weight for "${term}"` };
			seen.add(term);
			terms.push({ term, weight });
		}
		await graph.setDomainTerms(found.domain.id, terms);
		return { success: true, count: terms.length };
	});

	/** Edit a prompt part (the shared / generic domains' answer format, rules, traps…). */
	sdk.addCollection('composition-graph', 'updatePart', async (params: any = {}) => {
		if (graphManagedByPlatform()) return MANAGED_BY_PLATFORM;
		const name = String(params?.name ?? '').trim();
		const part = name ? await graph.getNode('part', name) : null;
		if (!part) return { success: false, error: `part "${name}" not found` };
		const body = params?.body !== undefined ? String(params.body) : part.body;
		if (!body.trim()) return { success: false, error: 'body cannot be empty' };
		const node = await graph.putNode({
			kind: 'part', name: part.name,
			title: params?.title !== undefined ? String(params.title).trim() : (part.title ?? undefined),
			body, meta: part.meta ?? {},
		});
		return { success: true, data: node };
	});

	console.log('✓ composition-graph collections registered');
}

/** Shape check for an import file; the UI checks it in more detail first. Returns the first problem. */
function checkImportFile(f: any): string | null {
	if (!f || typeof f !== 'object') return 'data is required';
	if (f.version !== 1) return `unsupported file version: ${f.version}`;
	if (!Array.isArray(f.domains)) return 'domains must be a list';
	const badId = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'number' && Number.isInteger(v));
	if (!Array.isArray(f.concepts)) return 'concepts must be a list';
	for (const c of f.concepts) {
		if (!c || typeof c.name !== 'string' || !c.name.trim()) return 'a concept has no name';
		if (badId(c.id)) return `concept "${c.name}": id must be a whole number`;
		if (typeof c.body !== 'string' || !c.body.trim()) return `concept "${c.name}": body is required`;
	}
	for (const d of f.domains) {
		if (!d || typeof d.name !== 'string' || !/^[a-z0-9_]+$/i.test(d.name)) return `invalid domain name: ${JSON.stringify(d?.name)}`;
		if (badId(d.id)) return `domain "${d.name}": id must be a whole number`;
		if (typeof d.body !== 'string') return `domain "${d.name}": body must be text`;
		if (d.concepts !== undefined && (!Array.isArray(d.concepts) || d.concepts.some((c: unknown) => typeof c !== 'string'))) {
			return `domain "${d.name}": concepts must be a list of concept names`;
		}
	}
	if (f.parts !== undefined && !Array.isArray(f.parts)) return 'parts must be a list';
	for (const p of f.parts ?? []) {
		if (!p || typeof p.name !== 'string' || typeof p.kind !== 'string' || typeof p.body !== 'string') return 'every part needs kind, name and body';
	}
	return null;
}

/** `shared` and `generic` are created by graph-seed.ts and the router depends on them. */
function isEngineOwned(d: { name: string; meta?: Record<string, any> }): boolean {
	return !!d.meta?.shared || !!d.meta?.fallback || ['shared', 'generic'].includes(d.name.toLowerCase());
}

async function requireDomain(rawName: unknown) {
	const name = String(rawName ?? '').trim();
	if (!name) return { success: false as const, error: 'name is required' };
	const domain = await graph.getNode('domain', name);
	if (!domain) return { success: false as const, error: `domain "${name}" not found` };
	return { domain };
}

/** The domain's current non-concept members, in the shape setDomainMembers takes. */
async function nonConceptMembers(name: string) {
	const [view] = await graph.listDomainViews({ name, includeRetired: true });
	const out: Array<{ nodeId: number; role: graph.MemberRole; position: number }> = [];
	if (!view) return out;
	for (const m of view.members) {
		if (m.role === 'concept' || !m.node) continue;
		const node = await graph.getNode(m.node.kind as graph.NodeKind, m.node.name);
		if (node) out.push({ nodeId: node.id, role: m.role, position: m.position });
	}
	return out;
}
