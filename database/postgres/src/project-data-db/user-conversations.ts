import { db, schema } from './drizzle-db';
import { eq, and, ne, desc, asc, sql, inArray } from 'drizzle-orm';

const { userConversations, threads, conversationTraces } = schema;

/**
 * User Conversations CRUD Operations using Drizzle ORM
 * Stores UIBlock data for conversations to enable semantic search
 */

export interface CreateConversationParams {
	userId: string;
	userPrompt: string;
	response: any; // { id, component, analysis, user_prompt, errorMessage } — see conversation-saver.ts
	threadId?: string;
	status?: 'success' | 'error' | 'aborted'; // defaults to 'success'
	agentId?: string; // the chat agent (sa-api app id) the question was asked to
}

export interface UpdateConversationParams {
	id: number;
	userPrompt?: string;
	response?: any;
	threadId?: string;
}

export interface GetConversationParams {
	id: number;
}

export interface DeleteConversationParams {
	id: number;
}

export interface GetUserConversationsParams {
	userId: string;
	limit?: number;
	offset?: number;
}

export interface GetThreadConversationsParams {
	userId: string;
	threadId: string;
	agentId: string;
	limit?: number;
	offset?: number;
}

export interface GetUserThreadsParams {
	userId: string;
	agentId: string;
	limit?: number;
	offset?: number;
}

/**
 * Create a new conversation
 */
export async function createConversation(
	params: CreateConversationParams
) {
	const { userId, userPrompt, response, threadId, status = 'success', agentId } = params;

	if (!userId) {
		throw new Error('userId is required');
	}

	if (!userPrompt) {
		throw new Error('userPrompt is required');
	}

	if (!response) {
		throw new Error('response is required');
	}

	const result = await db.transaction(async (tx) => {
		const inserted = await tx
			.insert(userConversations)
			.values({
				userId,
				userprompt: userPrompt,
				response,
				threadid: threadId || null,
				status,
				agentId: agentId || null,
			})
			.returning();

		// Keep the `threads` table in sync: first message of a thread creates the
		// row (title = this opening prompt), later messages just bump updated_at
		// so the sidebar re-sorts most-recently-active first. The thread's agent
		// is set once and never changed — only filled in when the row has none
		// (setThreadConfig can create the row before its first message is saved).
		if (threadId) {
			await tx.execute(sql`
				INSERT INTO threads (id, user_id, title, created_at, updated_at, archived, agent_id)
				VALUES (${threadId}, ${userId}, ${userPrompt}, now(), now(), false, ${agentId || null})
				ON CONFLICT (id) DO UPDATE SET
					updated_at = now(),
					agent_id = COALESCE(threads.agent_id, EXCLUDED.agent_id)
			`);
		}

		return inserted;
	});

	return {
		success: true,
		data: result[0],
		message: 'Conversation created successfully',
	};
}

/** What a thread was started on. Only dashboards use it today. */
export interface ThreadConfig {
	dashboardId?: string;
}

/**
 * Records what a thread was started on, from its first question.
 *
 * Runs before that question is saved, so it creates the thread row when there is
 * none (title = the question, as createConversation would set it). A thread that
 * already has a config, or already has messages, is left as it is — a thread
 * belongs to what it was started on.
 */
export async function setThreadConfig(params: {
	userId: string;
	threadId: string;
	title: string;
	config: ThreadConfig;
}) {
	const { userId, threadId, title, config } = params;

	if (!userId) throw new Error('userId is required');
	if (!threadId) throw new Error('threadId is required');

	await db.execute(sql`
		INSERT INTO threads (id, user_id, title, created_at, updated_at, archived, config)
		VALUES (${threadId}, ${userId}, ${title}, now(), now(), false, ${JSON.stringify(config)}::jsonb)
		ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config
		WHERE threads.config IS NULL
		  AND threads.user_id = EXCLUDED.user_id
		  AND NOT EXISTS (SELECT 1 FROM user_conversations uc WHERE uc.threadid = threads.id)
	`);

	return { success: true };
}

/** A file attached to a thread — its R2 object and what the user called it. */
export interface ThreadAttachment {
	key: string;
	fileName: string;
	size: number;
	contentType?: string;
}

/** The files attached to a thread so far, oldest first. Empty for a thread with none, or not this user's. */
export async function getThreadAttachments(params: { userId: string; threadId: string }): Promise<ThreadAttachment[]> {
	const { userId, threadId } = params;

	if (!userId) throw new Error('userId is required');
	if (!threadId) throw new Error('threadId is required');

	const rows = await db
		.select({ attachments: threads.attachments })
		.from(threads)
		.where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
		.limit(1);

	return (rows[0]?.attachments as ThreadAttachment[] | null) ?? [];
}

/**
 * Appends files to a thread's attachments.
 *
 * Runs before the question is saved, so it creates the thread row when there is
 * none (title = the question, as createConversation would set it). Another
 * user's thread is left untouched.
 */
export async function addThreadAttachments(params: {
	userId: string;
	threadId: string;
	title: string;
	attachments: ThreadAttachment[];
}) {
	const { userId, threadId, title, attachments } = params;

	if (!userId) throw new Error('userId is required');
	if (!threadId) throw new Error('threadId is required');
	if (!attachments.length) return { success: true };

	await db.execute(sql`
		INSERT INTO threads (id, user_id, title, created_at, updated_at, archived, attachments)
		VALUES (${threadId}, ${userId}, ${title}, now(), now(), false, ${JSON.stringify(attachments)}::jsonb)
		ON CONFLICT (id) DO UPDATE SET attachments = COALESCE(threads.attachments, '[]'::jsonb) || EXCLUDED.attachments
		WHERE threads.user_id = EXCLUDED.user_id
	`);

	return { success: true };
}

/** One thread's title, config and attached files, scoped to its user and chat agent. */
export async function getThread(params: { userId: string; threadId: string; agentId: string }) {
	const { userId, threadId, agentId } = params;

	if (!userId) throw new Error('userId is required');
	if (!threadId) throw new Error('threadId is required');
	if (!agentId) throw new Error('agentId is required');

	const rows = await db
		.select({ threadId: threads.id, title: threads.title, config: threads.config, attachments: threads.attachments })
		.from(threads)
		.where(and(eq(threads.id, threadId), eq(threads.userId, userId), eq(threads.agentId, agentId)))
		.limit(1);

	return { success: true, data: rows[0] ?? null };
}

/**
 * Get a single conversation by ID
 */
export async function getConversation(params: GetConversationParams) {
	const { id } = params;

	if (!id) {
		throw new Error('Conversation ID is required');
	}

	const result = await db
		.select()
		.from(userConversations)
		.where(eq(userConversations.id, id))
		.limit(1);

	if (result.length === 0) {
		throw new Error(`Conversation with ID ${id} not found`);
	}

	return {
		success: true,
		data: result[0],
	};
}

/**
 * Get all conversations for a user (most recent first)
 */
export async function getUserConversations(
	params: GetUserConversationsParams
) {
	const { userId, limit = 50, offset = 0 } = params;

	if (!userId) {
		throw new Error('userId is required');
	}

	const result = await db
		.select()
		.from(userConversations)
		.where(eq(userConversations.userId, userId))
		.orderBy(desc(userConversations.createdAt))
		.limit(limit)
		.offset(offset);

	return {
		success: true,
		data: result,
		count: result.length,
	};
}

/**
 * Get conversations in a specific thread, paginated newest-first.
 *
 * Ordered by createdAt DESC so the caller can page backwards through history
 * (offset 0 = most recent N messages, offset N = the N before that). The
 * frontend reverses each page for natural top-to-bottom chat display.
 * `total` is the full message count for the thread so the caller knows when to
 * stop offering "load older".
 */
export async function getThreadConversations(
	params: GetThreadConversationsParams
) {
	const { userId, threadId, agentId, limit = 5, offset = 0 } = params;

	if (!userId) {
		throw new Error('userId is required');
	}

	if (!threadId) {
		throw new Error('threadId is required');
	}

	if (!agentId) {
		throw new Error('agentId is required');
	}

	// A thread that isn't this user's under this chat agent (wrong agent, or
	// gone) — the caller shows it as not found.
	const owned = await db
		.select({ id: threads.id })
		.from(threads)
		.where(and(eq(threads.id, threadId), eq(threads.userId, userId), eq(threads.agentId, agentId)))
		.limit(1);
	if (owned.length === 0) {
		return { success: true, data: [], count: 0, total: 0, notFound: true };
	}

	const where = and(
		eq(userConversations.userId, userId),
		eq(userConversations.threadid, threadId)
	);

	const result = await db
		.select()
		.from(userConversations)
		.where(where)
		// id DESC tiebreak makes ordering deterministic even when two rows share
		// a createdAt timestamp — searchUserConversations' offsetInThread relies
		// on this exact ordering to always match real pagination position.
		.orderBy(desc(userConversations.createdAt), desc(userConversations.id))
		.limit(limit)
		.offset(offset);

	const totalRes = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(userConversations)
		.where(where);

	return {
		success: true,
		data: result,
		count: result.length,
		total: totalRes[0]?.count ?? 0,
	};
}

/**
 * Lean, side-effect-free read for MainAgent's CONVERSATION_HISTORY —
 * deliberately separate from getThreadConversations above, which also runs
 * refreshNarratives() (can re-execute bound scripts live, up to
 * REFRESH_NARRATIVES_TIMEOUT_MS) at the collection-wrapper level. That's the
 * right cost for a human re-opening a thread in the UI; it's the wrong cost
 * to pay on every single new question just to build its prompt context.
 *
 * status='aborted' is excluded in the WHERE clause itself, not filtered
 * after limiting — an aborted turn was deliberately kept out of history (see
 * thread.removeUIBlock() at abort time in user-prompt-request.ts); filtering
 * post-limit would silently return fewer than `limit` rows whenever a recent
 * abort falls inside the window instead of just skipping past it.
 */
export async function getRecentConversationsForContext(params: {
	userId: string;
	threadId: string;
	limit: number;
}) {
	const { userId, threadId, limit } = params;

	if (!userId) throw new Error('userId is required');
	if (!threadId) throw new Error('threadId is required');

	const result = await db
		.select()
		.from(userConversations)
		.where(and(
			eq(userConversations.userId, userId),
			eq(userConversations.threadid, threadId),
			ne(userConversations.status, 'aborted'),
		))
		.orderBy(desc(userConversations.createdAt), desc(userConversations.id))
		.limit(limit);

	return { success: true, data: result };
}

/**
 * List a user's conversation threads for the sidebar.
 *
 * Reads from the `threads` table (kept in sync on every write — see
 * createConversation/deleteThread/deleteThreadRowIfEmpty above) instead of a
 * GROUP BY scan over all of user_conversations, so this is now an indexed
 * lookup. messageCount is still computed live per row via a correlated
 * subquery (cheap — hits idx_user_conversations_thread_id) rather than a
 * stored counter, since counters can drift out of sync with deletes.
 *
 * Excludes threads with zero messages via an EXISTS check. deleteThreadRowIfEmpty
 * is meant to keep this from ever happening, but it's not the only way a
 * `threads` row can end up orphaned (e.g. rows that predate that cleanup, or a
 * path that doesn't call it) — this filter is the defense-in-depth backstop so
 * an empty thread can never surface in the sidebar/click through to a dead
 * "getThreadConversations" fetch, regardless of how it went empty. Mirrored
 * client-side in runtime-react's Sidebar.tsx (fetchThreads) as a second layer.
 */
export async function getUserThreads(params: GetUserThreadsParams) {
	const { userId, agentId, limit = 50, offset = 0 } = params;

	if (!userId) {
		throw new Error('userId is required');
	}

	if (!agentId) {
		throw new Error('agentId is required');
	}

	const rows = await db.execute(sql`
		SELECT
			t.id AS "threadId",
			t.title,
			t.created_at AS "createdAt",
			t.updated_at AS "updatedAt",
			t.archived,
			-- What the thread was started on, e.g. { dashboardId }. The UI reopens
			-- a thread where it belongs, so the list has to carry it.
			t.config,
			(SELECT COUNT(*)::int FROM user_conversations uc WHERE uc.threadid = t.id) AS "messageCount"
		FROM threads t
		WHERE t.user_id = ${userId}
		  AND t.agent_id = ${agentId}
		  AND EXISTS (SELECT 1 FROM user_conversations uc WHERE uc.threadid = t.id)
		ORDER BY t.updated_at DESC
		LIMIT ${limit} OFFSET ${offset}
	`);

	const data = (rows as any).rows ?? rows;

	// Total number of threads this user has (independent of the page window) so
	// the caller knows when it has loaded everything and can hide "Load more".
	// Must apply the same EXISTS filter as above or this would overcount
	// relative to what the page actually returns.
	const totalRes = await db.execute(sql`
		SELECT COUNT(*)::int AS "count" FROM threads t
		WHERE t.user_id = ${userId}
		  AND t.agent_id = ${agentId}
		  AND EXISTS (SELECT 1 FROM user_conversations uc WHERE uc.threadid = t.id)
	`);
	const totalRows = (totalRes as any).rows ?? totalRes;
	const total = totalRows[0]?.count ?? 0;

	return {
		success: true,
		data,
		count: data.length,
		total,
	};
}

export interface SearchUserConversationsParams {
	userId: string;
	agentId: string;
	query: string;
	limit?: number;
	offset?: number;
}

/**
 * Standard Postgres full-text search over TWO things, unioned and ranked
 * together: (1) the user's own PROMPTS, and (2) thread TITLES. Deliberately
 * does not search response->>'analysis' (the AI's answer): Postgres's text
 * search parser corrupts tokenization of everything after a 4-byte UTF-8
 * character, and AI-generated answers are full of emoji used for formatting
 * (📝, ✅, etc) — that was silently breaking search on real content in a way
 * that's not fixable without pre-sanitizing the indexed text. Prompts are
 * short, user-typed questions that essentially never contain emoji, so
 * scoping search to just this column sidesteps the bug rather than working
 * around it. Uses plainto_tsquery's normal AND semantics — reasonable for
 * typical short prompts, unlike the long AI-generated answers this was tried
 * against before.
 *
 * Uses the 'simple' text search config, not 'english' — 'english' applies
 * stemming AND strips a large stopword list ("up", "is", "what", etc.), which
 * silently made single-stopword searches match literally nothing (an empty
 * tsquery can't match anything) and dropped those words from multi-word
 * queries too. 'simple' does neither: every word is indexed and searchable
 * literally, matching what users actually expect a search box to do. Trade-
 * off: no stemming (searching "creating" won't also match "created").
 *
 * A thread's title defaults to its opening prompt, but can be renamed
 * (updateThreadTitle) to something with no relation to any actual message —
 * at that point it has no other searchable text tying it back, so it needs
 * its own match path via idx_threads_title_fts. Each result carries
 * `matchType`: 'message' (a specific prompt matched — the frontend jumps to
 * and highlights it) or 'thread' (only the title matched — nothing specific
 * to jump to, the frontend just opens the thread). A 'thread' row's `id` is
 * null since it isn't any one message.
 *
 * `offsetInThread` (message rows only): this row's 0-based position among
 * ALL of its thread's messages under the exact same ordering
 * getThreadConversations uses (created_at DESC, id DESC), computed via
 * ROW_NUMBER() before the FTS filter is applied. The frontend uses this to
 * fetch exactly enough of getThreadConversations (limit = offsetInThread +
 * PAGE_SIZE, rounded up, offset 0) to land the matched message in one request
 * instead of paging backwards until it appears.
 *
 * Deliberately does NOT use ts_headline to build a snippet — verified
 * directly that it truncates unpredictably even on short text (e.g.
 * "Hi what is up?" comes back as just "Hi what"), which is confusing rather
 * than helpful for prompts that are usually a single short sentence anyway.
 * The frontend gets the plain matched text and highlights matched words
 * itself (mark.js, literal substring match) — same reliable mechanism
 * already used for the in-chat jump-to-message highlight.
 */
export async function searchUserConversations(params: SearchUserConversationsParams) {
	const { userId, agentId, query, limit = 20, offset = 0 } = params;

	if (!userId) {
		throw new Error('userId is required');
	}

	if (!agentId) {
		throw new Error('agentId is required');
	}

	if (!query || !query.trim()) {
		throw new Error('query is required');
	}

	const rows = await db.execute(sql`
		WITH search_query AS (
			-- Build a PREFIX-matching tsquery from lexemes Postgres's OWN
			-- tokenizer produces for the raw query (to_tsvector — the exact same
			-- function used to build the index), rather than splitting/sanitizing
			-- the string ourselves in application code. That distinction matters:
			-- a naive JS-side split-on-whitespace-and-strip-punctuation approach
			-- was tried first and turned "low-value" into "lowvalue" (stripping
			-- the hyphen merges the two words into one token) — a token that can
			-- never match anything, which then zeroed out an entire search
			-- because every term is ANDed together. Postgres's tokenizer instead
			-- produces 'low', 'low-value', AND 'value' as separate lexemes for
			-- that same input, matching how it indexed the stored text in the
			-- first place. Each extracted lexeme becomes 'lexeme':* (prefix
			-- match), ANDed together; COALESCE(...,'') guards a query that
			-- tokenizes to nothing (e.g. pure punctuation) into an empty (safe,
			-- zero-result) tsquery instead of a null/error.
			SELECT to_tsquery('simple', COALESCE(string_agg(quote_literal((m.match)[1]) || ':*', ' & '), '')) AS tsq
			FROM regexp_matches(to_tsvector('simple', ${query})::text, '''([^'']+)''', 'g') AS m(match)
		),
		thread_positions AS (
			SELECT id, user_id, threadid, userprompt, status, created_at,
			       ROW_NUMBER() OVER (PARTITION BY threadid ORDER BY created_at DESC, id DESC) - 1 AS offset_in_thread
			FROM user_conversations
			WHERE user_id = ${userId} AND threadid IS NOT NULL
		),
		message_matches AS (
			SELECT
				tp.id,
				tp.threadid AS "threadId",
				t.title AS "threadTitle",
				tp.userprompt AS "matchText",
				'message'::text AS "matchType",
				tp.status,
				tp.created_at AS "createdAt",
				tp.offset_in_thread AS "offsetInThread",
				ts_rank(to_tsvector('simple', tp.userprompt), sq.tsq) AS rank
			FROM thread_positions tp
			JOIN threads t ON t.id = tp.threadid
			CROSS JOIN search_query sq
			WHERE t.agent_id = ${agentId}
			  AND to_tsvector('simple', tp.userprompt) @@ sq.tsq
		),
		thread_matches AS (
			SELECT
				NULL::int AS id,
				t.id AS "threadId",
				t.title AS "threadTitle",
				t.title AS "matchText",
				'thread'::text AS "matchType",
				NULL::varchar(20) AS status,
				t.updated_at AS "createdAt",
				0::bigint AS "offsetInThread",
				ts_rank(to_tsvector('simple', t.title), sq.tsq) AS rank
			FROM threads t
			CROSS JOIN search_query sq
			WHERE t.user_id = ${userId}
			  AND t.agent_id = ${agentId}
			  AND to_tsvector('simple', t.title) @@ sq.tsq
		),
		combined AS (
			SELECT * FROM message_matches
			UNION ALL
			SELECT * FROM thread_matches
		),
		-- A thread's title defaults to its own opening prompt, so a query
		-- matching that text would otherwise hit BOTH message_matches (the
		-- prompt) and thread_matches (the title) — same thread, shown twice.
		-- Keep only the single best match per thread: prefer a 'message' match
		-- (it's jump-capable, more actionable) over a 'thread' one, then by rank.
		deduped AS (
			SELECT DISTINCT ON ("threadId") *
			FROM combined
			ORDER BY "threadId", ("matchType" = 'message') DESC, rank DESC
		)
		SELECT *, COUNT(*) OVER() AS "totalMatches"
		FROM deduped
		ORDER BY rank DESC, "createdAt" DESC
		LIMIT ${limit} OFFSET ${offset}
	`);

	const data = (rows as any).rows ?? rows;
	const total = data[0]?.totalMatches ?? 0;

	console.log(`[searchUserConversations] userId=${userId} query=${JSON.stringify(query)} -> ${data.length} row(s), total=${total}`);

	return {
		success: true,
		data: data.map((r: any) => {
			const { totalMatches, ...rest } = r;
			return rest;
		}),
		count: data.length,
		total,
	};
}

/**
 * Update a conversation
 */
export async function updateConversation(
	params: UpdateConversationParams
) {
	const { id, userPrompt, response, threadId } = params;

	if (!id) {
		throw new Error('Conversation ID is required');
	}

	const updateData: any = {
		updatedAt: new Date().toISOString(),
	};

	if (userPrompt !== undefined) {
		updateData.userprompt = userPrompt;
	}

	if (response !== undefined) {
		updateData.response = response;
	}

	if (threadId !== undefined) {
		updateData.threadid = threadId;
	}

	const result = await db
		.update(userConversations)
		.set(updateData)
		.where(eq(userConversations.id, id))
		.returning();

	if (result.length === 0) {
		throw new Error(`Conversation with ID ${id} not found`);
	}

	return {
		success: true,
		data: result[0],
		message: 'Conversation updated successfully',
	};
}

/**
 * Delete a conversation
 */
export async function deleteConversation(params: DeleteConversationParams) {
	const { id } = params;

	if (!id) {
		throw new Error('Conversation ID is required');
	}

	const result = await db
		.delete(userConversations)
		.where(eq(userConversations.id, id))
		.returning();

	if (result.length === 0) {
		throw new Error(`Conversation with ID ${id} not found`);
	}

	await deleteThreadRowIfEmpty(result[0].threadid);

	return {
		success: true,
		data: result[0],
		message: 'Conversation deleted successfully',
	};
}

/**
 * After deleting a single conversation row, remove its `threads` row too if
 * that was the thread's last message — otherwise an emptied thread would
 * linger forever in the sidebar (no message_count counter is kept in sync;
 * this existence check is the source of truth instead).
 */
async function deleteThreadRowIfEmpty(threadId: string | null) {
	if (!threadId) return;
	await db.execute(sql`
		DELETE FROM threads
		WHERE id = ${threadId}
		  AND NOT EXISTS (SELECT 1 FROM user_conversations WHERE threadid = ${threadId})
	`);
}

/**
 * Delete all conversations for a user (usually on user deletion)
 */
export async function deleteUserConversations(userId: string) {
	if (!userId) {
		throw new Error('userId is required');
	}

	const result = await db
		.delete(userConversations)
		.where(eq(userConversations.userId, userId))
		.returning();

	return {
		success: true,
		deletedCount: result.length,
		message: `${result.length} conversations deleted successfully`,
	};
}

/**
 * Delete every conversation in a single thread (scoped to one user).
 *
 * Returns the deleted rows (including their `response`) so the caller can also
 * remove the matching ChromaDB embeddings and clear the query cache — mirroring
 * the single-conversation delete handlers.
 */
export async function deleteThread(params: { userId: string; threadId: string }) {
	const { userId, threadId } = params;

	if (!userId) {
		throw new Error('userId is required');
	}

	if (!threadId) {
		throw new Error('threadId is required');
	}

	const result = await db.transaction(async (tx) => {
		const deleted = await tx
			.delete(userConversations)
			.where(and(
				eq(userConversations.userId, userId),
				eq(userConversations.threadid, threadId)
			))
			.returning();

		await tx
			.delete(threads)
			.where(and(eq(threads.id, threadId), eq(threads.userId, userId)));

		return deleted;
	});

	return {
		success: true,
		data: result,
		deletedCount: result.length,
		message: `${result.length} conversations deleted from thread`,
	};
}

/**
 * Rename a thread (scoped to its owning user). Deliberately does NOT touch
 * updated_at — that reflects actual conversation activity (bumped on every
 * new message), and a title edit shouldn't reorder the sidebar's
 * most-recently-active list.
 */
export async function updateThreadTitle(params: { userId: string; threadId: string; title: string }) {
	const { userId, threadId, title } = params;

	if (!userId) {
		throw new Error('userId is required');
	}

	if (!threadId) {
		throw new Error('threadId is required');
	}

	if (!title || !title.trim()) {
		throw new Error('title is required');
	}

	const result = await db
		.update(threads)
		.set({ title: title.trim() })
		.where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
		.returning();

	if (result.length === 0) {
		throw new Error(`Thread ${threadId} not found for this user`);
	}

	return {
		success: true,
		data: result[0],
		message: 'Thread renamed successfully',
	};
}

/**
 * Get conversation count for a user
 */
export async function getUserConversationCount(userId: string) {
	if (!userId) {
		throw new Error('userId is required');
	}

	const result = await db
		.select({ count: userConversations.id })
		.from(userConversations)
		.where(eq(userConversations.userId, userId));

	return {
		success: true,
		count: result.length,
	};
}

/**
 * Get a conversation by userPrompt (stored inside the response JSON)
 *
 * `onlyStatus` matters for the exact-match cache lookup (see
 * conversation-history.exactMatch in backend/src/collections/user-conversations.ts):
 * without it, a prior FAILED attempt at the same prompt could get matched and
 * replayed to a new asker as if it were a valid cached answer. deleteByUserPrompt
 * intentionally omits it — a failed row should still be deletable by its prompt.
 */
export async function getConversationByUserPrompt(userPrompt: string, userId?: string, onlyStatus?: string, maxAgeHours?: number, threadId?: string) {
	if (!userPrompt) {
		throw new Error('userPrompt is required');
	}

	const conditions = [sql`${userConversations.response}->>'user_prompt' = ${userPrompt}`];
	if (userId) {
		conditions.push(eq(userConversations.userId, userId));
	}
	// Replay stays within the thread it was asked in: the same words in a new
	// thread are a new question.
	if (threadId) {
		conditions.push(eq(userConversations.threadid, threadId));
	}
	if (onlyStatus) {
		conditions.push(eq(userConversations.status, onlyStatus));
	}
	// Replay window: an answer with relative dates ("last 3 months") goes stale.
	if (maxAgeHours && maxAgeHours > 0) {
		conditions.push(sql`${userConversations.createdAt} >= now() - make_interval(hours => ${Math.floor(maxAgeHours)})`);
	}

	const result = await db
		.select()
		.from(userConversations)
		.where(and(...conditions))
		// Newest first: without an order, LIMIT 1 could replay any older duplicate.
		.orderBy(desc(userConversations.createdAt))
		.limit(1);

	if (result.length === 0) {
		return { success: false, data: null };
	}

	return { success: true, data: result[0] };
}

/**
 * Delete a conversation by userPrompt (stored inside the response JSON)
 */
export async function deleteConversationByUserPrompt(userPrompt: string, userId?: string) {
	if (!userPrompt) {
		throw new Error('userPrompt is required');
	}

	const conditions = [sql`${userConversations.response}->>'user_prompt' = ${userPrompt}`];
	if (userId) {
		conditions.push(eq(userConversations.userId, userId));
	}

	const result = await db
		.delete(userConversations)
		.where(and(...conditions))
		.returning();

	if (result.length === 0) {
		return { success: false, data: null, message: 'Conversation not found' };
	}

	await deleteThreadRowIfEmpty(result[0].threadid);

	return { success: true, data: result[0], message: 'Conversation deleted successfully' };
}

/**
 * The recent script-backed answers in a thread — the candidate set a
 * user-directed edit can target.
 *
 * Two problems this solves:
 *
 *  1. DURABILITY. The in-memory ThreadManager is the fast path, but it dies with
 *     the process. After a restart the backend re-creates the thread with zero
 *     UIBlocks, so there is no binding, the matcher correctly coerces `edit` →
 *     `none`, and "use the mode instead" silently degrades into a general
 *     question. The binding is already persisted here; only the read was missing.
 *
 *  2. DISAMBIGUATION. Returning only the newest binding forces every edit onto
 *     the most recent script. In a thread that ran several scripts, an
 *     instruction meant for an earlier one silently edits the wrong recipe —
 *     committing a version, superseding caches and renaming a file the user
 *     never mentioned. Handing the matcher a short candidate list lets the
 *     instruction pick its own target.
 *
 * Scoped to ONE thread on purpose. An edit is a conversational act — it refers
 * to something the user is looking at. Widening this to every thread would turn
 * the candidate set back into the full catalog and reintroduce exactly the
 * loose-inference failure that retired the `near` tier.
 *
 * Superseded rows stay eligible: their answer is stale, but the binding still
 * records which recipe the user is looking at, which is all the matcher needs.
 * Deduped by recipeId (newest occurrence wins) so a long editing session on one
 * script doesn't crowd out the others.
 *
 * See backend/docs/SCRIPT-EDIT-DESIGN.md § Component 1.
 */
export async function getThreadScriptBindings(params: {
	threadId: string;
	userId?: string;
	limit?: number;
	excludeUiBlockId?: string;
}) {
	const { threadId, userId, limit = 5, excludeUiBlockId } = params;
	if (!threadId) {
		throw new Error('threadId is required');
	}

	const conditions = [
		eq(userConversations.threadid, threadId),
		sql`${userConversations.response}->'scriptBinding'->>'recipeId' IS NOT NULL`,
	];
	if (userId) {
		conditions.push(eq(userConversations.userId, userId));
	}
	if (excludeUiBlockId) {
		// The in-flight turn's own block — it has no answer yet.
		conditions.push(sql`${userConversations.response}->>'id' IS DISTINCT FROM ${excludeUiBlockId}`);
	}

	// Over-fetch before dedupe: N turns can collapse to far fewer distinct recipes.
	const rows = await db
		.select({
			binding: sql<any>`${userConversations.response}->'scriptBinding'`,
			userPrompt: userConversations.userprompt,
		})
		.from(userConversations)
		.where(and(...conditions))
		.orderBy(desc(userConversations.createdAt))
		.limit(Math.max(limit * 4, 20));

	const seen = new Set<string>();
	const out: any[] = [];
	for (const r of rows) {
		const recipeId = r.binding?.recipeId;
		if (!recipeId || seen.has(recipeId)) continue;
		seen.add(recipeId);
		// Carry the question that produced this answer — without it the candidates
		// are indistinguishable and the matcher cannot resolve "the WSP one".
		out.push({ ...r.binding, userPrompt: r.userPrompt });
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Retire every cached answer produced by a given script recipe, so none of them
 * can be replayed after the recipe's body changed.
 *
 * Called after a user-directed script edit commits. The exact-match cache is
 * gate 0 of the answer flow — it short-circuits BEFORE the script matcher runs
 * — so without this the user corrects a script, re-asks the original question
 * verbatim, and gets served the PRE-EDIT answer. The corrected script never
 * executes and the edit looks like it did nothing.
 *
 * Two of the three cached artefacts never self-heal: the stored `analysis` text
 * is returned verbatim, and real-SQL components rehydrate the SQL captured at
 * AUTHORING time via `_queryMap`. Only computed (`script_dataset`) datasets
 * eventually regenerate, and only once their queryCache entry evicts.
 *
 * We mark rather than DELETE. `status` is consulted in exactly one place —
 * `getConversationByUserPrompt(..., 'success')`, which only the exact-match
 * cache passes — so flipping it to 'superseded' disables replay while leaving
 * the row fully intact in the user's thread history. Deleting would destroy
 * real conversation history to solve a cache problem.
 *
 * Scoped to a user when `userId` is given; otherwise retires the recipe's
 * cached answers project-wide (recipes are shared, so a correction supersedes
 * everyone's copies). The predicate matches the FLAT DBUIBlock written by
 * transformUIBlockForDB (`response->'scriptBinding'->>'recipeId'`) and is
 * index-backed by idx_user_conversations_script_recipe.
 *
 * See backend/docs/SCRIPT-EDIT-DESIGN.md § Component 5.
 */
export async function supersedeConversationsByScriptRecipe(recipeId: string, userId?: string) {
	if (!recipeId) {
		throw new Error('recipeId is required');
	}

	const conditions = [
		sql`${userConversations.response}->'scriptBinding'->>'recipeId' = ${recipeId}`,
		eq(userConversations.status, 'success'),
	];
	if (userId) {
		conditions.push(eq(userConversations.userId, userId));
	}

	const result = await db
		.update(userConversations)
		.set({ status: 'superseded', updatedAt: new Date().toISOString() })
		.where(and(...conditions))
		.returning({ id: userConversations.id });

	return { success: true, count: result.length, message: `Superseded ${result.length} cached answer(s)` };
}

/**
 * Get a conversation by uiBlockId (stored inside the response JSON)
 */
export async function getConversationByUiBlockId(uiBlockId: string) {
	if (!uiBlockId) {
		throw new Error('uiBlockId is required');
	}

	const result = await db
		.select()
		.from(userConversations)
		.where(sql`${userConversations.response}->>'id' = ${uiBlockId}`)
		.limit(1);

	if (result.length === 0) {
		return {
			success: false,
			data: null,
		};
	}

	return {
		success: true,
		data: result[0],
	};
}

/**
 * Delete a conversation by uiBlockId (stored inside the response JSON)
 */
export async function deleteConversationByUiBlockId(uiBlockId: string) {
	if (!uiBlockId) {
		throw new Error('uiBlockId is required');
	}

	const result = await db
		.delete(userConversations)
		.where(sql`${userConversations.response}->>'id' = ${uiBlockId}`)
		.returning();

	if (result.length === 0) {
		return {
			success: false,
			data: null,
			message: `Conversation with uiBlockId ${uiBlockId} not found`,
		};
	}

	await deleteThreadRowIfEmpty(result[0].threadid);

	return {
		success: true,
		data: result[0],
		message: 'Conversation deleted successfully',
	};
}

/**
 * Save a debug trace for a conversation turn (retrieved KB/schema nodes, the
 * script that ran, etc — see CHAT-DEBUG-TRACE-DESIGN.md in do-websocket/packages/api).
 *
 * `conversationId` is a soft pointer to user_conversations.id — no FK, no
 * cascade — so the trace survives even if the conversation it describes is
 * later deleted. Best-effort by design: the caller (sdk-nodejs) wraps this in
 * try/catch and must never let a capture failure affect the actual answer;
 * this function itself just does a normal insert and lets errors propagate.
 */
export async function saveConversationTrace(params: {
	conversationId: number;
	// 'chat_agent' | 'dashboard' | 'report' — same values as chat_analytics.type
	// / sdk-nodejs's AnalyticsEventType. Required: conversationId is only
	// unique WITHIN its own source table (user_conversations /
	// dashboard_agent_conversations / reports_conversations each have their
	// own id sequence), so without type, a chat conversation #50 and a
	// dashboard conversation #50 are indistinguishable at read time.
	type: string;
	userId: string;
	threadId?: string | null;
	trace: unknown;
}) {
	const { conversationId, type, userId, threadId, trace } = params;

	if (!conversationId) {
		throw new Error('conversationId is required');
	}

	if (!type) {
		throw new Error('type is required');
	}

	if (!userId) {
		throw new Error('userId is required');
	}

	if (trace === undefined || trace === null) {
		throw new Error('trace is required');
	}

	const result = await db
		.insert(conversationTraces)
		.values({
			conversationId,
			type,
			userId,
			threadId: threadId || null,
			trace: trace as any,
		})
		.returning();

	return {
		success: true,
		data: { id: result[0].id },
		message: 'Conversation trace saved successfully',
	};
}

/**
 * Fetch the most recent debug trace for a (conversationId, type) pair (there
 * should normally be exactly one row for that pair, but
 * `createdAt DESC LIMIT 1` guards against duplicates — e.g. a retried save).
 * Returns `null` when no trace has been captured for this conversation.
 *
 * `type` is required, not optional — conversationId alone is ambiguous
 * across source tables (see the `type` column comment on conversationTraces
 * in schema.ts). Querying without it risks silently returning a different
 * conversation's trace.
 */
export async function getConversationTrace(conversationId: number, type: string) {
	if (!conversationId) {
		throw new Error('conversationId is required');
	}

	if (!type) {
		throw new Error('type is required');
	}

	const result = await db
		.select({
			trace: conversationTraces.trace,
			createdAt: conversationTraces.createdAt,
		})
		.from(conversationTraces)
		.where(and(
			eq(conversationTraces.conversationId, conversationId),
			eq(conversationTraces.type, type),
		))
		.orderBy(desc(conversationTraces.createdAt))
		.limit(1);

	if (result.length === 0) {
		return null;
	}

	return result[0];
}

/**
 * Keep at most `maxRows` conversation_traces rows FOR A GIVEN TYPE
 * ('chat_agent' | 'dashboard' | 'report') — delete that type's oldest excess
 * (by createdAt), in batches of `batchSize` per DELETE so a large backlog
 * doesn't hold a long-running lock on the table.
 *
 * Scoped per type, not a global cap across all types, so a burst in one flow
 * (e.g. a lot of dashboard generation on a given day) can never crowd out
 * every other type's traces entirely — each type always keeps its own most
 * recent `maxRows` regardless of how the other types behave. Call once per
 * type (see trace-cleanup-scheduler.ts). A row-count cap is more predictable
 * than a day-based TTL for sizing storage: at this table's current average
 * of ~60KB/row, 1000 rows per type is roughly ~60MB per type, regardless of
 * how bursty question volume gets on any given day.
 */
export async function enforceConversationTraceRowCap(type: string, maxRows: number, batchSize = 1000): Promise<{ deleted: number }> {
	let totalDeleted = 0;

	while (true) {
		const [{ count }] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(conversationTraces)
			.where(eq(conversationTraces.type, type));
		const excess = count - maxRows;
		if (excess <= 0) break;

		const idsToDelete = await db
			.select({ id: conversationTraces.id })
			.from(conversationTraces)
			.where(eq(conversationTraces.type, type))
			.orderBy(asc(conversationTraces.createdAt))
			.limit(Math.min(excess, batchSize));

		if (idsToDelete.length === 0) break;

		await db.delete(conversationTraces).where(inArray(conversationTraces.id, idsToDelete.map(r => r.id)));
		totalDeleted += idsToDelete.length;
	}

	return { deleted: totalDeleted };
}
