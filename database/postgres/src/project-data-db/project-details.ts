import { db, schema } from "./drizzle-db";
import { eq, and, asc, desc, SQL } from "drizzle-orm";

const { projectDetails } = schema;

/**
 * Project Details CRUD Operations using Drizzle ORM
 */

export interface CreateProjectDetailsParams {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  databaseType?: string;
  databaseName?: string;
  primaryColor?: string;
}

export interface UpdateProjectDetailsParams {
  id: string;
  name?: string;
  icon?: string;
  description?: string;
  databaseType?: string;
  databaseName?: string;
  primaryColor?: string;
}

export interface GetProjectDetailsParams {
  id: string;
}

export interface DeleteProjectDetailsParams {
  id: string;
}

export interface QueryProjectDetailsParams {
  filters?: {
    id?: string;
    name?: string;
    databaseType?: string;
    databaseName?: string;
  };
  limit?: number;
  sort?: "ASC" | "DESC";
}

/**
 * Create a new project details record
 */
export async function createProjectDetails(params: CreateProjectDetailsParams) {
  const {
    id,
    name,
    icon,
    description,
    databaseType,
    databaseName,
    primaryColor,
  } = params;

  if (!id) {
    throw new Error("id is required");
  }

  if (!name) {
    throw new Error("name is required");
  }

  // Check if project with this ID already exists
  const existing = await db
    .select()
    .from(projectDetails)
    .where(eq(projectDetails.id, id))
    .limit(1);

  if (existing.length > 0) {
    throw new Error(`Project with ID ${id} already exists`);
  }

  const result = await db
    .insert(projectDetails)
    .values({
      id,
      name,
      icon: icon || null,
      description: description || null,
      databaseType: databaseType || null,
      databaseName: databaseName || null,
      primaryColor: primaryColor || null,
    })
    .returning();

  return {
    success: true,
    data: result[0],
    message: "Project details created successfully",
  };
}

/**
 * Get all project details
 */
export async function getAllProjectDetails(limit: number = 50) {
  const result = await db
    .select()
    .from(projectDetails)
    .orderBy(projectDetails.createdAt)
    .limit(limit);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Get a single project details by ID
 */
export async function getProjectDetails(params: GetProjectDetailsParams) {
  const { id } = params;

  if (!id) {
    throw new Error("Project ID is required");
  }

  const result = await db
    .select()
    .from(projectDetails)
    .where(eq(projectDetails.id, id))
    .limit(1);

  if (result.length === 0) {
    throw new Error(`Project with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
  };
}

/**
 * Query project details with filters, limit, and sort
 */
export async function queryProjectDetails(params: QueryProjectDetailsParams) {
  const { filters = {}, limit = 50, sort = "DESC" } = params;

  // Build filter conditions
  const conditions: SQL[] = [];

  if (filters.id) {
    conditions.push(eq(projectDetails.id, filters.id));
  }

  if (filters.name) {
    conditions.push(eq(projectDetails.name, filters.name));
  }

  if (filters.databaseType) {
    conditions.push(eq(projectDetails.databaseType, filters.databaseType));
  }

  if (filters.databaseName) {
    conditions.push(eq(projectDetails.databaseName, filters.databaseName));
  }

  // Build query
  let query = db.select().from(projectDetails);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  // Apply sort
  const orderBy =
    sort === "ASC" ? asc(projectDetails.createdAt) : desc(projectDetails.createdAt);
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
 * Update project details
 */
export async function updateProjectDetails(params: UpdateProjectDetailsParams) {
  const {
    id,
    name,
    icon,
    description,
    databaseType,
    databaseName,
    primaryColor,
  } = params;

  if (!id) {
    throw new Error("Project ID is required");
  }

  const updateData: any = {
    updatedAt: new Date().toISOString(),
  };

  if (name !== undefined) {
    updateData.name = name;
  }

  if (icon !== undefined) {
    updateData.icon = icon;
  }

  if (description !== undefined) {
    updateData.description = description;
  }

  if (databaseType !== undefined) {
    updateData.databaseType = databaseType;
  }

  if (databaseName !== undefined) {
    updateData.databaseName = databaseName;
  }

  if (primaryColor !== undefined) {
    updateData.primaryColor = primaryColor;
  }

  const result = await db
    .update(projectDetails)
    .set(updateData)
    .where(eq(projectDetails.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Project with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: "Project details updated successfully",
  };
}

/**
 * Delete project details
 */
export async function deleteProjectDetails(params: DeleteProjectDetailsParams) {
  const { id } = params;

  if (!id) {
    throw new Error("Project ID is required");
  }

  const result = await db
    .delete(projectDetails)
    .where(eq(projectDetails.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Project with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: "Project details deleted successfully",
  };
}
