import { db, schema } from "./drizzle-db";
import { eq, and, asc, desc, sql, SQL } from "drizzle-orm";

const { menus } = schema;

/**
 * Menu CRUD Operations using Drizzle ORM
 * Manages dynamic sidebar menu items via menu_json
 */

export interface CreateMenuParams {
  name: string;
  menuJson?: Record<string, unknown>;
  version?: number;
  isActive?: boolean;
}

export interface UpdateMenuParams {
  id: number;
  name?: string;
  menuJson?: Record<string, unknown>;
  version?: number;
  isActive?: boolean;
}

export interface GetMenuParams {
  id: number;
}

export interface DeleteMenuParams {
  id: number;
}

export interface QueryMenusParams {
  filters?: {
    isActive?: boolean;
  };
  limit?: number;
  sort?: "ASC" | "DESC";
}

/**
 * Create a new menu item
 */
export async function createMenu(params: CreateMenuParams) {
  const { name, menuJson, version, isActive } = params;

  if (!name) {
    throw new Error("name is required");
  }

  const result = await db
    .insert(menus)
    .values({
      name,
      menuJson: menuJson || null,
      version: version || null,
      isActive: isActive ?? true,
    })
    .returning();

  console.log("[MENUS] Created menu:", result[0]);

  return {
    success: true,
    data: result[0],
    message: "Menu created successfully",
  };
}

/**
 * Get a single menu item by ID
 */
export async function getMenu(params: GetMenuParams) {
  const { id } = params;

  if (!id) {
    throw new Error("Menu ID is required");
  }

  const result = await db
    .select()
    .from(menus)
    .where(eq(menus.id, id))
    .limit(1);

  if (result.length === 0) {
    throw new Error(`Menu with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
  };
}

/**
 * Get all menus
 */
export async function getAllMenus(limit: number = 100) {
  const result = await db
    .select()
    .from(menus)
    .orderBy(asc(menus.id))
    .limit(limit);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Query menus with filters, limit, and sort
 */
export async function queryMenus(params: QueryMenusParams) {
  const { filters = {}, limit = 50, sort = "ASC" } = params;

  const conditions: SQL[] = [];

  if (filters.isActive !== undefined) {
    conditions.push(eq(menus.isActive, filters.isActive));
  }

  let query = db.select().from(menus);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  const orderBy = sort === "ASC" ? asc(menus.id) : desc(menus.id);
  query = query.orderBy(orderBy) as typeof query;
  query = query.limit(limit) as typeof query;

  const result = await query;

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Update a menu item
 */
export async function updateMenu(params: UpdateMenuParams) {
  const { id, name, menuJson, version, isActive } = params;

  if (!id) {
    throw new Error("Menu ID is required");
  }

  const updateData: any = {
    updatedAt: new Date().toISOString(),
  };

  if (name !== undefined) updateData.name = name;
  if (menuJson !== undefined) updateData.menuJson = menuJson;
  if (version !== undefined) updateData.version = version;
  if (isActive !== undefined) updateData.isActive = isActive;

  const result = await db
    .update(menus)
    .set(updateData)
    .where(eq(menus.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Menu with ID ${id} not found`);
  }

  console.log("[MENUS] Menu updated successfully:", result[0]);

  return {
    success: true,
    data: result[0],
    message: "Menu updated successfully",
  };
}

/**
 * Delete a menu item
 */
export async function deleteMenu(params: DeleteMenuParams) {
  const { id } = params;

  if (!id) {
    throw new Error("Menu ID is required");
  }

  const result = await db
    .delete(menus)
    .where(eq(menus.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Menu with ID ${id} not found`);
  }

  console.log(`[MENUS] Deleted menu ID: ${id}`);

  return {
    success: true,
    data: result[0],
    message: "Menu deleted successfully",
  };
}
