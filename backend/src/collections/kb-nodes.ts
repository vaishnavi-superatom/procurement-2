import * as kbNodesService from '../../../database/postgres/src/project-data-db/kb-nodes';
import type { CollectionContext } from './types';
import { emitAgentEvent } from '@superatomai/sdk-node';

/**
 * Helper to build document text for embedding from kb-node data
 */
function buildDocumentText(title: string, content: string, category?: string, tags?: string[]): string {
	let documentText = title;
	if (category) documentText += `\nCategory: ${category}`;
	if (tags && tags.length > 0) documentText += `\nTags: ${tags.join(', ')}`;
	documentText += `\n\n${content}`;
	return documentText;
}

/**
 * Register knowledge base nodes CRUD collections
 */
export async function registerKbNodesCollections({ sdk, chromaManagers }: CollectionContext): Promise<void> {
	const kbChromaManager = chromaManagers.knowledgeBase;
	// Create knowledge base node
	sdk.addCollection('kbNodes', 'create', async (params: any) => {
		const { title, content, category, tags, type, createdBy } = params;

		if (!createdBy) {
			throw new Error('createdBy parameter is required');
		}

		if (!title) {
			throw new Error('title parameter is required');
		}

		if (!content) {
			throw new Error('content parameter is required');
		}

		try {
			console.log('[KB-NODES] Creating knowledge node');
			const result = await kbNodesService.createKbNode({
				title,
				content,
				category,
				tags: tags || [],
				type: type || 'query',
				createdBy
			});
			console.log('[KB-NODES] Knowledge node created successfully, ID:', result.data.id);
			// A new rule to translate into concepts. Debounced agent-side, so a
			// burst of edits settles into one run.
			emitAgentEvent('kb-node.changed', { id: result.data.id, op: 'create' });

			// Embed the kb-node for semantic search (only for 'query' type - global and user types don't need semantic search)
			const nodeType = type || 'query';
			if (nodeType === 'query') {
				(async () => {
					try {
						const isHealthy = await kbChromaManager.healthCheck();
						if (!isHealthy) {
							console.warn('[KB-NODES] ChromaDB not available, skipping embedding');
							return;
						}

						await kbChromaManager.createCollection(false);

						const documentText = buildDocumentText(title, content, category, tags);

						await kbChromaManager.add({
							ids: [`kb_${result.data.id}`],
							documents: [documentText],
							metadatas: [{
								kb_id: result.data.id,
								title,
								category: category || '',
								tags: JSON.stringify(tags || []),
								type: nodeType,
								created_at: new Date().toISOString()
							}]
						});

						console.log(`[KB-NODES] Embedded kb-node ${result.data.id} (type: query)`);
					} catch (embedErr: any) {
						console.warn('[KB-NODES] Failed to embed kb-node:', embedErr.message);
					}
				})();
			} else {
				console.log(`[KB-NODES] Skipping embedding for kb-node ${result.data.id} (type: ${nodeType} - only 'query' type nodes are semantically indexed)`);
			}

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[KB-NODES] Create failed:', errorMsg);
			throw new Error(`Failed to create knowledge node: ${errorMsg}`);
		}
	});

	// Get all knowledge base nodes
	sdk.addCollection('kbNodes', 'getAll', async (params: any) => {
		const { limit = 100, offset = 0 } = params || {};

		try {
			console.log('[KB-NODES] Fetching all knowledge nodes');
			const result = await kbNodesService.getAllKbNodes(Number(limit), Number(offset));
			console.log('[KB-NODES] Retrieved', result.count, 'knowledge nodes');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[KB-NODES] GetAll failed:', errorMsg);
			throw new Error(`Failed to get knowledge nodes: ${errorMsg}`);
		}
	});

	// Get single knowledge base node by ID
	sdk.addCollection('kbNodes', 'getOne', async (params: any) => {
		const { id } = params;

		if (!id) {
			throw new Error('Knowledge node ID is required');
		}

		try {
			console.log('[KB-NODES] Fetching knowledge node with ID:', id);
			const result = await kbNodesService.getKbNode({ id: Number(id) });
			console.log('[KB-NODES] Knowledge node retrieved successfully');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[KB-NODES] GetOne failed:', errorMsg);
			throw new Error(`Failed to get knowledge node: ${errorMsg}`);
		}
	});

	// Update knowledge base node
	sdk.addCollection('kbNodes', 'update', async (params: any) => {
		const { id, title, content, category, tags, type, updatedBy } = params;

		if (!id) {
			throw new Error('Knowledge node ID is required');
		}

		if (!updatedBy) {
			throw new Error('updatedBy parameter is required');
		}

		try {
			console.log('[KB-NODES] Updating knowledge node ID:', id);
			const result = await kbNodesService.updateKbNode({
				id: Number(id),
				title,
				content,
				category,
				tags,
				type,
				updatedBy
			});
			console.log('[KB-NODES] Knowledge node updated successfully');
			// An edited rule may correct a concept already in use — the agent
			// proposes a revision rather than rewriting it. Deletes deliberately
			// emit nothing: the node is gone, so the run would read an empty input
			// and cost a full turn for no output.
			emitAgentEvent('kb-node.changed', { id: Number(id), op: 'update' });

			// Update embedding (only for 'query' type - async, don't block)
			// If type changed from 'query' to something else, remove the embedding
			(async () => {
				try {
					const isHealthy = await kbChromaManager.healthCheck();
					if (!isHealthy) {
						console.warn('[KB-NODES] ChromaDB not available, skipping embedding update');
						return;
					}

					await kbChromaManager.createCollection(false);

					// Get the full updated node
					const updatedNode = result.data;
					const nodeType = updatedNode.type || 'query';

					if (nodeType === 'query') {
						// Build document text and upsert embedding
						const documentText = buildDocumentText(
							updatedNode.title,
							updatedNode.content,
							updatedNode.category || undefined,
							updatedNode.tags || []
						);

						const createdAt = updatedNode.createdAt
							? String(updatedNode.createdAt)
							: new Date().toISOString();

						await kbChromaManager.upsert({
							ids: [`kb_${id}`],
							documents: [documentText],
							metadatas: [{
								kb_id: Number(id),
								title: updatedNode.title,
								category: updatedNode.category || '',
								tags: JSON.stringify(updatedNode.tags || []),
								type: nodeType,
								created_at: createdAt
							}]
						});

						console.log(`[KB-NODES] Updated embedding for kb-node ${id} (type: query)`);
					} else {
						// Type is not 'query' - remove any existing embedding (type may have changed)
						try {
							await kbChromaManager.delete([`kb_${id}`]);
							console.log(`[KB-NODES] Removed embedding for kb-node ${id} (type changed to: ${nodeType})`);
						} catch {
							// Embedding might not exist, that's fine
						}
					}
				} catch (embedErr: any) {
					console.warn('[KB-NODES] Failed to update kb-node embedding:', embedErr.message);
				}
			})();

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[KB-NODES] Update failed:', errorMsg);
			throw new Error(`Failed to update knowledge node: ${errorMsg}`);
		}
	});

	// Delete knowledge base node
	sdk.addCollection('kbNodes', 'delete', async (params: any) => {
		const { id } = params;

		if (!id) {
			throw new Error('Knowledge node ID is required');
		}

		try {
			console.log('[KB-NODES] Deleting knowledge node ID:', id);
			const result = await kbNodesService.deleteKbNode({ id: Number(id) });
			console.log('[KB-NODES] Knowledge node deleted successfully');

			// Remove embedding from ChromaDB (async, don't block)
			(async () => {
				try {
					const isHealthy = await kbChromaManager.healthCheck();
					if (!isHealthy) {
						console.warn('[KB-NODES] ChromaDB not available, skipping embedding removal');
						return;
					}

					await kbChromaManager.createCollection(false);
					await kbChromaManager.delete([`kb_${id}`]);

					console.log(`[KB-NODES] Removed embedding for kb-node ${id}`);
				} catch (embedErr: any) {
					console.warn('[KB-NODES] Failed to remove kb-node embedding:', embedErr.message);
				}
			})();

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[KB-NODES] Delete failed:', errorMsg);
			throw new Error(`Failed to delete knowledge node: ${errorMsg}`);
		}
	});

	// Search knowledge base nodes
	sdk.addCollection('kbNodes', 'search', async (params: any) => {
		const { query, category, tags, type, createdBy, limit = 50, offset = 0 } = params;

		try {
			console.log('[KB-NODES] Searching knowledge nodes with query:', query);
			const result = await kbNodesService.searchKbNodes({
				query,
				category,
				tags,
				type,
				createdBy: createdBy || undefined,
				limit: Number(limit),
				offset: Number(offset)
			});
			console.log('[KB-NODES] Search returned', result.count, 'knowledge nodes');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[KB-NODES] Search failed:', errorMsg);
			throw new Error(`Failed to search knowledge nodes: ${errorMsg}`);
		}
	});

	// Get knowledge base nodes by category
	sdk.addCollection('kbNodes', 'getByCategory', async (params: any) => {
		const { category, limit = 50, offset = 0 } = params;

		if (!category) {
			throw new Error('category is required');
		}

		try {
			console.log('[KB-NODES] Fetching knowledge nodes for category:', category);
			const result = await kbNodesService.getKbNodesByCategory({
				category,
				limit: Number(limit),
				offset: Number(offset)
			});
			console.log('[KB-NODES] Retrieved', result.count, 'knowledge nodes');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[KB-NODES] GetByCategory failed:', errorMsg);
			throw new Error(`Failed to get knowledge nodes by category: ${errorMsg}`);
		}
	});

	// Get knowledge base nodes by user
	sdk.addCollection('kbNodes', 'getByUser', async (params: any) => {
		const { userId, limit = 50, offset = 0 } = params;

		if (!userId) {
			throw new Error('userId is required');
		}

		try {
			console.log('[KB-NODES] Fetching knowledge nodes for user:', userId);
			const result = await kbNodesService.getKbNodesByUser({
				userId,
				limit: Number(limit),
				offset: Number(offset)
			});
			console.log('[KB-NODES] Retrieved', result.count, 'knowledge nodes');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[KB-NODES] GetByUser failed:', errorMsg);
			throw new Error(`Failed to get knowledge nodes by user: ${errorMsg}`);
		}
	});

	// Get all categories
	sdk.addCollection('kbNodes', 'getCategories', async () => {
		try {
			console.log('[KB-NODES] Fetching all categories');
			const result = await kbNodesService.getAllCategories();
			console.log('[KB-NODES] Retrieved', result.count, 'categories');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[KB-NODES] GetCategories failed:', errorMsg);
			throw new Error(`Failed to get categories: ${errorMsg}`);
		}
	});

	// Get all tags
	sdk.addCollection('kbNodes', 'getTags', async () => {
		try {
			console.log('[KB-NODES] Fetching all tags');
			const result = await kbNodesService.getAllTags();
			console.log('[KB-NODES] Retrieved', result.count, 'tags');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[KB-NODES] GetTags failed:', errorMsg);
			throw new Error(`Failed to get tags: ${errorMsg}`);
		}
	});

	// Sync all kb-nodes to ChromaDB
	sdk.addCollection('kbNodes', 'syncAll', async () => {
		try {
			const isHealthy = await kbChromaManager.healthCheck();
			if (!isHealthy) {
				console.warn('[KB-NODES-SYNC] ChromaDB server is not running, skipping sync');
				return {
					success: false,
					error: 'ChromaDB server is not available'
				};
			}

			const allNodesResult = await kbNodesService.getAllKbNodes(10000, 0);

			if (!allNodesResult.success || !allNodesResult.data) {
				console.warn('[KB-NODES-SYNC] Failed to fetch kb-nodes');
				return {
					success: false,
					error: 'Failed to fetch kb-nodes from database'
				};
			}

			const nodes = allNodesResult.data;

			// Filter to only 'query' type nodes (global and user types don't need semantic search)
			const queryNodes = nodes.filter((node: any) => (node.type || 'query') === 'query');

			if (nodes.length === 0) {
				console.log(`[KB-NODES-SYNC] No kb-nodes to sync`);
			} else {
				console.log(`[KB-NODES-SYNC] ${nodes.length} total (${queryNodes.length} query-type will be embedded, ${nodes.length - queryNodes.length} skipped)`);
			}

			if (queryNodes.length === 0) {
				return {
					success: true,
					message: 'No query-type kb-nodes to sync',
					count: 0
				};
			}

			// Check if collection already has the right number of entries.
			// If so, skip the delete + re-embed cycle to avoid unnecessary
			// re-embedding on every restart.
			try {
				await kbChromaManager.createCollection(false);
				const existingCount = await kbChromaManager.getCollectionCount();
				if (existingCount === queryNodes.length) {
					console.log(`[KB-NODES-SYNC] Collection already has ${existingCount} entries — skipping re-embed`);
					return {
						success: true,
						message: `Collection already in sync (${existingCount} entries)`,
						count: existingCount
					};
				}
				console.log(`[KB-NODES-SYNC] Collection has ${existingCount} entries but need ${queryNodes.length} — re-syncing`);
			} catch {
				// Collection might not exist yet
			}

			try {
				await kbChromaManager.deleteCollection();
				console.log('[KB-NODES-SYNC] Deleted existing knowledge_base collection');
			} catch {
				// Collection might not exist
			}

			await kbChromaManager.createCollection(false);

			const ids: string[] = [];
			const documents: string[] = [];
			const metadatas: any[] = [];

			for (const node of queryNodes) {
				const documentText = buildDocumentText(
					node.title,
					node.content,
					node.category || undefined,
					node.tags || []
				);

				if (!documentText.trim()) continue;

				const createdAt = node.createdAt
					? String(node.createdAt)
					: new Date().toISOString();

				ids.push(`kb_${node.id}`);
				documents.push(documentText);
				metadatas.push({
					kb_id: node.id,
					title: node.title,
					category: node.category || '',
					tags: JSON.stringify(node.tags || []),
					type: 'query',
					created_at: createdAt
				});
			}

			if (ids.length === 0) {
				console.log('[KB-NODES-SYNC] No valid query-type kb-nodes to embed');
				return {
					success: true,
					message: 'No valid query-type kb-nodes to embed',
					count: 0
				};
			}

			console.log(`[KB-NODES-SYNC] Embedding ${ids.length} query-type kb-nodes...`);
			await kbChromaManager.add({
				ids,
				documents,
				metadatas
			});

			console.log(`[KB-NODES-SYNC] Successfully synced ${ids.length} query-type kb-nodes`);

			return {
				success: true,
				message: `Synced ${ids.length} query-type kb-nodes`,
				count: ids.length
			};
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[KB-NODES-SYNC] Sync failed:', errorMsg);
			return {
				success: false,
				error: errorMsg
			};
		}
	});

}

/**
 * Run kb-nodes sync on startup
 */
export async function syncKbNodesOnStartup(sdk: any): Promise<void> {
	try {
		const syncHandler = sdk['collections']?.['kbNodes']?.['syncAll'];
		if (syncHandler) {
			const result = await syncHandler();
			// Success logs come from inside the sync handler — only surface errors here
			if (!result.success) {
				console.warn('[STARTUP] KB-nodes sync failed:', result.error);
			}
		}
	} catch (err: any) {
		console.warn('[STARTUP] Failed to sync kb-nodes:', err.message);
	}
}
