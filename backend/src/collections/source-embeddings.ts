/**
 * Source Summary Embeddings Collection
 *
 * One embedding per data source. Lets the agent flow pre-filter
 * `agentTools` BEFORE the MainAgent runs — narrowing the prompt from
 * "every source in the project" to "top-K semantically relevant sources".
 *
 * Document shape:
 *   text: "SourceName (TYPE) — description. Contains: entityA [colA, colB]; entityB [...]"
 *   metadata: { projectId, sourceId, sourceType, sourceName, toolType, tableCount, updatedAt }
 *
 * Search is metadata-filtered by projectId. Direct tools (toolType='direct')
 * are embedded too so they can match questions like "create an alert".
 */

import type { CollectionContext } from './types';
import type { ChromaManager } from '../../../database/chromadb/src/chroma-manager';
import { createHash } from 'crypto';

interface SourceSummaryInput {
	sourceId: string;
	sourceType: string;
	sourceName: string;
	toolType?: string;
	summaryText: string;
	tableCount?: number;
}

/**
 * Compute a stable fingerprint across all sources in a project.
 * Captures source IDs, names, types, and the summary text (which includes
 * the top-N table names + columns). Any meaningful change invalidates it.
 */
function computeProjectFingerprint(sources: SourceSummaryInput[]): string {
	const normalized = sources
		.map(s => ({
			id: s.sourceId,
			type: s.sourceType,
			name: s.sourceName,
			toolType: s.toolType || 'source',
			tableCount: s.tableCount || 0,
			text: s.summaryText,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	const json = JSON.stringify(normalized);
	return createHash('sha1').update(json).digest('hex').slice(0, 16);
}

// Track per-manager initialization — see schema-embeddings.ts for rationale.
const initializedManagers = new WeakSet<ChromaManager>();

async function ensureCollection(manager: ChromaManager): Promise<boolean> {
	const isHealthy = await manager.healthCheck().catch(() => false);
	if (!isHealthy) return false;
	if (!initializedManagers.has(manager)) {
		await manager.createCollection(false);
		initializedManagers.add(manager);
	}
	return true;
}

function makeId(sourceId: string): string {
	return `src::${sourceId}`.replace(/[^a-zA-Z0-9:._-]/g, '_');
}

/**
 * Upsert source summary embeddings for an entire project.
 * Replaces any prior entries for the project so deleted sources are removed.
 */
export async function upsertSourcesForProject(
	manager: ChromaManager,
	params: {
		projectId: string;
		sources: SourceSummaryInput[];
	}
): Promise<{ success: boolean; count: number; error?: string }> {
	const { projectId, sources } = params;

	try {
		const ok = await ensureCollection(manager);
		if (!ok) return { success: false, count: 0, error: 'ChromaDB unhealthy' };

		// Freshness check: if stored fingerprint matches, skip the re-embed.
		// Source summaries rarely change between restarts — only when sources
		// are added, removed, or their schemas change materially.
		const fingerprint = computeProjectFingerprint(sources);
		try {
			const existing = await manager.getByFilter({ projectId }, sources.length + 1);
			const storedFingerprint = existing.metadatas?.[0]?.projectFingerprint;
			const storedCount = existing.ids?.length || 0;
			if (
				storedFingerprint &&
				storedFingerprint === fingerprint &&
				storedCount === sources.length
			) {
				console.log(`[SOURCE-EMBED] Skipped project ${projectId} — fingerprint unchanged (${fingerprint})`);
				return { success: true, count: sources.length };
			}
		} catch {
			// Collection missing or empty — fall through to upsert
		}

		// Remove prior entries for this project (handles source removal)
		try {
			await manager.deleteWhere({ projectId });
		} catch {
			// Collection may be empty — ignore
		}

		if (sources.length === 0) {
			return { success: true, count: 0 };
		}

		const now = new Date().toISOString();
		const ids = sources.map(s => makeId(s.sourceId));
		const documents = sources.map(s => s.summaryText);
		const metadatas = sources.map(s => ({
			projectId,
			sourceId: s.sourceId,
			sourceType: s.sourceType,
			sourceName: s.sourceName,
			toolType: s.toolType || 'source',
			tableCount: s.tableCount || 0,
			projectFingerprint: fingerprint,
			updatedAt: now,
		}));

		await manager.upsert({ ids, documents, metadatas });
		console.log(`[SOURCE-EMBED] Upserted ${sources.length} source summaries for project ${projectId}`);
		return { success: true, count: sources.length };
	} catch (error: any) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[SOURCE-EMBED] Upsert failed: ${msg}`);
		return { success: false, count: 0, error: msg };
	}
}

/**
 * Register SDK collection so agent-user-response.ts can search.
 *
 *   collections['source-embeddings']['search']({ query, projectId?, topK? })
 *     → [{ sourceId, sourceName, sourceType, toolType, similarity }]
 */
export async function registerSourceEmbeddingsCollections(
	{ sdk, chromaManagers }: CollectionContext
): Promise<void> {
	const manager = chromaManagers.sourceSummaries;

	sdk.addCollection('source-embeddings', 'search', async (params: {
		query: string;
		projectId?: string;
		topK?: number;
	}) => {
		const { query, projectId, topK = 10 } = params;
		if (!query || query.trim().length === 0) {
			return { success: false, error: 'query is required', results: [] };
		}

		try {
			const ok = await ensureCollection(manager);
			if (!ok) return { success: false, error: 'ChromaDB unhealthy', results: [] };

			const where = projectId ? { projectId } : undefined;
			const chromaResults = await manager.queryWithFilter(query, topK, where);

			if (!chromaResults.ids?.[0] || chromaResults.ids[0].length === 0) {
				return { success: true, results: [] };
			}

			const results = [];
			for (let i = 0; i < chromaResults.ids[0].length; i++) {
				const md = (chromaResults.metadatas?.[0]?.[i] || {}) as any;
				const distance = chromaResults.distances?.[0]?.[i] ?? Number.MAX_VALUE;
				// See schema-embeddings.ts for rationale: 1/(1+distance) is monotonic
				// and distance-metric-agnostic.
				const similarity = 1 / (1 + distance);
				results.push({
					sourceId: md.sourceId,
					sourceName: md.sourceName,
					sourceType: md.sourceType,
					toolType: md.toolType,
					tableCount: md.tableCount,
					similarity: parseFloat(similarity.toFixed(4)),
				});
			}

			return { success: true, results };
		} catch (error: any) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[SOURCE-EMBED] Search failed: ${msg}`);
			return { success: false, error: msg, results: [] };
		}
	});

	console.log('✓ source-embeddings collection registered');
}
