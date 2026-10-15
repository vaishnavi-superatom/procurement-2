import * as entitySearch from '../../../database/postgres/src/project-data-db/entity-search';
import type { CollectionContext } from './types';

/**
 * Entity Search — value index + entity map.
 *
 * Read path for the MainAgent pre-pass:
 *   collections['entity-search']['resolve']    ({ query, entityType?, limit?, minScore? })
 *   collections['entity-search']['resolveMany']({ mentions[], ... })
 *   collections['entity-search']['entities']   ()  → the entity map
 *
 * Write path (indexer / admin):
 *   ['upsertEntityType'] ['indexValues'] ['deleteValues'] ['deleteEntityType'] ['stats']
 *
 * Every read op is NON-THROWING: while the index is still empty the pre-pass
 * must degrade to "nothing resolved" and leave the agent exactly as it is
 * today. A resolver outage must never take the whole answer down with it.
 *
 * Design: backend/docs/ENTITY-SEARCH-DESIGN.md
 */
export async function registerEntitySearchCollections({ sdk }: CollectionContext): Promise<void> {

	// ── Read path ────────────────────────────────────────────────────────────

	sdk.addCollection('entity-search', 'resolve', async (params: {
		query: string;
		entityType?: string;
		limit?: number;
		minScore?: number;
	}) => {
		try {
			return await entitySearch.resolve(params);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[ENTITY-SEARCH] resolve failed (non-blocking): ${msg}`);
			return { query: params?.query || '', resolved: false, ambiguous: false, hits: [], error: msg };
		}
	});

	sdk.addCollection('entity-search', 'resolveMany', async (params: {
		mentions: string[];
		entityType?: string;
		limit?: number;
		minScore?: number;
	}) => {
		try {
			return await entitySearch.resolveMany(params);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[ENTITY-SEARCH] resolveMany failed (non-blocking): ${msg}`);
			// Report every mention as unresolved rather than silently dropping
			// them — a caller must never mistake an outage for "no such customer".
			return { success: false, results: [], unresolved: params?.mentions || [], error: msg };
		}
	});

	// THE call the agent's forced `resolve_entities` tool maps onto: names →
	// ids, and concepts → table/column/join facts, in one round trip.
	sdk.addCollection('entity-search', 'resolveEntities', async (params: {
		mentions?: Array<{ text: string; entityType?: string }>;
		entityTypes?: string[];
		limit?: number;
		minScore?: number;
	}) => {
		try {
			return await entitySearch.resolveEntities(params || {});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[ENTITY-SEARCH] resolveEntities failed (non-blocking): ${msg}`);
			// Fail OPEN but HONEST: report every mention as unresolved rather than
			// letting an outage look like "no such customer".
			return {
				success: false, resolved: [], entityMap: {}, unmatchedEntityTypes: [],
				unresolved: (params?.mentions || []).map(m => m.text), error: msg,
			};
		}
	});

	// Compact catalog (type + gloss) for the system prompt — this is what lets
	// the LLM name a concept instead of guessing at our vocabulary.
	sdk.addCollection('entity-search', 'catalog', async () => {
		try {
			return await entitySearch.getEntityCatalog();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[ENTITY-SEARCH] catalog failed (non-blocking): ${msg}`);
			return { success: false, data: [], count: 0, error: msg };
		}
	});

	// The entity map: how to reach each user-facing concept. Small (a few dozen
	// rows) and read on every question, so the SDK side caches it per turn.
	sdk.addCollection('entity-search', 'entities', async (params?: { entityType?: string }) => {
		try {
			if (params?.entityType) {
				const one = await entitySearch.getEntityType(params.entityType);
				return { success: true, data: [one.data], count: 1 };
			}
			return await entitySearch.getEntityTypes();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[ENTITY-SEARCH] entities failed (non-blocking): ${msg}`);
			return { success: false, data: [], count: 0, error: msg };
		}
	});

	// ── Write path ───────────────────────────────────────────────────────────
	// These DO throw: an indexer must fail loudly, not write half an index.

	sdk.addCollection('entity-search', 'upsertEntityType', async (params: {
		entityType: string;
		resolution: Record<string, any>;
	}) => entitySearch.upsertEntityType(params));

	sdk.addCollection('entity-search', 'indexValues', async (params: {
		entityType: string;
		values: entitySearch.IndexValueInput[];
		replace?: boolean;
		chunkSize?: number;
	}) => entitySearch.indexValues(params));

	sdk.addCollection('entity-search', 'deleteValues', async (params: {
		entityType: string;
		instanceId?: string;
	}) => entitySearch.deleteValues(params));

	sdk.addCollection('entity-search', 'deleteEntityType', async (params: { entityType: string }) =>
		entitySearch.deleteEntityType(params.entityType));

	sdk.addCollection('entity-search', 'stats', async () => {
		try {
			return await entitySearch.stats();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, byEntity: [], totalValues: 0, error: msg };
		}
	});

	console.log('✓ Entity search collections registered');
}
