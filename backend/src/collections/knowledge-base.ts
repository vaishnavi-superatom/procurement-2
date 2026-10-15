import type { CollectionContext } from './types';
import * as kbNodesService from '../../../database/postgres/src/project-data-db/kb-nodes';

/**
 * Register knowledge base query collections
 */
export async function registerKnowledgeBaseCollections({ sdk, chromaManagers }: CollectionContext): Promise<void> {
	const chromaManager = chromaManagers.knowledgeBase;

	// Semantic search for 'query' type kb nodes only
	sdk.addCollection('knowledge-base', 'query', async (params: any) => {
		const { prompt, topK = 3 } = params;

		if (!prompt || prompt.trim().length === 0) {
			throw new Error('Prompt parameter is required');
		}

		try {
			// Check if ChromaDB server is healthy
			const isHealthy = await chromaManager.healthCheck();
			if (!isHealthy) {
				console.warn('[KNOWLEDGE-BASE] ChromaDB server is not running, returning empty context');
				return {
					content: '',
					metadata: {
						sources: []
					}
				};
			}

			// Initialize collection
			await chromaManager.createCollection();

			// Check if collection has documents
			const count = await chromaManager.getCollectionCount();
			if (count === 0) {
				console.warn('[KNOWLEDGE-BASE] ChromaDB collection is empty');
				return {
					content: '',
					metadata: {
						sources: []
					}
				};
			}

			// Query ChromaDB for relevant knowledge (only for 'query' type kb nodes)
			console.log(`[KNOWLEDGE-BASE] Querying for: "${prompt.substring(0, 50)}..."`);
			const results = await chromaManager.query(prompt, topK);

			// Format results for LLM context
			const sources = [];
			let formattedContent = '';

			for (let i = 0; i < results.ids[0].length; i++) {
				const metadata = results.metadatas[0][i];
				const document = results.documents[0][i];
				const distance = results.distances[0][i];
				const similarity = 1 - distance;

				sources.push({
					title: metadata.title,
					similarity: parseFloat(similarity.toFixed(4)),
					kb_id: metadata.kb_id,
					// The exact matched chunk, same text folded into `formattedContent`
					// below — kept per-node too so callers (e.g. the chat debug trace)
					// can snapshot precisely what each node contributed, not just its
					// title/id (which can change or be deleted later).
					content: document
				});

				formattedContent += `### ${metadata.title}\n`;
				formattedContent += `${document}\n\n`;
			}

			// Name each hit WITH its score. topK returns a fixed number whatever the
			// scores are, so the only way to judge whether a relevance floor is worth
			// having — and where to put it — is to see the real spread per question.
			// Now that the collection is cosine, `1 - distance` IS cosine similarity.
			const scored = sources
				.map(x => `${x.title} ${x.similarity.toFixed(3)}`)
				.join(' | ');
			console.log(`[KNOWLEDGE-BASE] Retrieved ${results.ids[0].length} documents (${formattedContent.length} chars): ${scored}`);

			return {
				content: formattedContent.trim(),
				metadata: {
					sources
				}
			};
		} catch (error: any) {
			let errorMsg = 'Unknown error';

			if (error instanceof Error) {
				errorMsg = error.message;
			} else if (error && typeof error === 'object') {
				errorMsg = error.message || error.error || JSON.stringify(error);
			}

			console.error('[KNOWLEDGE-BASE] Query failed:', errorMsg);

			// Return empty context instead of throwing - don't fail the entire request
			return {
				content: '',
				metadata: {
					sources: []
				}
			};
		}
	});


	// Get all global type kb nodes (always included in system prompts)
	sdk.addCollection('knowledge-base', 'getGlobal', async (params: any) => {
		const { limit = 100 } = params || {};

		try {
			console.log('[KNOWLEDGE-BASE] Fetching global kb nodes...');
			const result = await kbNodesService.searchKbNodes({
				type: 'global',
				limit: Number(limit)
			});

			if (!result.success || !result.data || result.data.length === 0) {
				console.log('[KNOWLEDGE-BASE] No global kb nodes found');
				return {
					content: '',
					nodes: [],
					count: 0
				};
			}

			// Format nodes for LLM context
			let formattedContent = '';
			for (const node of result.data) {
				formattedContent += `### ${node.title}\n`;
				if (node.category) formattedContent += `Category: ${node.category}\n`;
				formattedContent += `${node.content}\n\n`;
			}

			console.log(`[KNOWLEDGE-BASE] Retrieved ${result.data.length} global kb nodes`);

			return {
				content: formattedContent.trim(),
				nodes: result.data,
				count: result.data.length
			};
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error('[KNOWLEDGE-BASE] Get global kb nodes failed:', errorMsg);
			return {
				content: '',
				nodes: [],
				count: 0
			};
		}
	});


	// Get user-specific kb nodes (based on createdBy field)
	sdk.addCollection('knowledge-base', 'getByUser', async (params: any) => {
		const { userId, limit = 100 } = params;

		if (!userId) {
			console.warn('[KNOWLEDGE-BASE] No userId provided for user kb nodes');
			return {
				content: '',
				nodes: [],
				count: 0
			};
		}

		try {
			console.log(`[KNOWLEDGE-BASE] Fetching user kb nodes for userId: ${userId}...`);
			const result = await kbNodesService.searchKbNodes({
				type: 'user',
				createdBy: userId,
				limit: Number(limit)
			});

			if (!result.success || !result.data || result.data.length === 0) {
				console.log(`[KNOWLEDGE-BASE] No user kb nodes found for userId: ${userId}`);
				return {
					content: '',
					nodes: [],
					count: 0
				};
			}

			// Format nodes for LLM context
			let formattedContent = '';
			for (const node of result.data) {
				formattedContent += `### ${node.title}\n`;
				if (node.category) formattedContent += `Category: ${node.category}\n`;
				formattedContent += `${node.content}\n\n`;
			}

			console.log(`[KNOWLEDGE-BASE] Retrieved ${result.data.length} user kb nodes for userId: ${userId}`);

			return {
				content: formattedContent.trim(),
				nodes: result.data,
				count: result.data.length
			};
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error('[KNOWLEDGE-BASE] Get user kb nodes failed:', errorMsg);
			return {
				content: '',
				nodes: [],
				count: 0
			};
		}
	});

}
