import { db, schema } from "./drizzle-db";
import { eq, and, asc, desc, SQL } from "drizzle-orm";
import type { DSLRendererProps } from "./dsl-types";

const { dashboards } = schema;

/**
 * Dashboard CRUD Operations using Drizzle ORM
 */

export interface CreateDashboardParams {
  dashboardId: string;
  projectId: string;
  name?: string;
  description?: string;
  dashboard?: DSLRendererProps;
  published?: boolean;
  createdBy?: string;
  allowedUsers?: string[];
}

export interface UpdateDashboardParams {
  id: number;
  name?: string;
  description?: string;
  dashboard?: DSLRendererProps;
  published?: boolean;
  createdBy?: string;
  updatedBy?: string;
  allowedUsers?: string[];
}

export interface GetDashboardParams {
  id: number;
}

export interface DeleteDashboardParams {
  id: number;
}

export interface QueryDashboardsParams {
  filters?: {
    dashboardId?: string;
    projectId?: string;
    createdBy?: string;
    updatedBy?: string;
    name?: string;
    published?: boolean;
  };
  limit?: number;
  sort?: "ASC" | "DESC";
}

/**
 * Create a new dashboard
 * Note: createdBy is automatically added to allowedUsers if provided
 */
export async function createDashboard(params: CreateDashboardParams) {
  const {
    dashboardId,
    projectId,
    name,
    description,
    dashboard,
    published,
    createdBy,
    allowedUsers,
  } = params;

  if (!dashboardId) {
    throw new Error("dashboardId is required");
  }

  if (!projectId) {
    throw new Error("projectId is required");
  }

  // Build allowedUsers array - include createdBy automatically if provided
  let finalAllowedUsers: string[] = allowedUsers ? [...allowedUsers] : [];
  if (createdBy && !finalAllowedUsers.includes(createdBy)) {
    finalAllowedUsers.push(createdBy);
  }

  const result = await db
    .insert(dashboards)
    .values({
      dashboardId,
      projectId,
      name: name || null,
      description: description || null,
      dashboard: dashboard || null,
      published: published ?? false,
      createdBy: createdBy || null,
      allowedUsers: finalAllowedUsers,
    })
    .returning();

  return {
    success: true,
    data: result[0],
    message: "Dashboard created successfully",
  };
}

/**
 * Get all dashboards
 */
export async function getAllDashboards(limit: number = 50) {
  const result = await db
    .select()
    .from(dashboards)
    .orderBy(dashboards.createdAt)
    .limit(limit);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Get a single dashboard by ID
 */
export async function getDashboard(params: GetDashboardParams) {
  const { id } = params;

  if (!id) {
    throw new Error("Dashboard ID is required");
  }

  const result = await db
    .select()
    .from(dashboards)
    .where(eq(dashboards.id, id))
    .limit(1);

  if (result.length === 0) {
    throw new Error(`Dashboard with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
  };
}

/**
 * Query dashboards with filters, limit, and sort
 */
export async function queryDashboards(params: QueryDashboardsParams) {
  const { filters = {}, limit = 50, sort = "DESC" } = params;

  // Build filter conditions
  const conditions: SQL[] = [];

  if (filters.dashboardId) {
    conditions.push(eq(dashboards.dashboardId, filters.dashboardId));
  }

  if (filters.projectId) {
    conditions.push(eq(dashboards.projectId, filters.projectId));
  }

  if (filters.createdBy) {
    conditions.push(eq(dashboards.createdBy, filters.createdBy));
  }

  if (filters.updatedBy) {
    conditions.push(eq(dashboards.updatedBy, filters.updatedBy));
  }

  if (filters.name) {
    conditions.push(eq(dashboards.name, filters.name));
  }

  if (filters.published !== undefined) {
    conditions.push(eq(dashboards.published, filters.published));
  }

  // Build query
  let query = db.select().from(dashboards);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  // Apply sort
  const orderBy =
    sort === "ASC" ? asc(dashboards.createdAt) : desc(dashboards.createdAt);
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
 * Update a dashboard
 */
export async function updateDashboard(params: UpdateDashboardParams) {
  const {
    id,
    name,
    description,
    dashboard,
    published,
    createdBy,
    updatedBy,
    allowedUsers,
  } = params;

  if (!id) {
    throw new Error("Dashboard ID is required");
  }

  const updateData: any = {
    updatedAt: new Date().toISOString(),
  };

  if (dashboard !== undefined) {
    updateData.dashboard = dashboard;
  }

  if (name !== undefined) {
    updateData.name = name;
  }

  if (description !== undefined) {
    updateData.description = description;
  }

  if (published !== undefined) {
    updateData.published = published;
  }

  if (createdBy !== undefined) {
    updateData.createdBy = createdBy;
  }

  if (updatedBy !== undefined) {
    updateData.updatedBy = updatedBy;
  }

  if (allowedUsers !== undefined) {
    updateData.allowedUsers = allowedUsers;
  }

  const result = await db
    .update(dashboards)
    .set(updateData)
    .where(eq(dashboards.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Dashboard with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: "Dashboard updated successfully",
  };
}

/**
 * Delete a dashboard
 */
export async function deleteDashboard(params: DeleteDashboardParams) {
  const { id } = params;

  if (!id) {
    throw new Error("Dashboard ID is required");
  }

  // First, get the dashboard to retrieve dashboardId and allowedUsers
  const dashboardResult = await db
    .select()
    .from(dashboards)
    .where(eq(dashboards.id, id))
    .limit(1);

  if (dashboardResult.length === 0) {
    throw new Error(`dashboard with Id ${id} not found`);
  }

  console.log(`[DASHBOARDS] Deleting dashboard ID: ${id}, dashboardId: ${dashboardResult[0].dashboardId}`);

  const result = await db
    .delete(dashboards)
    .where(eq(dashboards.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Dashboard with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: "Dashboard deleted successfully",
  };
}
