/**
 * Schema Embeddings Collection
 *
 * One embedding per table in a source. Lets the MainAgent do a vector
 * search against table-level metadata BEFORE dispatching the SourceAgent,
 * so SourceAgents for large/very_large sources can skip `search_schema`
 * iterations and write SQL directly against pre-resolved tables.
 *
 * Document shape:
 *   text: "schema.tableName [N rows] — desc. Columns: colA (TEXT){samples}, colB (NUMBER), ..."
 *   metadata: { projectId, sourceId, sourceType, sourceName, tableName, rowCount, updatedAt }
 *
 * Search is metadata-filtered by sourceId so a single collection serves all sources.
 */

import type { CollectionContext } from './types';
import type { ChromaManager } from '../../../database/chromadb/src/chroma-manager';
import { createHash } from 'crypto';

interface TableMetadata {
	fullName: string;
	rowCount?: number;
	description?: string;
	// Entity-level semantic enrichment (from the semantic model). When `embedText`
	// is present it is used as the embedding text instead of the name+columns fallback.
	semantic?: { summary?: string; synonyms?: string[]; embedText?: string };
	columns: Array<{
		name: string;
		type: string;
		isPrimaryKey?: boolean;
		isForeignKey?: boolean;
		sampleValues?: any[];
		valueVocabulary?: string[];   // real distinct values (from the semantic model / profile)
		// Curated, from a vetted kb-node/entity_map/concepts rule — see buildTableDescription.
		// Never a fresh/guessed description (that's the exact mistake that got stripped
		// out of every column previously — see strip-semantic-model-descriptions.ts).
		description?: string;
	}>;
}

/**
 * Compute a cheap, stable fingerprint of the table set for freshness checks.
 * Includes table names, row counts, and column names — if anything material
 * about the schema changed, the fingerprint changes.
 */
export function computeSchemaFingerprint(tables: TableMetadata[]): string {
	const normalized = tables
		.map(t => ({
			name: t.fullName,
			rows: t.rowCount || 0,
			cols: t.columns.map(c => `${c.name}:${c.type}`).sort().join(','),
			// Include the embed content so applying/editing the semantic model (which
			// changes embedText but not structure) flips the fingerprint and triggers a
			// re-embed on the next run. Empty for raw schemas → structural-only, so it
			// still matches the structural fingerprint the semantic model stamps.
			sem: t.semantic?.embedText
				? createHash('sha1').update(t.semantic.embedText).digest('hex').slice(0, 8)
				: '',
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	const json = JSON.stringify(normalized);
	return createHash('sha1').update(json).digest('hex').slice(0, 16);
}

// Track per-manager initialization — multiple ChromaManager instances can
// point at the same collection (one from SourceManager for upserts, one from
// CollectionContext for the SDK search handler). Each has its own internal
// `collection` field that must be populated before use.
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

/**
 * Build one embedding string for a table.
 * Keeps it compact enough for all-MiniLM-L6-v2 (≤384 tokens effectively).
 */
function buildTableDescription(table: TableMetadata): string {
	// Prefer the Claude-authored, retrieval-tuned embedText (+ synonyms + real value
	// vocabulary). This is what makes the user's natural-language intent match a
	// cryptic ERP table — the whole point of the semantic model.
	const sem = table.semantic;
	if (sem?.embedText) {
		const syn = sem.synonyms?.length ? `\nSynonyms: ${sem.synonyms.join(', ')}.` : '';
		// Columns with a curated description are the ones a documented business rule
		// actually depends on (join targets, eligibility flags, override fields) — the
		// embedText prose above is a free-text summary and does NOT reliably name them.
		// Render these explicitly, with type + a real sample, so they read as verified
		// schema, not just words mentioned in a sentence.
		const described = (table.columns || []).filter(c => c.description);
		const keyCols = described
			.map(c => `  ${c.name} (${c.type})${c.sampleValues?.length ? `{${c.sampleValues.slice(0, 3).join('|')}}` : ''} — ${c.description}`)
			.join('\n');
		const keyColsLine = keyCols ? `\nKey columns —\n${keyCols}` : '';
		const vocab = (table.columns || [])
			.filter(c => c.valueVocabulary && c.valueVocabulary.length && !c.description)
			.slice(0, 12)
			.map(c => `  ${c.name}: ${c.valueVocabulary!.slice(0, 8).join('|')}`)
			.join('\n');
		const vocabLine = vocab ? `\nExample values —\n${vocab}` : '';
		return `${table.fullName} — ${sem.embedText}${syn}${keyColsLine}${vocabLine}`;
	}

	const parts: string[] = [];
	const rowInfo = table.rowCount ? ` [${table.rowCount.toLocaleString()} rows]` : '';
	const desc = table.description ? ` — ${table.description}` : '';
	parts.push(`${table.fullName}${rowInfo}${desc}`);

	if (table.columns.length > 0) {
		const colDescs = table.columns.map(c => {
			let s = `${c.name} (${c.type})`;
			if (c.isPrimaryKey) s += '[PK]';
			else if (c.isForeignKey) s += '[FK]';
			if (c.sampleValues && c.sampleValues.length > 0 && c.sampleValues.length <= 10) {
				s += `{${c.sampleValues.join('|')}}`;
			}
			return s;
		});
		parts.push(`Columns:\n  ${colDescs.join(',\n  ')}`);
	}

	return parts.join('\n');
}

function makeId(sourceId: string, tableName: string): string {
	// Chromadb IDs are strings; keep them URL-safe
	return `tbl::${sourceId}::${tableName}`.replace(/[^a-zA-Z0-9:._-]/g, '_');
}

/**
 * Upsert per-table embeddings for a source. Replaces any prior entries
 * for the same (sourceId, tableName). Call after schema extraction.
 */
export async function upsertTablesForSource(
	manager: ChromaManager,
	params: {
		projectId: string;
		sourceId: string;
		sourceType: string;
		sourceName: string;
		tables: TableMetadata[];
		// Force a re-embed even when the structural fingerprint is unchanged. Needed when
		// the semantic model is (re)applied: the embed *content* (embedText) changed but
		// the table/column structure did not, so the fingerprint guard would otherwise skip.
		force?: boolean;
	}
): Promise<{ success: boolean; count: number; error?: string }> {
	const { projectId, sourceId, sourceType, sourceName, tables, force } = params;

	if (!tables || tables.length === 0) {
		return { success: true, count: 0 };
	}

	try {
		const ok = await ensureCollection(manager);
		if (!ok) return { success: false, count: 0, error: 'ChromaDB unhealthy' };

		// Freshness check: if stored fingerprint matches current schema, skip the upsert.
		// This avoids re-embedding 100s of tables on every backend restart. Bypassed when
		// `force` is set (semantic-model apply changes embed content, not structure).
		const fingerprint = computeSchemaFingerprint(tables);
		if (!force) {
			try {
				const existing = await manager.getByFilter({ sourceId }, 1);
				const storedFingerprint = existing.metadatas?.[0]?.schemaFingerprint;
				if (storedFingerprint && storedFingerprint === fingerprint) {
					console.log(`[SCHEMA-EMBED] Skipped ${sourceName} — fingerprint unchanged (${fingerprint})`);
					return { success: true, count: tables.length };
				}
			} catch {
				// Collection missing or empty — fall through to upsert
			}
		}

		// Clear prior entries for this source so stale tables don't linger.
		// Also delete any entries stored under the tool-ID variant (sourceId + "_query")
		// — a short-lived earlier version of this code stored under that key.
		try {
			await manager.deleteWhere({ sourceId });
		} catch {
			// Collection may be empty — ignore
		}
		try {
			await manager.deleteWhere({ sourceId: `${sourceId}_query` });
		} catch {
			// No legacy entries — ignore
		}

		const now = new Date().toISOString();
		const ids = tables.map(t => makeId(sourceId, t.fullName));
		const documents = tables.map(t => buildTableDescription(t));
		const metadatas = tables.map(t => ({
			projectId,
			sourceId,
			sourceType,
			sourceName,
			tableName: t.fullName,
			rowCount: t.rowCount || 0,
			columnCount: t.columns.length,
			schemaFingerprint: fingerprint,
			updatedAt: now,
		}));

		// Upsert in batches to avoid overwhelming the server
		const batchSize = 100;
		for (let i = 0; i < ids.length; i += batchSize) {
			await manager.upsert({
				ids: ids.slice(i, i + batchSize),
				documents: documents.slice(i, i + batchSize),
				metadatas: metadatas.slice(i, i + batchSize),
			});
		}

		console.log(`[SCHEMA-EMBED] Upserted ${tables.length} tables for ${sourceName} (${sourceId})`);
		return { success: true, count: tables.length };
	} catch (error: any) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[SCHEMA-EMBED] Upsert failed for ${sourceName}: ${msg}`);
		return { success: false, count: 0, error: msg };
	}
}

/**
 * Remove all table embeddings for a source.
 */
export async function deleteTablesForSource(
	manager: ChromaManager,
	sourceId: string
): Promise<void> {
	try {
		const ok = await ensureCollection(manager);
		if (!ok) return;
		await manager.deleteWhere({ sourceId });
		console.log(`[SCHEMA-EMBED] Deleted embeddings for source ${sourceId}`);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(`[SCHEMA-EMBED] Delete failed for ${sourceId}: ${msg}`);
	}
}

/**
 * Register SDK collection so the MainAgent (SDK-side) can search.
 *
 *   collections['schema-embeddings']['search']({ query, sourceId, topK? })
 *     → [{ tableName, similarity, description, rowCount, columnCount }]
 */
export async function registerSchemaEmbeddingsCollections(
	{ sdk, chromaManagers }: CollectionContext
): Promise<void> {
	const manager = chromaManagers.schemaTables;

	sdk.addCollection('schema-embeddings', 'search', async (params: {
		query: string;
		sourceId?: string;
		projectId?: string;
		topK?: number;
	}) => {
		const { query, sourceId, projectId, topK = 10 } = params;
		if (!query || query.trim().length === 0) {
			return { success: false, error: 'query is required', results: [] };
		}

		try {
			const ok = await ensureCollection(manager);
			if (!ok) return { success: false, error: 'ChromaDB unhealthy', results: [] };

			// sourceId is globally unique (includes a per-source hash), so projectId
			// scoping is unnecessary when sourceId is provided — and it avoids
			// ChromaDB's quirky $and filter syntax.
			let where: Record<string, any> | undefined;
			if (sourceId) {
				where = { sourceId };
			} else if (projectId) {
				where = { projectId };
			}

			// Debug: dump what's stored for this sourceId (costs almost nothing, metadata fetch)
			if (sourceId) {
				try {
					const sample = await manager.getByFilter({ sourceId }, 1);
					console.log(`[SCHEMA-EMBED-SEARCH] Sample metadata for sourceId=${sourceId}: found=${sample.ids.length}, storedSourceId=${sample.metadatas?.[0]?.sourceId || 'n/a'}`);
				} catch (probeErr) {
					console.log(`[SCHEMA-EMBED-SEARCH] Probe failed: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`);
				}
			}

			const chromaResults = await manager.queryWithFilter(query, topK, where);

			if (!chromaResults.ids?.[0] || chromaResults.ids[0].length === 0) {
				return { success: true, results: [] };
			}

			const results = [];
			for (let i = 0; i < chromaResults.ids[0].length; i++) {
				const md = (chromaResults.metadatas?.[0]?.[i] || {}) as any;
				const distance = chromaResults.distances?.[0]?.[i] ?? Number.MAX_VALUE;
				// ChromaDB's default is L2 (Euclidean squared), unbounded. Using
				// 1/(1+distance) gives a monotonic similarity in (0, 1] that works
				// for any metric. Same formula used by user-conversations search.
				const similarity = 1 / (1 + distance);
				results.push({
					tableName: md.tableName,
					sourceId: md.sourceId,
					sourceName: md.sourceName,
					sourceType: md.sourceType,
					description: chromaResults.documents?.[0]?.[i] || '',
					rowCount: md.rowCount,
					columnCount: md.columnCount,
					similarity: parseFloat(similarity.toFixed(4)),
				});
			}

			return { success: true, results };
		} catch (error: any) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[SCHEMA-EMBED] Search failed: ${msg}`);
			return { success: false, error: msg, results: [] };
		}
	});

	// Expose a backend-facing delete hook too (optional, useful when sources change)
	sdk.addCollection('schema-embeddings', 'deleteSource', async (params: { sourceId: string }) => {
		if (!params?.sourceId) return { success: false, error: 'sourceId required' };
		await deleteTablesForSource(manager, params.sourceId);
		return { success: true };
	});

	console.log('✓ schema-embeddings collection registered');
}
