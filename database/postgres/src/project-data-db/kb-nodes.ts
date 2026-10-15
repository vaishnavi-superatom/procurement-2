import { db, schema } from './drizzle-db';
import { eq, and, or, like, sql, desc } from 'drizzle-orm';

const { kbNodes } = schema;

/**
 * Knowledge Base Nodes CRUD Operations using Drizzle ORM
 */

export type KbNodeType = 'global' | 'user' | 'query';

export interface CreateKbNodeParams {
  title: string;
  content: string;
  category?: string;
  tags?: string[];
  type?: KbNodeType;
  createdBy: string;
}

export interface UpdateKbNodeParams {
  id: number;
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
  type?: KbNodeType;
  updatedBy: string;
}

export interface GetKbNodeParams {
  id: number;
}

export interface DeleteKbNodeParams {
  id: number;
}

export interface SearchKbNodesParams {
  query?: string;
  category?: string;
  tags?: string[];
  type?: KbNodeType;
  createdBy?: string;
  limit?: number;
  offset?: number;
}

export interface GetKbNodesByCategoryParams {
  category: string;
  limit?: number;
  offset?: number;
}

export interface GetKbNodesByUserParams {
  userId: string;
  limit?: number;
  offset?: number;
}

/**
 * Create a new knowledge base node
 */
export async function createKbNode(params: CreateKbNodeParams) {
  const { title, content, category, tags, type, createdBy } = params;

  if (!title || title.trim().length === 0) {
    throw new Error('title is required');
  }

  if (!content || content.trim().length === 0) {
    throw new Error('content is required');
  }

  if (!createdBy) {
    throw new Error('createdBy is required');
  }

  const result = await db
    .insert(kbNodes)
    .values({
      title,
      content,
      category: category || null,
      tags: tags || null,
      type: type || 'query',
      createdBy,
      updatedBy: createdBy,
    })
    .returning();

  return {
    success: true,
    data: result[0],
    message: 'Knowledge node created successfully',
  };
}

/**
 * Get all knowledge base nodes
 */
export async function getAllKbNodes(limit: number = 100, offset: number = 0) {
  const result = await db
    .select()
    .from(kbNodes)
    .orderBy(desc(kbNodes.createdAt))
    .limit(limit)
    .offset(offset);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Get a single knowledge base node by ID
 */
export async function getKbNode(params: GetKbNodeParams) {
  const { id } = params;

  if (!id) {
    throw new Error('Knowledge node ID is required');
  }

  const result = await db
    .select()
    .from(kbNodes)
    .where(eq(kbNodes.id, id))
    .limit(1);

  if (result.length === 0) {
    throw new Error(`Knowledge node with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
  };
}

/**
 * Update a knowledge base node
 */
export async function updateKbNode(params: UpdateKbNodeParams) {
  const { id, title, content, category, tags, type, updatedBy } = params;

  if (!id) {
    throw new Error('Knowledge node ID is required');
  }

  if (!updatedBy) {
    throw new Error('updatedBy is required');
  }

  const updateData: any = {
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  if (title !== undefined) {
    updateData.title = title;
  }

  if (content !== undefined) {
    updateData.content = content;
  }

  if (category !== undefined) {
    updateData.category = category;
  }

  if (tags !== undefined) {
    updateData.tags = tags;
  }

  if (type !== undefined) {
    updateData.type = type;
  }

  const result = await db
    .update(kbNodes)
    .set(updateData)
    .where(eq(kbNodes.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Knowledge node with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: 'Knowledge node updated successfully',
  };
}

/**
 * Delete a knowledge base node
 */
export async function deleteKbNode(params: DeleteKbNodeParams) {
  const { id } = params;

  if (!id) {
    throw new Error('Knowledge node ID is required');
  }

  const result = await db
    .delete(kbNodes)
    .where(eq(kbNodes.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Knowledge node with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: 'Knowledge node deleted successfully',
  };
}

/**
 * Search knowledge base nodes with full-text search and filters
 */
export async function searchKbNodes(params: SearchKbNodesParams) {
  const { query, category, tags, type, createdBy, limit = 50, offset = 0 } = params;

  let conditions = [];

  // Full-text search on title and content
  if (query && query.trim().length > 0) {
    conditions.push(
      or(
        sql`to_tsvector('english', ${kbNodes.title}) @@ plainto_tsquery('english', ${query})`,
        sql`to_tsvector('english', ${kbNodes.content}) @@ plainto_tsquery('english', ${query})`
      )
    );
  }

  // Filter by category
  if (category) {
    conditions.push(eq(kbNodes.category, category));
  }

  // Filter by tags (array contains)
  if (tags && tags.length > 0) {
    conditions.push(sql`${kbNodes.tags} && ${tags}`);
  }

  // Filter by type
  if (type) {
    conditions.push(eq(kbNodes.type, type));
  }

  // Filter by creator
  if (createdBy) {
    conditions.push(eq(kbNodes.createdBy, createdBy));
  }

  let result;

  if (conditions.length > 0) {
    result = await db
      .select()
      .from(kbNodes)
      .where(and(...conditions))
      .orderBy(desc(kbNodes.createdAt))
      .limit(limit)
      .offset(offset);
  } else {
    result = await db
      .select()
      .from(kbNodes)
      .orderBy(desc(kbNodes.createdAt))
      .limit(limit)
      .offset(offset);
  }

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Get knowledge base nodes by category
 */
export async function getKbNodesByCategory(params: GetKbNodesByCategoryParams) {
  const { category, limit = 50, offset = 0 } = params;

  if (!category) {
    throw new Error('category is required');
  }

  const result = await db
    .select()
    .from(kbNodes)
    .where(eq(kbNodes.category, category))
    .orderBy(desc(kbNodes.createdAt))
    .limit(limit)
    .offset(offset);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Get knowledge base nodes by user (creator)
 */
export async function getKbNodesByUser(params: GetKbNodesByUserParams) {
  const { userId, limit = 50, offset = 0 } = params;

  if (!userId) {
    throw new Error('userId is required');
  }

  const result = await db
    .select()
    .from(kbNodes)
    .where(eq(kbNodes.createdBy, userId))
    .orderBy(desc(kbNodes.createdAt))
    .limit(limit)
    .offset(offset);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Get all unique categories
 */
export async function getAllCategories() {
  const result = await db
    .selectDistinct({ category: kbNodes.category })
    .from(kbNodes)
    .where(sql`${kbNodes.category} IS NOT NULL`)
    .orderBy(kbNodes.category);

  return {
    success: true,
    data: result.map((r) => r.category),
    count: result.length,
  };
}

/**
 * Get all unique tags
 */
export async function getAllTags() {
  const result = await db
    .select({ tags: kbNodes.tags })
    .from(kbNodes)
    .where(sql`${kbNodes.tags} IS NOT NULL`);

  // Flatten and deduplicate tags
  const allTags = new Set<string>();
  result.forEach((r) => {
    if (r.tags && Array.isArray(r.tags)) {
      r.tags.forEach((tag) => allTags.add(tag));
    }
  });

  const uniqueTags = Array.from(allTags).sort();

  return {
    success: true,
    data: uniqueTags,
    count: uniqueTags.length,
  };
}
