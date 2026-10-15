import { db, schema } from './drizzle-db';
import { eq, and, asc, desc, SQL } from 'drizzle-orm';
import type { DSLRendererProps } from './dsl-types';

const { uis } = schema;

/**
 * UI CRUD Operations using Drizzle ORM
 */

export interface CreateUIParams {
  uiId: string;
  projectId: string;
  name?: string;
  description?: string;
  ui?: DSLRendererProps;
  createdBy?: string;
}

export interface UpdateUIParams {
  id: number;
  name?: string;
  description?: string;
  ui?: DSLRendererProps;
  createdBy?: string;
  updatedBy?: string;
}

export interface GetUIParams {
  id: number;
}

export interface DeleteUIParams {
  id: number;
}

export interface QueryUIsParams {
  filters?: {
    uiId?: string;
    projectId?: string;
    createdBy?: string;
    updatedBy?: string;
    name?: string;
  };
  limit?: number;
  sort?: 'ASC' | 'DESC';
}

/**
 * Create a new UI
 */
export async function createUI(params: CreateUIParams) {
  const { uiId, projectId, name, description, ui, createdBy } = params;

  if (!uiId) {
    throw new Error('uiId is required');
  }

  if (!projectId) {
    throw new Error('projectId is required');
  }

  const result = await db
    .insert(uis)
    .values({
      uiId,
      projectId,
      name: name || null,
      description: description || null,
      ui: ui || null,
      createdBy: createdBy || null,
    })
    .returning();

  return {
    success: true,
    data: result[0],
    message: 'UI created successfully',
  };
}

/**
 * Get all UIs
 */
export async function getAllUIs(limit: number = 50) {
  const result = await db.select().from(uis).orderBy(uis.createdAt).limit(limit);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Get a single UI by ID
 */
export async function getUI(params: GetUIParams) {
  const { id } = params;

  if (!id) {
    throw new Error('UI ID is required');
  }

  const result = await db
    .select()
    .from(uis)
    .where(eq(uis.id, id))
    .limit(1);

  if (result.length === 0) {
    throw new Error(`UI with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
  };
}

/**
 * Query UIs with filters, limit, and sort
 */
export async function queryUIs(params: QueryUIsParams) {
  const { filters = {}, limit = 50, sort = 'DESC' } = params;

  // Build filter conditions
  const conditions: SQL[] = [];

  if (filters.uiId) {
    conditions.push(eq(uis.uiId, filters.uiId));
  }

  if (filters.projectId) {
    conditions.push(eq(uis.projectId, filters.projectId));
  }

  if (filters.createdBy) {
    conditions.push(eq(uis.createdBy, filters.createdBy));
  }

  if (filters.updatedBy) {
    conditions.push(eq(uis.updatedBy, filters.updatedBy));
  }

  if (filters.name) {
    conditions.push(eq(uis.name, filters.name));
  }

  // Build query
  let query = db.select().from(uis);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  // Apply sort
  const orderBy = sort === 'ASC' ? asc(uis.createdAt) : desc(uis.createdAt);
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
 * Update a UI
 */
export async function updateUI(params: UpdateUIParams) {
  const { id, name, description, ui, createdBy, updatedBy } = params;

  if (!id) {
    throw new Error('UI ID is required');
  }

  const updateData: any = {
    updatedAt: new Date().toISOString(),
  };

  if (ui !== undefined) {
    updateData.ui = ui;
  }

  if (name !== undefined) {
    updateData.name = name;
  }

  if (description !== undefined) {
    updateData.description = description;
  }

  if (createdBy !== undefined) {
    updateData.createdBy = createdBy;
  }

  if (updatedBy !== undefined) {
    updateData.updatedBy = updatedBy;
  }

  const result = await db
    .update(uis)
    .set(updateData)
    .where(eq(uis.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`UI with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: 'UI updated successfully',
  };
}

/**
 * Delete a UI
 */
export async function deleteUI(params: DeleteUIParams) {
  const { id } = params;

  if (!id) {
    throw new Error('UI ID is required');
  }

  const result = await db
    .delete(uis)
    .where(eq(uis.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`UI with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: 'UI deleted successfully',
  };
}
