import * as bookmarksService from '../../../database/postgres/src/project-data-db/bookmarks';
import type { DBUIBlock, SearchBookmarksParams } from '../../../database/postgres/src/project-data-db/bookmarks';
import type { CollectionContext } from './types';

// Cache for ChromaDB health status
let chromaHealthy: boolean | null = null;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL = 30000; // Re-check health every 30 seconds

/**
 * Register bookmarks CRUD and embedding collections
 */
export async function registerBookmarksCollections({ sdk, chromaManagers }: CollectionContext): Promise<void> {
	const bookmarksChromaManager = chromaManagers.bookmarks;

	const checkChromaHealth = async (): Promise<boolean> => {
		const now = Date.now();
		if (chromaHealthy !== null && (now - lastHealthCheck) < HEALTH_CHECK_INTERVAL) {
			return chromaHealthy;
		}

		try {
			chromaHealthy = await Promise.race([
				bookmarksChromaManager.healthCheck(),
				new Promise<boolean>((_, reject) =>
					setTimeout(() => reject(new Error('timeout')), 1000)
				)
			]);
			lastHealthCheck = now;
			return chromaHealthy;
		} catch {
			chromaHealthy = false;
			lastHealthCheck = now;
			return false;
		}
	};

	// Create bookmark
	sdk.addCollection('bookmarks', 'create', async (params: { userId: string; threadId?: string; name?: string; description?: string; uiblock: DBUIBlock }) => {
		const { userId, threadId, name, description, uiblock } = params;

		if (!userId) {
			throw new Error('userId parameter is required');
		}

		if (!uiblock) {
			throw new Error('uiblock parameter is required');
		}

		try {
			console.log('[BOOKMARKS] Creating bookmark for user:', userId);
			const result = await bookmarksService.createBookmark({
				userId,
				threadId,
				name,
				description,
				uiblock
			});
			console.log('[BOOKMARKS] Bookmark created successfully, ID:', result.data.id);

			// Embed the bookmark for semantic search (async, don't block)
			(async () => {
				try {
					const isHealthy = await bookmarksChromaManager.healthCheck();
					if (!isHealthy) {
						console.warn('[BOOKMARKS] ChromaDB not available, skipping embedding');
						return;
					}

					await bookmarksChromaManager.createCollection(false);

					// Extract searchable text from uiblock
					const userPrompt = uiblock.user_prompt || '';
					const textResponse = uiblock.analysis || '';
					const component = uiblock.component;

					let documentText = userPrompt;
					if (textResponse) documentText += `\n${textResponse}`;

					// Extract title and description from MultiComponentContainer's config
					if (component?.props?.config) {
						const config = component.props.config;
						if (config.title) documentText += `\nTitle: ${config.title}`;
						if (config.description) documentText += `\nDescription: ${config.description}`;
					}

					// Fallback to component-level metadata
					if (component) {
						if (component.displayName) documentText += `\n${component.displayName}`;
						if (component.description) documentText += `\n${component.description}`;
						if (component.keywords?.length) documentText += `\nKeywords: ${component.keywords.join(', ')}`;
					}

					if (!documentText.trim()) {
						console.warn('[BOOKMARKS] No searchable content in bookmark, skipping embedding');
						return;
					}

					await bookmarksChromaManager.add({
						ids: [`bookmark_${result.data.id}`],
						documents: [documentText],
						metadatas: [{
							bookmark_id: result.data.id,
							user_id: userId,
							user_prompt: userPrompt,
							type: 'bookmark',
							uiblock: JSON.stringify(uiblock)
						}]
					});

					console.log(`[BOOKMARKS] Embedded bookmark ${result.data.id} for user ${userId}`);
				} catch (embedErr: any) {
					console.warn('[BOOKMARKS] Failed to embed bookmark:', embedErr.message);
				}
			})();

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS] Create failed:', errorMsg);
			throw new Error(`Failed to create bookmark: ${errorMsg}`);
		}
	});

	// Get all bookmarks
	sdk.addCollection('bookmarks', 'getAll', async () => {
		try {
			console.log('[BOOKMARKS] Fetching all bookmarks');
			const result = await bookmarksService.getAllBookmarks();
			console.log('[BOOKMARKS] Retrieved', result.count, 'bookmarks');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS] GetAll failed:', errorMsg);
			throw new Error(`Failed to get bookmarks: ${errorMsg}`);
		}
	});

	// Get single bookmark by ID
	sdk.addCollection('bookmarks', 'getOne', async (params: any) => {
		const { id } = params;

		if (!id) {
			throw new Error('Bookmark ID is required');
		}

		try {
			console.log('[BOOKMARKS] Fetching bookmark with ID:', id);
			const result = await bookmarksService.getBookmark({ id: Number(id) });
			console.log('[BOOKMARKS] Bookmark retrieved successfully');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS] GetOne failed:', errorMsg);
			throw new Error(`Failed to get bookmark: ${errorMsg}`);
		}
	});

	// Update bookmark
	sdk.addCollection('bookmarks', 'update', async (params: { id: number; threadId?: string; name?: string; description?: string; uiblock?: DBUIBlock }) => {
		const { id, threadId, name, description, uiblock } = params;

		if (!id) {
			throw new Error('Bookmark ID is required');
		}

		try {
			console.log('[BOOKMARKS] Updating bookmark ID:', id);
			const result = await bookmarksService.updateBookmark({
				id: Number(id),
				threadId,
				name,
				description,
				uiblock
			});
			console.log('[BOOKMARKS] Bookmark updated successfully');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS] Update failed:', errorMsg);
			throw new Error(`Failed to update bookmark: ${errorMsg}`);
		}
	});

	// Delete bookmark
	sdk.addCollection('bookmarks', 'delete', async (params: any) => {
		const { id } = params;

		if (!id) {
			throw new Error('Bookmark ID is required');
		}

		try {
			console.log('[BOOKMARKS] Deleting bookmark ID:', id);
			const result = await bookmarksService.deleteBookmark({ id: Number(id) });
			console.log('[BOOKMARKS] Bookmark deleted successfully');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS] Delete failed:', errorMsg);
			throw new Error(`Failed to delete bookmark: ${errorMsg}`);
		}
	});

	// Embed a bookmark
	sdk.addCollection('bookmarks', 'embed', async (params: any) => {
		const { bookmarkId, userId, uiblock } = params;

		if (!bookmarkId) {
			throw new Error('bookmarkId is required');
		}

		if (!userId) {
			throw new Error('userId is required');
		}

		if (!uiblock) {
			throw new Error('uiblock is required');
		}

		try {
			const isHealthy = await bookmarksChromaManager.healthCheck();
			if (!isHealthy) {
				console.warn('[BOOKMARKS-EMBED] ChromaDB server is not running, skipping embedding');
				return {
					success: false,
					error: 'ChromaDB server is not available'
				};
			}

			await bookmarksChromaManager.createCollection(false);

			// Extract searchable text from uiblock
			const userPrompt = uiblock.userQuestion || uiblock.user_prompt || '';
			const textResponse = uiblock.textResponse || uiblock.analysis || '';
			const component = uiblock.component || uiblock.generatedComponentMetadata;

			let documentText = userPrompt;
			if (textResponse) documentText += `\n${textResponse}`;

			if (component?.props?.config) {
				const config = component.props.config;
				if (config.title) documentText += `\nTitle: ${config.title}`;
				if (config.description) documentText += `\nDescription: ${config.description}`;
			}

			if (component) {
				if (component.displayName) documentText += `\n${component.displayName}`;
				if (component.description) documentText += `\n${component.description}`;
				if (component.keywords?.length) documentText += `\nKeywords: ${component.keywords.join(', ')}`;
			}

			if (!documentText.trim()) {
				console.warn('[BOOKMARKS-EMBED] No searchable content in bookmark, skipping');
				return {
					success: false,
					error: 'No searchable content in bookmark'
				};
			}

			console.log(`[BOOKMARKS-EMBED] Embedding bookmark ${bookmarkId} for user ${userId}`);

			await bookmarksChromaManager.add({
				ids: [`bookmark_${bookmarkId}`],
				documents: [documentText],
				metadatas: [{
					bookmark_id: bookmarkId,
					user_id: userId,
					user_prompt: userPrompt,
					type: 'bookmark',
					uiblock: JSON.stringify(uiblock)
				}]
			});

			console.log(`[BOOKMARKS-EMBED] Successfully embedded bookmark ${bookmarkId}`);

			return {
				success: true,
				message: `Bookmark ${bookmarkId} embedded successfully`,
				bookmarkId
			};
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS-EMBED] Failed to embed bookmark:', errorMsg);
			return {
				success: false,
				error: errorMsg
			};
		}
	});

	// Remove bookmark embedding
	sdk.addCollection('bookmarks', 'removeEmbed', async (params: any) => {
		const { bookmarkId } = params;

		if (!bookmarkId) {
			throw new Error('bookmarkId is required');
		}

		try {
			const isHealthy = await bookmarksChromaManager.healthCheck();
			if (!isHealthy) {
				return { success: false, error: 'ChromaDB server is not available' };
			}

			await bookmarksChromaManager.createCollection(false);

			console.log(`[BOOKMARKS-EMBED] Bookmark ${bookmarkId} removal requested (not implemented)`);

			return {
				success: true,
				message: `Bookmark ${bookmarkId} removal requested`
			};
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS-EMBED] Failed to remove bookmark:', errorMsg);
			return { success: false, error: errorMsg };
		}
	});

	// Search bookmarks
	sdk.addCollection('bookmarks', 'search', async (params: any) => {
		const { prompt, userId, limit = 5 } = params;

		if (!prompt || prompt.trim().length === 0) {
			throw new Error('prompt is required');
		}

		if (!userId) {
			throw new Error('userId is required');
		}

		try {
			const isHealthy = await checkChromaHealth();
			if (!isHealthy) {
				return {
					success: false,
					suggestions: [],
					error: 'ChromaDB server is not available'
				};
			}

			console.log(`[BOOKMARKS-SEARCH] Searching bookmarks for user ${userId}: "${prompt.substring(0, 50)}..."`);

			let results;
			try {
				results = await bookmarksChromaManager.query(prompt, limit * 3);
			} catch (queryError: any) {
				if (queryError.message?.includes('does not exist') || queryError.message?.includes('not found')) {
					console.log('[BOOKMARKS-SEARCH] Collection not found, returning empty results');
					return {
						success: true,
						suggestions: [],
						message: 'No bookmarks embedded yet'
					};
				}
				throw queryError;
			}

			if (!results.ids[0] || results.ids[0].length === 0) {
				return {
					success: true,
					suggestions: [],
					message: 'No bookmarks available'
				};
			}

			const suggestions = [];
			for (let i = 0; i < results.ids[0].length && suggestions.length < limit; i++) {
				const metadata = results.metadatas[0][i] as any;

				if (String(metadata.user_id) !== String(userId)) {
					continue;
				}

				const distance = results.distances[0][i];
				const similarity = 1 / (1 + distance);

				const uiblock = JSON.parse(metadata.uiblock);

				suggestions.push({
					type: 'bookmark',
					bookmarkId: metadata.bookmark_id,
					userPrompt: metadata.user_prompt,
					uiblock,
					similarity: parseFloat(similarity.toFixed(4))
				});
			}

			console.log(`[BOOKMARKS-SEARCH] Found ${suggestions.length} matching bookmarks for user ${userId}`);

			return {
				success: true,
				suggestions,
				count: suggestions.length
			};
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS-SEARCH] Search failed:', errorMsg);
			chromaHealthy = null;
			return {
				success: false,
				suggestions: [],
				error: errorMsg
			};
		}
	});

	// Search bookmarks - returns multiple results for reranking
	sdk.addCollection('bookmarks', 'searchMultiple', async (params: any) => {
		const { prompt, userId, limit = 50, threshold = 0 } = params;

		if (!prompt || prompt.trim().length === 0) {
			throw new Error('prompt is required');
		}

		if (!userId) {
			throw new Error('userId is required');
		}

		try {
			const isHealthy = await checkChromaHealth();
			if (!isHealthy) {
				return [];
			}

			console.log(`[BOOKMARKS-SEARCH-MULTIPLE] Searching for user ${userId}: "${prompt.substring(0, 50)}..."`);

			let results;
			try {
				// Fetch a large pool of results for reranking
				results = await bookmarksChromaManager.query(prompt, limit);
			} catch (queryError: any) {
				if (queryError.message?.includes('does not exist') || queryError.message?.includes('not found')) {
					console.log('[BOOKMARKS-SEARCH-MULTIPLE] Collection not found');
					return [];
				}
				throw queryError;
			}

			if (!results.ids[0] || results.ids[0].length === 0) {
				return [];
			}

			const candidates = [];
			for (let i = 0; i < results.ids[0].length; i++) {
				const metadata = results.metadatas[0][i] as any;

				// Filter by user
				if (String(metadata.user_id) !== String(userId)) {
					continue;
				}

				const distance = results.distances[0][i];
				const similarity = 1 / (1 + distance);

				// Apply threshold filter (if threshold > 0)
				if (threshold > 0 && similarity < threshold) {
					continue;
				}

				const uiblock = JSON.parse(metadata.uiblock);

				candidates.push({
					type: 'bookmark',
					bookmarkId: metadata.bookmark_id,
					userPrompt: metadata.user_prompt,
					uiblock,
					similarity: parseFloat(similarity.toFixed(4))
				});
			}

			console.log(`[BOOKMARKS-SEARCH-MULTIPLE] Found ${candidates.length} candidates for user ${userId}`);

			return candidates;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS-SEARCH-MULTIPLE] Search failed:', errorMsg);
			chromaHealthy = null;
			return [];
		}
	});

	// Text search bookmarks using PostgreSQL full-text search
	sdk.addCollection('bookmarks', 'textSearch', async (params: { prompt: string; userId: string; limit?: number }) => {
		const { prompt, userId, limit = 5 } = params;

		if (!prompt || prompt.trim().length === 0) {
			throw new Error('prompt is required');
		}

		if (!userId) {
			throw new Error('userId is required');
		}

		try {
			console.log(`[BOOKMARKS-TEXTSEARCH] Searching bookmarks for user ${userId}: "${prompt.substring(0, 50)}..."`);

			const result = await bookmarksService.searchBookmarks({
				query: prompt,
				userId,
				limit
			});

			if (!result.success || !result.data) {
				return {
					success: true,
					suggestions: [],
					message: 'No bookmarks found'
				};
			}

			// Format results to match expected suggestion format
			const suggestions = result.data.map((bookmark: any) => {
				const uiblock = bookmark.uiblock as any;
				return {
					type: 'bookmark',
					bookmarkId: bookmark.id,
					userPrompt: uiblock?.user_prompt || '',
					uiblock,
					similarity: 1.0 // Full-text search doesn't have similarity scores, use 1.0
				};
			});

			console.log(`[BOOKMARKS-TEXTSEARCH] Found ${suggestions.length} matching bookmarks for user ${userId}`);

			return {
				success: true,
				suggestions,
				count: suggestions.length
			};
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS-TEXTSEARCH] Search failed:', errorMsg);
			return {
				success: false,
				suggestions: [],
				error: errorMsg
			};
		}
	});

	// Query bookmarks with filters
	sdk.addCollection('bookmarks', 'query', async (params: { filters?: { userId?: string; threadId?: string; name?: string }; limit?: number; sort?: 'ASC' | 'DESC' }) => {
		const { filters = {}, limit = 50, sort = 'DESC' } = params;

		try {
			console.log('[BOOKMARKS] Querying bookmarks with filters:', JSON.stringify(filters));
			const result = await bookmarksService.queryBookmarks({ filters, limit, sort });
			console.log(`[BOOKMARKS] Query returned ${result.count} bookmarks`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS] Query failed:', errorMsg);
			throw new Error(`Failed to query bookmarks: ${errorMsg}`);
		}
	});

	// Sync all bookmarks
	sdk.addCollection('bookmarks', 'syncAll', async () => {
		try {
			const isHealthy = await bookmarksChromaManager.healthCheck();
			if (!isHealthy) {
				console.warn('[BOOKMARKS-SYNC] ChromaDB server is not running, skipping sync');
				return {
					success: false,
					error: 'ChromaDB server is not available'
				};
			}

			const allBookmarksResult = await bookmarksService.getAllBookmarks();

			if (!allBookmarksResult.success || !allBookmarksResult.data) {
				console.warn('[BOOKMARKS-SYNC] Failed to fetch bookmarks');
				return {
					success: false,
					error: 'Failed to fetch bookmarks from database'
				};
			}

			const bookmarks = allBookmarksResult.data;

			if (bookmarks.length === 0) {
				console.log(`[BOOKMARKS-SYNC] No bookmarks to sync`);
				return {
					success: true,
					message: 'No bookmarks to sync',
					count: 0
				};
			}

			console.log(`[BOOKMARKS-SYNC] Found ${bookmarks.length} bookmarks to sync`);

			try {
				await bookmarksChromaManager.deleteCollection();
				console.log('[BOOKMARKS-SYNC] Deleted existing bookmarks collection');
			} catch {
				// Collection might not exist
			}

			await bookmarksChromaManager.createCollection(false);

			const ids: string[] = [];
			const documents: string[] = [];
			const metadatas: any[] = [];

			for (const bookmark of bookmarks) {
				const uiblock = bookmark.uiblock as any;
				if (!uiblock) continue;

				const userPrompt = uiblock.userQuestion || uiblock.user_prompt || '';
				const textResponse = uiblock.textResponse || uiblock.analysis || '';
				const component = uiblock.component || uiblock.generatedComponentMetadata;

				let documentText = userPrompt;
				if (textResponse) documentText += `\n${textResponse}`;

				if (component?.props?.config) {
					const config = component.props.config;
					if (config.title) documentText += `\nTitle: ${config.title}`;
					if (config.description) documentText += `\nDescription: ${config.description}`;
				}

				if (component) {
					if (component.displayName) documentText += `\n${component.displayName}`;
					if (component.description) documentText += `\n${component.description}`;
					if (component.keywords?.length) documentText += `\nKeywords: ${component.keywords.join(', ')}`;
				}

				if (!documentText.trim()) continue;

				ids.push(`bookmark_${bookmark.id}`);
				documents.push(documentText);
				metadatas.push({
					bookmark_id: bookmark.id,
					user_id: bookmark.userId,
					user_prompt: userPrompt,
					type: 'bookmark',
					uiblock: JSON.stringify(uiblock)
				});
			}

			if (ids.length === 0) {
				console.log('[BOOKMARKS-SYNC] No valid bookmarks to embed');
				return {
					success: true,
					message: 'No valid bookmarks to embed',
					count: 0
				};
			}

			console.log(`[BOOKMARKS-SYNC] Embedding ${ids.length} bookmarks...`);
			await bookmarksChromaManager.add({
				ids,
				documents,
				metadatas
			});

			console.log(`[BOOKMARKS-SYNC] Successfully synced ${ids.length} bookmarks`);

			return {
				success: true,
				message: `Synced ${ids.length} bookmarks`,
				count: ids.length
			};
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[BOOKMARKS-SYNC] Sync failed:', errorMsg);
			return {
				success: false,
				error: errorMsg
			};
		}
	});

}

/**
 * Run bookmarks sync on startup
 */
export async function syncBookmarksOnStartup(sdk: any): Promise<void> {
	try {
		const syncHandler = sdk['collections']?.['bookmarks']?.['syncAll'];
		if (syncHandler) {
			const result = await syncHandler();
			// Success logs come from inside the sync handler — only surface errors here
			if (!result.success) {
				console.warn('[STARTUP] Bookmarks sync failed:', result.error);
			}
		}
	} catch (err: any) {
		console.warn('[STARTUP] Failed to sync bookmarks:', err.message);
	}
}
