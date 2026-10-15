import * as concepts from '../../../database/postgres/src/project-data-db/concepts';
import type { CollectionContext } from './types';

/**
 * Concepts — the computable ideas the agent must know how to find or derive.
 *
 * Read path (agent):
 *   collections['concepts']['catalog']    ()                → names + aliases, NO bodies
 *   collections['concepts']['resolve']    ({ names[], … })  → bodies, requires-closure included
 *   collections['concepts']['invariants'] ({ sourceId? })   → the always-injected tier
 *
 * Write path (loader / admin):
 *   ['create'] ['update'] ['delete'] ['clear'] ['list'] ['stats'] ['lint']
 *
 * Read ops are NON-THROWING, matching entity-search: an empty or broken concept
 * store must degrade to "nothing resolved" and leave the agent exactly as it is
 * today, never take the whole answer down. Write ops DO throw — a loader must
 * fail loudly rather than write half a store.
 *
 * The split between `catalog` and `resolve` is the design, not an optimisation:
 * the agent is shown names, picks the ones it needs, and only then receives
 * bodies. Injecting every body up front rebuilds the always-on context problem
 * concepts exist to solve.
 */
export async function registerConceptsCollections({ sdk }: CollectionContext): Promise<void> {

	// ── Read path ────────────────────────────────────────────────────────────

	// What goes in the system prompt. Names and aliases only — small enough that
	// the whole catalog fits, which is why this needs no embedding search.
	sdk.addCollection('concepts', 'catalog', async () => {
		try {
			return await concepts.getConceptCatalog();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[CONCEPTS] catalog failed (non-blocking): ${msg}`);
			return { success: false, data: [], count: 0, error: msg };
		}
	});

	// THE call: names → bodies, with the transitive `requires` closure pulled in
	// automatically. A caller asking for 'revenue forecast' cannot end up with
	// the formula but not the filter it depends on.
	sdk.addCollection('concepts', 'resolve', async (params: {
		names: string[];
		sourceId?: string | null;
		includeInvariants?: boolean;
	}) => {
		try {
			const res = await concepts.resolveConcepts(params || { names: [] });
			// A requires-edge pointing at a concept that does not exist means a
			// dependency was silently NOT injected — invisible at answer time, so
			// log it here where it can still be noticed.
			if (res.danglingRequires.length) {
				console.warn(
					`[CONCEPTS] dangling requires: ` +
					res.danglingRequires.map(d => `${d.concept} → '${d.missing}'`).join(', ')
				);
			}
			console.log(
				`[CONCEPTS] resolve(${(params?.names || []).length} asked) → ` +
				`${res.resolved.length} concept(s)` +
				(res.implied.length ? `, ${res.implied.length} implied by requires` : '') +
				(res.unmatched.length ? `, unmatched: ${res.unmatched.join(', ')}` : '') +
				(res.corrected?.length ? `, corrected: ${res.corrected.map(c => `"${c.asked}"→"${c.matched}"`).join(', ')}` : '') +
				(res.suggestions?.length ? `, ambiguous: ${res.suggestions.map(s => `"${s.asked}" (${s.candidates.map(c => c.name).join(' / ')})`).join(', ')}` : '')
			);
			// The actual text reaching the LLM — the summary line above only has
			// counts, which doesn't show whether a concept's body is what we think
			// it is. Log every resolved body so a wrong/stale answer can be checked
			// against exactly what context the model actually saw.
			for (const c of res.resolved) {
				console.log(`[CONCEPTS]   [${c.kind}] ${c.name}: ${c.body}`);
			}
			return res;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[CONCEPTS] resolve failed (non-blocking): ${msg}`);
			// Fail OPEN but HONEST — report the names as unmatched rather than
			// letting an outage look like "no such concept".
			return {
				success: false, resolved: [], implied: [], danglingRequires: [],
				corrected: [], suggestions: [],
				unmatched: params?.names || [], error: msg,
			};
		}
	});

	// The always-on tier: preconditions no question is semantically close to
	// (date encoding, valid-row filters). Never retrieval-gated — a search over
	// the question text cannot find them, and dropping one silently changes the
	// answer rather than producing an error.
	sdk.addCollection('concepts', 'invariants', async (params?: { sourceId?: string | null }) => {
		try {
			return await concepts.getInvariants(params?.sourceId ?? null);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[CONCEPTS] invariants failed (non-blocking): ${msg}`);
			return { success: false, data: [], count: 0, error: msg };
		}
	});

	sdk.addCollection('concepts', 'list', async () => {
		try {
			return await concepts.getAllConcepts();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[CONCEPTS] list failed (non-blocking): ${msg}`);
			return { success: false, data: [], count: 0, error: msg };
		}
	});

	// ── Write path ───────────────────────────────────────────────────────────
	// These DO throw: a loader must fail loudly, not write half a store.

	sdk.addCollection('concepts', 'create', async (params: concepts.CreateConceptParams) =>
		concepts.createConcept(params));

	sdk.addCollection('concepts', 'update', async (params: concepts.UpdateConceptParams) =>
		concepts.updateConcept(params));

	sdk.addCollection('concepts', 'delete', async (params: { id: number }) =>
		concepts.deleteConcept(params.id));

	// Authoritative reload: a concept file defines the whole store, not a patch.
	// Deliberately touches ONLY `concepts` — search_entity_types / search_values
	// are a separate store precisely so neither wipe can take the other with it.
	sdk.addCollection('concepts', 'clear', async () => concepts.clearAllConcepts());

	// ── Integrity ────────────────────────────────────────────────────────────

	sdk.addCollection('concepts', 'lint', async () => {
		try {
			return await concepts.findDanglingRequires();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, data: [], count: 0, error: msg };
		}
	});

	// ── Review queue ────────────────────────────────────────────────────────
	// Coding agents write proposals with verified=false, which every runtime read
	// path filters out. Without these three ops the proposals would accumulate
	// where nobody can act on them.

	/** Everything awaiting review. A row with `supersedes` is a proposed
	 *  REPLACEMENT for that concept, and carries `supersedesName` so the UI can
	 *  say what it would replace without a second query. */
	sdk.addCollection('concepts', 'proposals', async () => concepts.listConceptProposals());

	/** Accept: a revision replaces its original and is consumed; a plain proposal
	 *  is simply marked verified. Which of the two is decided here rather than by
	 *  the caller, so a UI cannot pick the wrong one. */
	sdk.addCollection('concepts', 'accept', async (params: { id: number }) => {
		const id = Number(params?.id);
		if (!Number.isFinite(id)) return { success: false, error: 'id is required' };
		const all = await concepts.listConceptProposals();
		const row: any = all.data.find((c: any) => c.id === id);
		if (!row) return { success: false, error: `No pending proposal with id ${id}` };
		return row.supersedes
			? concepts.acceptConceptRevision(id)
			: concepts.setConceptVerified(id, true);
	});

	/** Reject: delete outright. A rejected proposal that stayed in the queue
	 *  would be re-reviewed forever; the agent's memory/ is what stops it being
	 *  re-proposed. */
	sdk.addCollection('concepts', 'reject', async (params: { id: number }) => {
		const id = Number(params?.id);
		if (!Number.isFinite(id)) return { success: false, error: 'id is required' };
		const all = await concepts.listConceptProposals();
		if (!all.data.some((c: any) => c.id === id)) {
			// Guard: only ever removes something unverified, so this can never
			// delete a live concept through a mistyped id.
			return { success: false, error: `No pending proposal with id ${id}` };
		}
		return concepts.deleteConcept(id);
	});

	/** Concepts whose source knowledge node was deleted. They stay live by
	 *  design; this makes that visible instead of silent. */
	sdk.addCollection('concepts', 'orphans', async () => concepts.findOrphanedConcepts());

	sdk.addCollection('concepts', 'stats', async () => {
		try {
			return await concepts.conceptStats();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, byKind: [], total: 0, error: msg };
		}
	});

	console.log('✓ Concepts collections registered');
}
