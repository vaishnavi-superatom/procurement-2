import * as userConversationsService from '../../../database/postgres/src/project-data-db/user-conversations';
import { emitAgentEvent } from '@superatomai/sdk-node';
import type { CollectionContext } from './types';
import { queryCache, ScriptStore, runScript, ThreadManager } from '@superatomai/sdk-node';
import { scriptRecipeStore } from './script-recipes';
import { getAllTools } from '../tools';
import { deleteAttachmentsFromR2 } from '../coding-agents/attachments';

// Caps both how long getThreadConversations will wait on a narrative refresh
// (see the Promise.race below) and how long each re-executed script itself is
// allowed to run. Without the second part, a refresh we've already stopped
// waiting on keeps its subprocess alive for the script runner's full default
// (60s), holding one of the process-wide SCRIPT_MAX_CONCURRENCY slots that
// live agent turns and other users' thread-opens also compete for.
// Was 8000 — confirmed too tight live: a thread with several bound answers
// fires all of them at once, the script-runner's own concurrency limit queues
// the rest behind whichever runs first, and a genuinely fine query (4-9.5s on
// this account) then blows the deadline just from queueing wait, not runtime
// — surfacing as a visible "Error loading KPI" in the UI, not just latency.
const REFRESH_NARRATIVES_TIMEOUT_MS = 20000;

/**
 * Re-derive the narrative for saved answers whose script is still on disk.
 *
 * An answer is stored as two halves that age differently: the component data is
 * an encrypted queryId that RE-EXECUTES on a cache miss, while `analysis` is
 * frozen text. Once the source moves, a reload shows a fresh table under a stale
 * sentence — the narrative can name a different leader than the table beneath it.
 *
 * Regenerating costs one subprocess per bound row, so rows run CONCURRENTLY —
 * the semaphore in ScriptRunner already bounds real parallelism.
 *
 * Never throws and never blanks an answer: any failure keeps the stored text,
 * because a slightly stale narrative beats no narrative.
 */
async function refreshNarratives(rows: any[]): Promise<void> {
	const bound = (rows || []).filter(r => r?.response?.scriptBinding?.recipeId);
	if (!bound.length) return;

	const store = new ScriptStore({ store: scriptRecipeStore });
	const tools = getAllTools() as any;

	// Group by (recipeId, params) FIRST. Multiple saved answers in the same
	// thread routinely bind to the identical recipe+params (a question asked
	// more than once, or several answers re-bound after the same script edit)
	// — confirmed live: one thread fired the SAME script 3x concurrently.
	// Running it once per unique key instead of once per row means one fewer
	// script-runner concurrency slot held, one fewer live query against the
	// source, and shorter queueing wait for every OTHER script competing for
	// that same slot in this refresh batch.
	const groups = new Map<string, any[]>();
	for (const row of bound) {
		const binding = row.response.scriptBinding;
		const key = `${binding.recipeId}::${JSON.stringify(binding.params || {})}`;
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
	}

	await Promise.all(Array.from(groups.values()).map(async (groupRows) => {
		const binding = groupRows[0].response.scriptBinding;
		try {
			const recipe = await store.get(binding.recipeId);
			if (!recipe?.scriptBody) return;               // recipe deleted — keep stored text
			// mode 'data' runs getData AND getAnalysis in one pass, so the narrative
			// is derived from the same rows the components will render. Bound to the
			// same deadline the RPC handler waits on — a slow/live-query script is
			// killed here instead of idling past the point it can still help.
			const result = await runScript(recipe, store.getScriptPath(recipe), binding.params || {}, {
				externalTools: tools,
				timeoutMs: REFRESH_NARRATIVES_TIMEOUT_MS,
			});
			const fresh = result?.analysis?.analysis;
			if (!result.success || !fresh) return;         // older recipe has no getAnalysis

			// Apply the one fresh result to every row that shares this recipe+params.
			for (const row of groupRows) {
				// Replace ONLY the program-generated half. The streamed narration
				// ("Now I'll query…") records what happened and must not be rewritten;
				// the answer is a function of the data and must track it. `programAnswer`
				// is the verbatim old text, so this is an exact swap, not a parse.
				const prev = row.response.programAnswer;
				if (!prev) continue;                             // saved before the split — leave it alone
				if (prev === fresh) continue;                    // data unchanged — nothing to do

				const swap = (t: any) => typeof t === 'string' && t.includes(prev) ? t.replace(prev, fresh) : t;
				row.response.analysis = swap(row.response.analysis);
				row.analysis = swap(row.analysis);
				row.response.programAnswer = fresh;
				console.log(`[USER-CONVERSATIONS] narrative refreshed for conversation ${row.id} ("${binding.name}")`);
			}
		} catch (err) {
			console.warn(`[USER-CONVERSATIONS] narrative refresh failed for recipe ${binding.recipeId}: ${err instanceof Error ? err.message : err}`);
		}
	}));
}

/**
 * Register user conversations and conversation history collections
 */
export async function registerUserConversationsCollections({ sdk, chromaManagers }: CollectionContext): Promise<void> {
	const conversationChromaManager = chromaManagers.conversations;

	/**
	 * What this backend's chat supports, for a UI to switch features on.
	 *
	 * An older backend has no such operation and answers "not found", so its
	 * absence is itself the answer: the feature stays off. Reads nothing, so it
	 * is safe to call on connect.
	 */
	sdk.addCollection('user-conversations', 'capabilities', async () => ({
		/* Files attached to a question are loaded for the answer agent, up to a
		 * per-chat limit. A UI offers its "attach files" control only when this is true. */
		attachments: true,
	}));

	// Create conversation
	sdk.addCollection('user-conversations', 'create', async (params: any) => {
		const { userId, userPrompt, response, threadId, status, agentId, attachments } = params;
		if (!userId) throw new Error('userId required');
		if (!userPrompt) throw new Error('userPrompt required');
		if (!response) throw new Error('response required');
		try {
			const result = await userConversationsService.createConversation({
				userId,
				userPrompt,
				// The files sent with this question ride on its response, so a reloaded
				// thread shows them on the right message. (The thread's own list of
				// files is kept on `threads.attachments`.)
				response: Array.isArray(attachments) && attachments.length ? { ...response, attachments } : response,
				threadId,
				status,
				agentId
			});

			// Wakes any agent counting answered questions (concept-builder fires
			// every Nth). Only successful turns count: an errored or aborted answer
			// is evidence of nothing, and would still advance the counter.
			// Fire-and-forget by contract — never throws, never blocks this reply.
			if ((status ?? 'success') === 'success') {
				emitAgentEvent('conversation.answered', { threadId, userId });
			}

			return result;
		} catch (error: any) {
			throw error;
		}
	});

	// Get user conversations
	sdk.addCollection('user-conversations', 'getUserConversations', async (params: any) => {
		const { userId, limit = 50, offset = 0 } = params;
		if (!userId) throw new Error('userId required');
		const result = await userConversationsService.getUserConversations({
			userId,
			limit: Number(limit),
			offset: Number(offset)
		});
		return result;
	});

	// List a user's threads, grouped (for the sidebar Chats tab)
	sdk.addCollection('user-conversations', 'getUserThreads', async (params: any) => {
		const { userId, agentId, limit = 50, offset = 0 } = params;
		if (!userId) throw new Error('userId required');
		if (!agentId) throw new Error('agentId required');
		const result = await userConversationsService.getUserThreads({
			userId,
			agentId,
			limit: Number(limit),
			offset: Number(offset)
		});
		return result;
	});

	// One thread's title, config and attached files — the UI reads config.dashboardId
	// to open it on its dashboard, and attachments to show its files and how many more fit.
	sdk.addCollection('user-conversations', 'getThread', async (params: any) => {
		const { userId, threadId, agentId } = params;
		if (!userId) throw new Error('userId required');
		if (!threadId) throw new Error('threadId required');
		if (!agentId) throw new Error('agentId required');
		return userConversationsService.getThread({ userId, threadId, agentId });
	});

	// Get conversations within a thread, paginated newest-first (for "load older")
	// Lean read for MainAgent's own CONVERSATION_HISTORY — no refreshNarratives
	// side effect (see getRecentConversationsForContext's own doc comment for
	// why that matters here specifically). status='aborted' rows are already
	// excluded by the DB query itself.
	sdk.addCollection('user-conversations', 'getRecentForContext', async (params: any) => {
		const { userId, threadId, limit = 5 } = params;
		if (!userId) throw new Error('userId required');
		if (!threadId) throw new Error('threadId required');
		return userConversationsService.getRecentConversationsForContext({
			userId,
			threadId,
			limit: Number(limit),
		});
	});

	sdk.addCollection('user-conversations', 'getThreadConversations', async (params: any) => {
		const { userId, threadId, agentId, limit = 5, offset = 0 } = params;
		if (!userId) throw new Error('userId required');
		if (!threadId) throw new Error('threadId required');
		if (!agentId) throw new Error('agentId required');
		const result = await userConversationsService.getThreadConversations({
			userId,
			threadId,
			agentId,
			limit: Number(limit),
			offset: Number(offset)
		});
		// refreshNarratives mutates result.data in place and has no DB write of its
		// own — its whole effect is "swap the fresh text in before this response
		// goes out." So it must still be awaited (dropping the await entirely would
		// make the refresh a no-op, since it'd finish after the response already
		// went out). But it can re-execute bound scripts, including live external
		// queries that would otherwise take up to a minute — far longer than a
		// thread-open should block for. Bound the wait: apply the fresh narrative
		// when it's fast enough, otherwise return the stored (possibly slightly
		// stale) text rather than hang the request. This race is just a backstop —
		// refreshNarratives' own runScript call is given the same deadline as its
		// timeoutMs, so in practice it resolves (fresh or failed) right around
		// here rather than lingering in the background afterward.
		await Promise.race([
			refreshNarratives((result as any)?.data ?? []),
			new Promise<void>((resolve) => setTimeout(resolve, REFRESH_NARRATIVES_TIMEOUT_MS)),
		]).catch((err) => {
			console.warn(`[USER-CONVERSATIONS] narrative refresh failed for thread ${threadId}: ${err instanceof Error ? err.message : err}`);
		});
		return result;
	});

	// Full-text search across a user's own prompts AND AI answers, for the
	// sidebar search modal. Returns offsetInThread per row so the frontend can
	// jump straight to the matched message inside its thread.
	sdk.addCollection('user-conversations', 'searchMessages', async (params: any) => {
		const { userId, agentId, query, limit = 20, offset = 0 } = params;
		if (!userId) throw new Error('userId required');
		if (!agentId) throw new Error('agentId required');
		if (!query) throw new Error('query required');
		console.log(`[USER-CONVERSATIONS] searchMessages userId=${userId} query=${JSON.stringify(query)} limit=${limit} offset=${offset}`);
		try {
			const result = await userConversationsService.searchUserConversations({
				userId,
				agentId,
				query,
				limit: Number(limit),
				offset: Number(offset)
			});
			console.log(`[USER-CONVERSATIONS] searchMessages -> ${result.count} row(s), total=${result.total}`);
			return result;
		} catch (error: any) {
			console.error('[USER-CONVERSATIONS] searchMessages failed:', error);
			throw error;
		}
	});

	// Fetch a single conversation by its own row id — used to look up the exact
	// saved response for an analytics event via its conversationId.
	sdk.addCollection('user-conversations', 'getById', async (params: any) => {
		const { id } = params;
		if (!id) throw new Error('id required');
		try {
			return await userConversationsService.getConversation({ id: Number(id) });
		} catch (error: any) {
			return { success: false, data: null, message: error?.message };
		}
	});

	/**
	 * Evict one conversation's footprint from the in-memory Thread it belongs
	 * to. Every delete-* handler below already removes the Postgres row and
	 * the ChromaDB embedding, but nothing previously touched ThreadManager's
	 * in-memory Thread objects — so a conversation deleted mid-thread kept
	 * surfacing to ScriptMatcher (its "editable scripts" list and
	 * conversation-history context) for as long as the backend process
	 * stayed up, even with the row and embedding both confirmed gone from
	 * Postgres and Chroma. Reproduced live: delete a single conversation via
	 * deleteByUserPrompt (Postgres + Chroma both logged as deleted), ask the
	 * exact same question again in the SAME thread — ScriptMatcher still
	 * listed the answer's script under "editable scripts" and matched tier
	 * "high" against it, because nothing had told the in-memory Thread the
	 * conversation was gone. Thread.removeUIBlock() already existed in
	 * sdk-nodejs for exactly this; it was just never called from here.
	 * Best-effort: a thread already evicted by TTL, or never loaded in THIS
	 * process, simply has nothing to remove.
	 */
	function evictUIBlockFromMemory(uiBlockId: string | undefined): void {
		if (!uiBlockId) return;
		const found = ThreadManager.getInstance().findUIBlockById(uiBlockId);
		if (found) {
			found.thread.removeUIBlock(uiBlockId);
			console.log(`[USER-CONVERSATIONS] Removed uiBlockId ${uiBlockId} from in-memory thread ${found.thread.getId()}`);
		}
	}

	// Delete a single conversation (from postgres and ChromaDB)
	sdk.addCollection('user-conversations', 'delete', async (params: any) => {
		const { id, clearCache = true } = params;
		if (!id) throw new Error('conversation id required');

		// Helper to get cache key for a query (matches sdk-nodejs logic)
		const getQueryCacheKey = (query: any): string => {
			if (typeof query === 'string') {
				return query;
			} else if (query?.sql) {
				const values = query.values || query.params;
				if (values && Object.keys(values).length > 0) {
					return JSON.stringify({ sql: query.sql, values });
				}
				return query.sql;
			}
			return '';
		};

		// Helper to recursively extract queries from components
		const extractQueries = (component: any, queries: string[]) => {
			if (!component) return;

			// Check if this component has a query in props
			if (component?.props?.query) {
				const cacheKey = getQueryCacheKey(component.props.query);
				if (cacheKey) {
					queries.push(cacheKey);
				}
			}

			// Check nested components array (direct children)
			if (Array.isArray(component?.components)) {
				for (const child of component.components) {
					extractQueries(child, queries);
				}
			}

			// Check MultiComponentContainer structure: props.config.components
			if (Array.isArray(component?.props?.config?.components)) {
				for (const child of component.props.config.components) {
					extractQueries(child, queries);
				}
			}

			// Check props.components (another common nesting pattern)
			if (Array.isArray(component?.props?.components)) {
				for (const child of component.props.components) {
					extractQueries(child, queries);
				}
			}
		};

		try {
			// First, get the conversation to retrieve the uiBlockId and component queries
			const conversation = await userConversationsService.getConversation({ id: Number(id) });
			const uiblock = conversation.data?.response as any;
			const uiBlockId = uiblock?.id;

			// Extract queries from component for cache deletion
			// DB structure: uiblock.component = generatedComponentMetadata (the component object)
			const queriesToDelete: string[] = [];
			extractQueries(uiblock?.component, queriesToDelete);

			console.log(`[USER-CONVERSATIONS] Found ${queriesToDelete.length} queries to delete from cache for conversation ${id}`);

			// Delete from PostgreSQL
			const result = await userConversationsService.deleteConversation({ id: Number(id) });
			console.log(`[USER-CONVERSATIONS] Deleted conversation ${id} from PostgreSQL`);

			// Delete from ChromaDB if we have the uiBlockId
			if (uiBlockId && conversationChromaManager) {
				try {
					const isHealthy = await conversationChromaManager.healthCheck();
					if (isHealthy) {
						await conversationChromaManager.createCollection();
						await conversationChromaManager.delete([uiBlockId]);
						console.log(`[USER-CONVERSATIONS] Deleted embedding ${uiBlockId} from ChromaDB`);
					}
				} catch (chromaError) {
					console.warn(`[USER-CONVERSATIONS] Failed to delete from ChromaDB:`, chromaError);
					// Don't throw - postgres deletion succeeded
				}
			}

			// Evict from the in-memory thread too — see evictUIBlockFromMemory's doc comment.
			evictUIBlockFromMemory(uiBlockId);

			// Clear only the specific queries from cache
			let cacheDeletedCount = 0;
			if (clearCache && queriesToDelete.length > 0) {
				for (const queryKey of queriesToDelete) {
					queryCache.delete(queryKey);
					cacheDeletedCount++;
					console.log(`[USER-CONVERSATIONS] Deleted query from cache: ${queryKey.substring(0, 50)}...`);
				}
				console.log(`[USER-CONVERSATIONS] Cleared ${cacheDeletedCount} queries from cache`);
			}

			return {
				...result,
				chromaDeleted: !!uiBlockId,
				cacheDeletedCount,
				queriesDeleted: queriesToDelete.length
			};
		} catch (error: any) {
			console.error(`[USER-CONVERSATIONS] Failed to delete conversation ${id}:`, error);
			throw error;
		}
	});

	// Delete a conversation by uiBlockId (from postgres and ChromaDB)
	sdk.addCollection('user-conversations', 'deleteByUiBlockId', async (params: any) => {
		const { uiBlockId, clearCache = true } = params;
		if (!uiBlockId) throw new Error('uiBlockId required');

		// Helper to get cache key for a query (matches sdk-nodejs logic)
		const getQueryCacheKey = (query: any): string => {
			if (typeof query === 'string') {
				return query;
			} else if (query?.sql) {
				const values = query.values || query.params;
				if (values && Object.keys(values).length > 0) {
					return JSON.stringify({ sql: query.sql, values });
				}
				return query.sql;
			}
			return '';
		};

		// Helper to recursively extract queries from components
		const extractQueries = (component: any, queries: string[]) => {
			if (!component) return;

			if (component?.props?.query) {
				const cacheKey = getQueryCacheKey(component.props.query);
				if (cacheKey) {
					queries.push(cacheKey);
				}
			}

			// Check nested components array (direct children)
			if (Array.isArray(component?.components)) {
				for (const child of component.components) {
					extractQueries(child, queries);
				}
			}

			// Check MultiComponentContainer structure: props.config.components
			if (Array.isArray(component?.props?.config?.components)) {
				for (const child of component.props.config.components) {
					extractQueries(child, queries);
				}
			}

			// Check props.components (another common nesting pattern)
			if (Array.isArray(component?.props?.components)) {
				for (const child of component.props.components) {
					extractQueries(child, queries);
				}
			}
		};

		try {
			console.log(`[USER-CONVERSATIONS] deleteByUiBlockId called with uiBlockId: ${uiBlockId}`);

			// First, get the conversation to extract queries for cache deletion
			const conversation = await userConversationsService.getConversationByUiBlockId(uiBlockId);
			console.log(`[USER-CONVERSATIONS] Conversation lookup result:`, conversation.success, conversation.data ? 'found' : 'not found');

			if (!conversation.success || !conversation.data) {
				console.log(`[USER-CONVERSATIONS] Conversation with uiBlockId ${uiBlockId} not found in database`);
				// Still try to delete from ChromaDB even if not in PostgreSQL
				if (conversationChromaManager) {
					try {
						const isHealthy = await conversationChromaManager.healthCheck();
						if (isHealthy) {
							await conversationChromaManager.createCollection();
							await conversationChromaManager.delete([uiBlockId]);
							console.log(`[USER-CONVERSATIONS] Deleted embedding ${uiBlockId} from ChromaDB (even though not in PostgreSQL)`);
						}
					} catch (chromaError) {
						console.warn(`[USER-CONVERSATIONS] Failed to delete from ChromaDB:`, chromaError);
					}
				}
				evictUIBlockFromMemory(uiBlockId);
				return {
					success: true,
					message: `Conversation with uiBlockId ${uiBlockId} not found in database, but cleared from ChromaDB`,
					chromaDeleted: true,
					cacheDeletedCount: 0,
					queriesDeleted: 0
				};
			}

			const uiblock = conversation.data.response as any;

			// Extract queries from component for cache deletion
			const queriesToDelete: string[] = [];
			extractQueries(uiblock?.component, queriesToDelete);

			console.log(`[USER-CONVERSATIONS] Found ${queriesToDelete.length} queries to delete from cache for uiBlockId ${uiBlockId}`);

			// Delete from PostgreSQL
			const result = await userConversationsService.deleteConversationByUiBlockId(uiBlockId);
			console.log(`[USER-CONVERSATIONS] Deleted conversation with uiBlockId ${uiBlockId} from PostgreSQL`);

			// Delete from ChromaDB
			if (conversationChromaManager) {
				try {
					const isHealthy = await conversationChromaManager.healthCheck();
					if (isHealthy) {
						await conversationChromaManager.createCollection();
						await conversationChromaManager.delete([uiBlockId]);
						console.log(`[USER-CONVERSATIONS] Deleted embedding ${uiBlockId} from ChromaDB`);
					}
				} catch (chromaError) {
					console.warn(`[USER-CONVERSATIONS] Failed to delete from ChromaDB:`, chromaError);
				}
			}

			// Evict from the in-memory thread too — see evictUIBlockFromMemory's doc comment.
			evictUIBlockFromMemory(uiBlockId);

			// Clear only the specific queries from cache
			let cacheDeletedCount = 0;
			if (clearCache && queriesToDelete.length > 0) {
				for (const queryKey of queriesToDelete) {
					queryCache.delete(queryKey);
					cacheDeletedCount++;
					console.log(`[USER-CONVERSATIONS] Deleted query from cache: ${queryKey.substring(0, 50)}...`);
				}
				console.log(`[USER-CONVERSATIONS] Cleared ${cacheDeletedCount} queries from cache`);
			}

			return {
				...result,
				chromaDeleted: true,
				cacheDeletedCount,
				queriesDeleted: queriesToDelete.length
			};
		} catch (error: any) {
			console.error(`[USER-CONVERSATIONS] Failed to delete conversation with uiBlockId ${uiBlockId}:`, error);
			throw error;
		}
	});

	// Delete a conversation by userPrompt (from postgres and ChromaDB)
	sdk.addCollection('user-conversations', 'deleteByUserPrompt', async (params: any) => {
		const { userPrompt, userId, clearCache = true } = params;
		if (!userPrompt) throw new Error('userPrompt required');

		// Helper to get cache key for a query (matches sdk-nodejs logic)
		const getQueryCacheKey = (query: any): string => {
			if (typeof query === 'string') {
				return query;
			} else if (query?.sql) {
				const values = query.values || query.params;
				if (values && Object.keys(values).length > 0) {
					return JSON.stringify({ sql: query.sql, values });
				}
				return query.sql;
			}
			return '';
		};

		// Helper to recursively extract queries from components
		const extractQueries = (component: any, queries: string[]) => {
			if (!component) return;
			if (component?.props?.query) {
				const cacheKey = getQueryCacheKey(component.props.query);
				if (cacheKey) queries.push(cacheKey);
			}
			// Check nested components array (direct children)
			if (Array.isArray(component?.components)) {
				for (const child of component.components) {
					extractQueries(child, queries);
				}
			}
			// Check MultiComponentContainer structure: props.config.components
			if (Array.isArray(component?.props?.config?.components)) {
				for (const child of component.props.config.components) {
					extractQueries(child, queries);
				}
			}
			// Check props.components (another common nesting pattern)
			if (Array.isArray(component?.props?.components)) {
				for (const child of component.props.components) {
					extractQueries(child, queries);
				}
			}
		};

		try {
			console.log(`[USER-CONVERSATIONS] deleteByUserPrompt called with userPrompt: "${userPrompt.substring(0, 50)}..."`);

			// Get the conversation to extract uiBlockId and queries
			const conversation = await userConversationsService.getConversationByUserPrompt(userPrompt, userId);
			console.log(`[USER-CONVERSATIONS] Conversation lookup result:`, conversation.success, conversation.data ? 'found' : 'not found');

			if (!conversation.success || !conversation.data) {
				console.log(`[USER-CONVERSATIONS] Conversation not found for userPrompt`);
				return {
					success: false,
					message: 'Conversation not found'
				};
			}

			const uiblock = conversation.data.response as any;
			const uiBlockId = uiblock?.id;

			// Extract queries from component for cache deletion
			const queriesToDelete: string[] = [];
			extractQueries(uiblock?.component, queriesToDelete);
			console.log(`[USER-CONVERSATIONS] Found ${queriesToDelete.length} queries to delete from cache`);

			// Delete from PostgreSQL
			const result = await userConversationsService.deleteConversationByUserPrompt(userPrompt, userId);
			console.log(`[USER-CONVERSATIONS] Deleted conversation from PostgreSQL`);

			// Delete from ChromaDB using the uiBlockId
			let chromaDeleted = false;
			if (uiBlockId && conversationChromaManager) {
				try {
					const isHealthy = await conversationChromaManager.healthCheck();
					if (isHealthy) {
						await conversationChromaManager.createCollection();
						await conversationChromaManager.delete([uiBlockId]);
						chromaDeleted = true;
						console.log(`[USER-CONVERSATIONS] Deleted embedding ${uiBlockId} from ChromaDB`);
					}
				} catch (chromaError) {
					console.warn(`[USER-CONVERSATIONS] Failed to delete from ChromaDB:`, chromaError);
				}
			}

			// Evict from the in-memory thread too — see evictUIBlockFromMemory's doc comment.
			evictUIBlockFromMemory(uiBlockId);

			// Clear only the specific queries from cache
			let cacheDeletedCount = 0;
			if (clearCache && queriesToDelete.length > 0) {
				for (const queryKey of queriesToDelete) {
					queryCache.delete(queryKey);
					cacheDeletedCount++;
					console.log(`[USER-CONVERSATIONS] Deleted query from cache: ${queryKey.substring(0, 50)}...`);
				}
				console.log(`[USER-CONVERSATIONS] Cleared ${cacheDeletedCount} queries from cache`);
			}

			return {
				...result,
				chromaDeleted,
				cacheDeletedCount,
				queriesDeleted: queriesToDelete.length
			};
		} catch (error: any) {
			console.error(`[USER-CONVERSATIONS] Failed to delete conversation:`, error);
			throw error;
		}
	});

	// Delete an ENTIRE thread for a user (postgres + ChromaDB + query cache)
	sdk.addCollection('user-conversations', 'deleteThread', async (params: any) => {
		const { userId, threadId, clearCache = true } = params;
		if (!userId) throw new Error('userId required');
		if (!threadId) throw new Error('threadId required');

		// Helper to get cache key for a query (matches sdk-nodejs logic)
		const getQueryCacheKey = (query: any): string => {
			if (typeof query === 'string') {
				return query;
			} else if (query?.sql) {
				const values = query.values || query.params;
				if (values && Object.keys(values).length > 0) {
					return JSON.stringify({ sql: query.sql, values });
				}
				return query.sql;
			}
			return '';
		};

		// Helper to recursively extract queries from components
		const extractQueries = (component: any, queries: string[]) => {
			if (!component) return;
			if (component?.props?.query) {
				const cacheKey = getQueryCacheKey(component.props.query);
				if (cacheKey) queries.push(cacheKey);
			}
			if (Array.isArray(component?.components)) {
				for (const child of component.components) extractQueries(child, queries);
			}
			if (Array.isArray(component?.props?.config?.components)) {
				for (const child of component.props.config.components) extractQueries(child, queries);
			}
			if (Array.isArray(component?.props?.components)) {
				for (const child of component.props.components) extractQueries(child, queries);
			}
		};

		try {
			console.log(`[USER-CONVERSATIONS] deleteThread called for user ${userId}, thread ${threadId}`);

			// The thread's attached files, read before its row goes — their R2
			// objects are removed below.
			const attachments = await userConversationsService.getThreadAttachments({ userId, threadId });

			// Delete from PostgreSQL — returns the deleted rows (with response)
			const result = await userConversationsService.deleteThread({ userId, threadId });
			const rows = (result.data as any[]) || [];
			console.log(`[USER-CONVERSATIONS] Deleted ${rows.length} conversations from thread ${threadId}`);

			// Collect uiBlock ids (for ChromaDB) and queries (for cache) from every row
			const uiBlockIds: string[] = [];
			const queriesToDelete: string[] = [];
			for (const row of rows) {
				const uiblock = row?.response as any;
				if (uiblock?.id) uiBlockIds.push(uiblock.id);
				extractQueries(uiblock?.component, queriesToDelete);
			}

			// Delete embeddings from ChromaDB in one batched call
			let chromaDeleted = false;
			if (uiBlockIds.length > 0 && conversationChromaManager) {
				try {
					const isHealthy = await conversationChromaManager.healthCheck();
					if (isHealthy) {
						await conversationChromaManager.createCollection();
						await conversationChromaManager.delete(uiBlockIds);
						chromaDeleted = true;
						console.log(`[USER-CONVERSATIONS] Deleted ${uiBlockIds.length} embeddings from ChromaDB`);
					}
				} catch (chromaError) {
					console.warn(`[USER-CONVERSATIONS] Failed to delete thread embeddings from ChromaDB:`, chromaError);
				}
			}

			// Evict the WHOLE thread from memory too — see evictUIBlockFromMemory's
			// doc comment for why this matters even after Postgres/Chroma succeed.
			{
				const removed = ThreadManager.getInstance().deleteThread(threadId);
				console.log(`[USER-CONVERSATIONS] Removed in-memory thread ${threadId}: ${removed}`);
			}

			// Its attached files in R2 — best-effort, never blocks the delete.
			await deleteAttachmentsFromR2(attachments.map((a) => a.key));

			// Clear the affected queries from cache
			let cacheDeletedCount = 0;
			if (clearCache && queriesToDelete.length > 0) {
				for (const queryKey of queriesToDelete) {
					queryCache.delete(queryKey);
					cacheDeletedCount++;
				}
				console.log(`[USER-CONVERSATIONS] Cleared ${cacheDeletedCount} queries from cache`);
			}

			return {
				...result,
				chromaDeleted,
				cacheDeletedCount,
				queriesDeleted: queriesToDelete.length,
			};
		} catch (error: any) {
			console.error(`[USER-CONVERSATIONS] Failed to delete thread ${threadId}:`, error);
			throw error;
		}
	});

	// Save a debug trace for a conversation turn (retrieved KB/schema nodes, the
	// script that ran) — called right after 'create' succeeds so it has the real
	// conversationId to point at. Best-effort: the sdk-nodejs caller wraps this
	// in try/catch so a capture failure never affects the actual answer.
	// See CHAT-DEBUG-TRACE-DESIGN.md (do-websocket/packages/api).
	sdk.addCollection('user-conversations', 'saveTrace', async (params: any) => {
		// 'chat_agent' | 'dashboard' | 'report' — required. conversationId is
		// only unique WITHIN its own source table (user_conversations /
		// dashboard_agent_conversations / reports_conversations each have their
		// own id sequence), so without type a chat conversation #50 and a
		// dashboard conversation #50 are indistinguishable at read time.
		const { conversationId, type, userId, threadId, trace } = params;
		if (!conversationId) throw new Error('conversationId required');
		if (!type) throw new Error('type required');
		if (!userId) throw new Error('userId required');
		if (!trace) throw new Error('trace required');
		try {
			const result = await userConversationsService.saveConversationTrace({
				conversationId: Number(conversationId),
				type,
				userId,
				threadId,
				trace
			});
			return result;
		} catch (error: any) {
			console.error(`[USER-CONVERSATIONS] Failed to save trace for conversation ${conversationId}:`, error);
			throw error;
		}
	});

	// Fetch the debug trace for a conversation — used by the debug view, only
	// fetched on demand (not bundled into getById). `type` is required for the
	// same reason as saveTrace above — conversationId alone is ambiguous.
	sdk.addCollection('user-conversations', 'getTrace', async (params: any) => {
		const { conversationId, type } = params;
		if (!conversationId) throw new Error('conversationId required');
		if (!type) throw new Error('type required');
		try {
			const trace = await userConversationsService.getConversationTrace(Number(conversationId), type);
			return { success: true, data: trace };
		} catch (error: any) {
			console.error(`[USER-CONVERSATIONS] Failed to get trace for conversation ${conversationId}:`, error);
			return { success: false, data: null, message: error?.message };
		}
	});

	// Rename a thread (title only — does not touch updated_at, so renaming
	// doesn't reorder the sidebar's most-recently-active thread list)
	sdk.addCollection('user-conversations', 'updateThreadTitle', async (params: any) => {
		const { userId, threadId, title } = params;
		if (!userId) throw new Error('userId required');
		if (!threadId) throw new Error('threadId required');
		if (!title) throw new Error('title required');
		try {
			return await userConversationsService.updateThreadTitle({ userId, threadId, title });
		} catch (error: any) {
			console.error(`[USER-CONVERSATIONS] Failed to rename thread ${threadId}:`, error);
			throw error;
		}
	});

	// Search conversation history (returns single best match)
	sdk.addCollection('conversation-history', 'search', async (params: any) => {
		const { userPrompt, userId, threshold = 0.6 } = params;
		if (!userPrompt || !userId) throw new Error('userPrompt and userId required');
		try {
			const isHealthy = await conversationChromaManager.healthCheck();
			if (!isHealthy) return null;
			await conversationChromaManager.createCollection();
			// Query more candidates to filter by userId
			const results = await conversationChromaManager.query(userPrompt, 20);
			console.log('[CONVERSATION-SEARCH] Search results:', results);
			if (!results.ids[0].length) return null;

			// Loop through results and find first match for this userId
			for (let i = 0; i < results.ids[0].length; i++) {
				const metadata = results.metadatas[0][i] as any;

				// Filter by userId - skip results from other users
				if (String(metadata.user_id) !== String(userId)) {
					continue;
				}

				const similarity = 1 - results.distances[0][i];
				console.log(`[CONVERSATION-SEARCH] Candidate ${i + 1} similarity: ${similarity.toFixed(4)}`);

				if (similarity < threshold) continue;

				const uiBlockJson = metadata.uiblock;
				const uiBlock = typeof uiBlockJson === 'string' ? JSON.parse(uiBlockJson) : uiBlockJson;

				return {
					uiBlock: uiBlock,
					similarity: parseFloat(similarity.toFixed(4)),
					metadata: {
						userPrompt: metadata.user_prompt || userPrompt,
						uiBlockId: metadata.uiblock_id,
						userId: metadata.user_id
					}
				};
			}

			return null;
		} catch {
			return null;
		}
	});

	// Search conversation history (returns multiple results for reranking)
	sdk.addCollection('conversation-history', 'searchMultiple', async (params: any) => {
		const { userPrompt, userId, limit = 50, threshold = 0 } = params;
		if (!userPrompt || !userId) throw new Error('userPrompt and userId required');
		try {
			const isHealthy = await conversationChromaManager.healthCheck();
			if (!isHealthy) return [];
			await conversationChromaManager.createCollection();

			// Fetch results for reranking - get a large pool of candidates
			const results = await conversationChromaManager.query(userPrompt, limit);

			if (!results.ids[0].length) return [];

			// Convert results to array format for reranking
			const candidates = [];
			for (let i = 0; i < results.ids[0].length; i++) {
				const metadata = results.metadatas[0][i] as any;

				// Filter by userId - skip results from other users
				if (String(metadata.user_id) !== String(userId)) {
					continue;
				}

				const distance = results.distances[0][i];
				// Convert L2 distance to similarity score (0-1 range)
				// Using 1/(1+distance) formula which properly handles distances > 1
				const similarity = 1 / (1 + distance);

				// Apply minimum threshold filter (if threshold > 0)
				if (threshold > 0 && similarity < threshold) {
					continue;
				}

				const uiBlockJson = metadata.uiblock;
				const uiBlock = typeof uiBlockJson === 'string' ? JSON.parse(uiBlockJson) : uiBlockJson;
				const storedUserPrompt = metadata.user_prompt || '';


				candidates.push({
					uiBlock: uiBlock,
					similarity: parseFloat(similarity.toFixed(4)),
					metadata: {
						userPrompt: storedUserPrompt,
						uiBlockId: metadata.uiblock_id,
						userId: metadata.user_id
					}
				});
			}

			return candidates;
		} catch (error) {
			console.error('[CONVERSATION-SEARCH-MULTIPLE] Error:', error);
			return [];
		}
	});

	// Exact-prompt lookup — indexed string equality on the stored user_prompt.
	// Used by the SDK to short-circuit the agent flow when the same question was
	// asked before, without paying for embedding + ChromaDB + BM25 reranking.
	// Returns a ConversationSearchResult-shaped object (similarity=1) when found.
	// onlyStatus='success' — a prior FAILED attempt at this prompt must never be
	// replayed as a cached "answer" to a new asker.
	sdk.addCollection('conversation-history', 'exactMatch', async (params: any) => {
		const { userPrompt, userId, maxAgeHours, threadId } = params;
		if (!userPrompt) throw new Error('userPrompt required');
		try {
			// threadId: the SDK only replays a question asked earlier in the same thread.
			const result = await userConversationsService.getConversationByUserPrompt(userPrompt, userId, 'success', maxAgeHours, threadId);
			if (!result.success || !result.data) return null;

			const uiblock = result.data.response as any;
			if (!uiblock) return null;

			return {
				uiBlock: uiblock,
				similarity: 1,
				metadata: {
					userPrompt: uiblock.user_prompt || userPrompt,
					uiBlockId: uiblock.id,
					userId: result.data.userId,
					createdAt: result.data.createdAt,
				},
			};
		} catch (error) {
			console.error('[CONVERSATION-EXACT-MATCH] Error:', error);
			return null;
		}
	});

	// Recent script-backed answers in a thread — the candidate set a user-directed
	// edit can target. Read when the in-memory thread has no binding (backend
	// restart / returning user), and to let the matcher pick WHICH script an
	// instruction means when a thread ran several.
	sdk.addCollection('conversation-history', 'threadScriptBindings', async (params: any) => {
		const { threadId, userId, limit, excludeUiBlockId } = params || {};
		if (!threadId) throw new Error('threadId required');
		try {
			return await userConversationsService.getThreadScriptBindings({ threadId, userId, limit, excludeUiBlockId });
		} catch (error) {
			console.error('[CONVERSATION-THREAD-BINDINGS] Error:', error);
			return [];
		}
	});

	// Retire every cached answer produced by a given script recipe. Called after a
	// user-directed script edit commits — without it, the exact-match cache (which
	// short-circuits BEFORE the matcher) keeps replaying the PRE-EDIT answer and
	// the edit looks like a no-op. Marks status='superseded' rather than deleting,
	// so the rows stay in the user's thread history.
	sdk.addCollection('conversation-history', 'invalidateByScriptRecipe', async (params: any) => {
		const { recipeId, userId } = params || {};
		if (!recipeId) throw new Error('recipeId required');
		try {
			return await userConversationsService.supersedeConversationsByScriptRecipe(recipeId, userId);
		} catch (error) {
			console.error('[CONVERSATION-INVALIDATE-BY-RECIPE] Error:', error);
			return { success: false, count: 0 };
		}
	});

	// Embed conversation
	sdk.addCollection('conversation-history', 'embed', async (params: any) => {
		const { uiBlockId, userPrompt, uiBlock, userId } = params;

		if (!uiBlockId) {
			throw new Error('uiBlockId is required');
		}

		if (!userPrompt) {
			throw new Error('userPrompt is required');
		}

		if (!uiBlock) {
			throw new Error('uiBlock is required');
		}

		try {
			// Check if ChromaDB is healthy
			const isHealthy = await conversationChromaManager.healthCheck();
			if (!isHealthy) {
				console.warn('[CONVERSATION-EMBED] ChromaDB server is not running, skipping embedding');
				return {
					success: false,
					error: 'ChromaDB server is not available'
				};
			}

			// Ensure user_conversations collection exists
			await conversationChromaManager.createCollection();

			// Create embedding for user prompt and store in ChromaDB with metadata
			console.log(`[CONVERSATION-EMBED] Creating embedding for uiBlockId: ${uiBlockId}, userPrompt: "${userPrompt.substring(0, 50)}..."`);

			await conversationChromaManager.add({
				ids: [uiBlockId],
				documents: [userPrompt],
				metadatas: [
					{
						uiblock_id: uiBlockId,
						user_id: userId || null,
						user_prompt: userPrompt, // Store user prompt for reranking
						type: 'user_conversation',
						uiblock: JSON.stringify(uiBlock)
					}
				]
			});

			console.log(`[CONVERSATION-EMBED] Successfully created embedding for conversation ${uiBlockId}`);

			return {
				success: true,
				message: 'Conversation embedding created successfully',
				uiBlockId
			};
		} catch (error: any) {
			let errorMsg = 'Unknown error';

			if (error instanceof Error) {
				errorMsg = error.message;
			} else if (error && typeof error === 'object') {
				errorMsg = error.message || error.error || JSON.stringify(error);
			}

			console.error('[CONVERSATION-EMBED] Failed to create embedding:', errorMsg);
			throw new Error(`Failed to create conversation embedding: ${errorMsg}`);
		}
	});

}
