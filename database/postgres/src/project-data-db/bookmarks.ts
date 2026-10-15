import { db, schema } from './drizzle-db';
import { eq, and, asc, desc, SQL, sql, or } from 'drizzle-orm';

const { bookmarks } = schema;

/**
 * DBUIBlock represents the unified UIBlock structure for database storage
 * Used in bookmarks and user-conversations tables
 */
export interface DBUIBlock {
  id: string;
  component: Record<string, any> | null;
  analysis: string | null;
  user_prompt: string;
}

/**
 * Bookmark CRUD Operations using Drizzle ORM
 */

export interface CreateBookmarkParams {
  userId: string;
  threadId?: string;
  name?: string;
  description?: string;
  uiblock: DBUIBlock;
}

export interface UpdateBookmarkParams {
  id: number;
  threadId?: string;
  name?: string;
  description?: string;
  uiblock?: DBUIBlock;
}

export interface GetBookmarkParams {
  id: number;
}

export interface DeleteBookmarkParams {
  id: number;
}

export interface GetBookmarksByUserParams {
  userId: string;
  threadId?: string;
}

export interface GetBookmarksByThreadParams {
  threadId: string;
}

export interface QueryBookmarksParams {
  filters?: {
    userId?: string;
    threadId?: string;
    name?: string;
  };
  limit?: number;
  sort?: 'ASC' | 'DESC';
}

/**
 * Create a new bookmark
 */
export async function createBookmark(params: CreateBookmarkParams) {
  const { userId, threadId, name, description, uiblock } = params;

  if (!userId) {
    throw new Error('userId is required');
  }

  if (!uiblock) {
    throw new Error('uiblock is required');
  }

  const result = await db
    .insert(bookmarks)
    .values({
      userId,
      threadId: threadId || null,
      name: name || null,
      description: description || null,
      uiblock,
    })
    .returning();

  return {
    success: true,
    data: result[0],
    message: 'Bookmark created successfully',
  };
}

/**
 * Get all bookmarks
 */
export async function getAllBookmarks() {
  const result = await db.select().from(bookmarks).orderBy(bookmarks.createdAt);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Get a single bookmark by ID
 */
export async function getBookmark(params: GetBookmarkParams) {
  const { id } = params;

  if (!id) {
    throw new Error('Bookmark ID is required');
  }

  const result = await db
    .select()
    .from(bookmarks)
    .where(eq(bookmarks.id, id))
    .limit(1);

  if (result.length === 0) {
    throw new Error(`Bookmark with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
  };
}

/**
 * Update a bookmark
 */
export async function updateBookmark(params: UpdateBookmarkParams) {
  const { id, threadId, name, description, uiblock } = params;

  if (!id) {
    throw new Error('Bookmark ID is required');
  }

  const updateData: any = {
    updatedAt: new Date().toISOString(),
  };

  if (uiblock !== undefined) {
    updateData.uiblock = uiblock;
  }

  if (threadId !== undefined) {
    updateData.threadId = threadId;
  }

  if (name !== undefined) {
    updateData.name = name;
  }

  if (description !== undefined) {
    updateData.description = description;
  }

  const result = await db
    .update(bookmarks)
    .set(updateData)
    .where(eq(bookmarks.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Bookmark with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: 'Bookmark updated successfully',
  };
}

/**
 * Delete a bookmark
 */
export async function deleteBookmark(params: DeleteBookmarkParams) {
  const { id } = params;

  if (!id) {
    throw new Error('Bookmark ID is required');
  }

  const result = await db
    .delete(bookmarks)
    .where(eq(bookmarks.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Bookmark with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: 'Bookmark deleted successfully',
  };
}

/**
 * Get bookmarks by userId (and optionally by threadId)
 */
export async function getBookmarksByUser(params: GetBookmarksByUserParams) {
  const { userId, threadId } = params;

  if (!userId) {
    throw new Error('userId is required');
  }

  let result;

  if (threadId) {
    result = await db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, userId), eq(bookmarks.threadId, threadId)))
      .orderBy(bookmarks.createdAt);
  } else {
    result = await db
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.userId, userId))
      .orderBy(bookmarks.createdAt);
  }

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Get bookmarks by threadId
 */
export async function getBookmarksByThread(params: GetBookmarksByThreadParams) {
  const { threadId } = params;

  if (!threadId) {
    throw new Error('threadId is required');
  }

  const result = await db
    .select()
    .from(bookmarks)
    .where(eq(bookmarks.threadId, threadId))
    .orderBy(bookmarks.createdAt);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Query bookmarks with filters, limit, and sort
 */
export async function queryBookmarks(params: QueryBookmarksParams) {
  const { filters = {}, limit = 50, sort = 'DESC' } = params;

  // Build filter conditions
  const conditions: SQL[] = [];

  if (filters.userId) {
    conditions.push(eq(bookmarks.userId, filters.userId));
  }

  if (filters.threadId) {
    conditions.push(eq(bookmarks.threadId, filters.threadId));
  }

  if (filters.name) {
    conditions.push(eq(bookmarks.name, filters.name));
  }

  // Build query
  let query = db.select().from(bookmarks);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  // Apply sort
  const orderBy = sort === 'ASC' ? asc(bookmarks.createdAt) : desc(bookmarks.createdAt);
  query = query.orderBy(orderBy) as typeof query;

  // Apply limit
  query = query.limit(limit) as typeof query;

  const result = await query;

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Search bookmarks params
 */
export interface SearchBookmarksParams {
  query: string;
  userId: string;
  limit?: number;
}

/**
 * Search bookmarks using PostgreSQL full-text search
 * Searches in user_prompt and analysis fields of the uiblock JSONB
 */
export async function searchBookmarks(params: SearchBookmarksParams) {
  const { query, userId, limit = 5 } = params;

  if (!query || query.trim().length === 0) {
    throw new Error('Search query is required');
  }

  if (!userId) {
    throw new Error('userId is required');
  }

  // Use PostgreSQL full-text search on JSONB fields
  // Search in uiblock->>'user_prompt' and uiblock->>'analysis'
  // Also include ILIKE for partial matches
  const result = await db
    .select()
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.userId, userId),
        or(
          sql`to_tsvector('english', COALESCE(${bookmarks.uiblock}->>'user_prompt', '')) @@ plainto_tsquery('english', ${query})`,
          sql`to_tsvector('english', COALESCE(${bookmarks.uiblock}->>'analysis', '')) @@ plainto_tsquery('english', ${query})`,
          sql`LOWER(COALESCE(${bookmarks.uiblock}->>'user_prompt', '')) LIKE LOWER(${'%' + query + '%'})`,
          sql`LOWER(COALESCE(${bookmarks.uiblock}->>'analysis', '')) LIKE LOWER(${'%' + query + '%'})`
        )
      )
    )
    .orderBy(desc(bookmarks.createdAt))
    .limit(limit);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}
