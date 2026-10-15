import { db, schema } from "./drizzle-db";
import { eq, and, asc, desc, SQL } from "drizzle-orm";
import { encryptConfigFields, decryptConfigFields } from "./secret-crypto";
import { reindexSourceLater } from "./data-source-index";

const { projectSources } = schema;

/**
 * Project Sources CRUD Operations using Drizzle ORM
 */

// Source types supported
export type SourceType =
  | 'postgres'
  | 'mssql'
  | 'mysql'
  | 'excel'
  | 'csv'
  | 'rest_api'
  | 'graphql'
  | 'dynamodb'
  | 'redis'
  | 'netsuite';

// Dot-path config fields that must be encrypted at rest, per source type.
// Field-level AES-256-GCM encryption (see ./secret-crypto) inside the same
// jsonb `config` column — no schema/column change needed. Backward compatible
// by construction: decryptConfigFields() passes through any value that isn't
// already in our "enc:v1:" format, so existing plaintext rows keep working
// unchanged and only get encrypted the next time they're written (create/update).
const SECRET_CONFIG_FIELDS: Partial<Record<SourceType, string[]>> = {
  netsuite: ['privateKey'],
  postgres: ['password'],
  mysql: ['password'],
  mssql: ['password'],
  redis: ['password'],
  dynamodb: ['secretAccessKey', 'sessionToken'],
  rest_api: ['authConfig.apiKey', 'authConfig.bearerToken', 'authConfig.password'],
  graphql: ['authConfig.apiKey', 'authConfig.bearerToken', 'authConfig.password'],
};

/** Dot-path config fields that are encrypted at rest for a given source type. */
export function getSecretFieldPaths(type: string): string[] {
  return SECRET_CONFIG_FIELDS[type as SourceType] || [];
}

/** Decrypt a DB row's `config` in place (no-op for types with no secret fields). */
function decryptRow<T extends { type: string; config: unknown }>(row: T): T {
  const paths = getSecretFieldPaths(row.type);
  if (!paths.length || !row.config) return row;
  return { ...row, config: decryptConfigFields(row.config as Record<string, any>, paths) };
}

export interface CreateProjectSourceParams {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  type: SourceType;
  config: Record<string, any>;
  schema?: Record<string, any>;
  isPrimary?: boolean;
  isActive?: boolean;
}

export interface UpdateProjectSourceParams {
  id: string;
  name?: string;
  description?: string;
  type?: SourceType;
  config?: Record<string, any>;
  schema?: Record<string, any>;
  isPrimary?: boolean;
  isActive?: boolean;
  lastSyncAt?: string;
}

export interface GetProjectSourceParams {
  id: string;
}

export interface DeleteProjectSourceParams {
  id: string;
}

export interface QueryProjectSourcesParams {
  filters?: {
    projectId?: string;
    type?: SourceType;
    isPrimary?: boolean;
    isActive?: boolean;
  };
  limit?: number;
  sort?: "ASC" | "DESC";
}

/**
 * Create a new project source
 */
export async function createProjectSource(params: CreateProjectSourceParams) {
  const {
    id,
    projectId,
    name,
    description,
    type,
    config,
    schema: sourceSchema,
    isPrimary,
    isActive,
  } = params;

  if (!id) {
    throw new Error("id is required");
  }

  if (!projectId) {
    throw new Error("projectId is required");
  }

  if (!name) {
    throw new Error("name is required");
  }

  if (!type) {
    throw new Error("type is required");
  }

  if (!config) {
    throw new Error("config is required");
  }

  // Check if source with this ID already exists
  const existing = await db
    .select()
    .from(projectSources)
    .where(eq(projectSources.id, id))
    .limit(1);

  if (existing.length > 0) {
    throw new Error(`Source with ID ${id} already exists`);
  }

  // If this is primary, unset other primary sources for this project
  if (isPrimary) {
    await db
      .update(projectSources)
      .set({ isPrimary: false, updatedAt: new Date().toISOString() })
      .where(and(
        eq(projectSources.projectId, projectId),
        eq(projectSources.isPrimary, true)
      ));
  }

  const result = await db
    .insert(projectSources)
    .values({
      id,
      projectId,
      name,
      description: description || null,
      type,
      config: encryptConfigFields(config, getSecretFieldPaths(type)),
      schema: sourceSchema || null,
      isPrimary: isPrimary ?? false,
      isActive: isActive ?? true,
    })
    .returning();

  return {
    success: true,
    // Return the plaintext config the caller passed in rather than re-decrypting
    // the row we just wrote — cheaper, and avoids a needless decrypt round-trip.
    data: { ...result[0], config },
    message: "Project source created successfully",
  };
}

/**
 * Get all sources for a project
 */
export async function getProjectSources(projectId: string, includeInactive = false) {
  let conditions: SQL[] = [eq(projectSources.projectId, projectId)];

  if (!includeInactive) {
    conditions.push(eq(projectSources.isActive, true));
  }

  const result = await db
    .select()
    .from(projectSources)
    .where(and(...conditions))
    .orderBy(desc(projectSources.isPrimary), asc(projectSources.name));

  return {
    success: true,
    data: result.map(decryptRow),
    count: result.length,
  };
}

/**
 * Get a single project source by ID
 */
export async function getProjectSource(params: GetProjectSourceParams) {
  const { id } = params;

  if (!id) {
    throw new Error("Source ID is required");
  }

  const result = await db
    .select()
    .from(projectSources)
    .where(eq(projectSources.id, id))
    .limit(1);

  if (result.length === 0) {
    throw new Error(`Source with ID ${id} not found`);
  }

  return {
    success: true,
    data: decryptRow(result[0]),
  };
}

/**
 * Query project sources with filters
 */
export async function queryProjectSources(params: QueryProjectSourcesParams) {
  const { filters = {}, limit = 50, sort = "DESC" } = params;

  // Build filter conditions
  const conditions: SQL[] = [];

  if (filters.projectId) {
    conditions.push(eq(projectSources.projectId, filters.projectId));
  }

  if (filters.type) {
    conditions.push(eq(projectSources.type, filters.type));
  }

  if (filters.isPrimary !== undefined) {
    conditions.push(eq(projectSources.isPrimary, filters.isPrimary));
  }

  if (filters.isActive !== undefined) {
    conditions.push(eq(projectSources.isActive, filters.isActive));
  }

  // Build query
  let query = db.select().from(projectSources);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  // Apply sort
  const orderBy = sort === "ASC"
    ? asc(projectSources.createdAt)
    : desc(projectSources.createdAt);
  query = query.orderBy(orderBy) as typeof query;

  // Apply limit
  query = query.limit(limit) as typeof query;

  const result = await query;

  return {
    success: true,
    data: result.map(decryptRow),
    count: result.length,
  };
}

/**
 * Update a project source
 */
export async function updateProjectSource(params: UpdateProjectSourceParams) {
  const {
    id,
    name,
    description,
    type,
    config,
    schema: sourceSchema,
    isPrimary,
    isActive,
    lastSyncAt,
  } = params;

  if (!id) {
    throw new Error("Source ID is required");
  }

  // Get current source to check project ID for primary handling
  const current = await db
    .select()
    .from(projectSources)
    .where(eq(projectSources.id, id))
    .limit(1);

  if (current.length === 0) {
    throw new Error(`Source with ID ${id} not found`);
  }

  const currentSource = current[0];

  // If setting as primary, unset other primary sources for this project
  if (isPrimary === true && !currentSource.isPrimary) {
    await db
      .update(projectSources)
      .set({ isPrimary: false, updatedAt: new Date().toISOString() })
      .where(and(
        eq(projectSources.projectId, currentSource.projectId),
        eq(projectSources.isPrimary, true)
      ));
  }

  const updateData: Record<string, any> = {
    updatedAt: new Date().toISOString(),
  };

  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (type !== undefined) updateData.type = type;
  if (config !== undefined) {
    updateData.config = encryptConfigFields(config, getSecretFieldPaths(type ?? currentSource.type));
  }
  if (sourceSchema !== undefined) updateData.schema = sourceSchema;
  if (isPrimary !== undefined) updateData.isPrimary = isPrimary;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (lastSyncAt !== undefined) updateData.lastSyncAt = lastSyncAt;

  const result = await db
    .update(projectSources)
    .set(updateData)
    .where(eq(projectSources.id, id))
    .returning();

  // The index follows what it is built from, and an inactive source leaves it.
  if (sourceSchema !== undefined || isActive !== undefined) reindexSourceLater(id, 'source updated');

  return {
    success: true,
    // If config was part of this update, return the plaintext the caller passed
    // in (cheaper than decrypting what we just encrypted); otherwise the row's
    // existing config still needs decrypting for the caller.
    data: config !== undefined ? { ...result[0], config } : decryptRow(result[0]),
    message: "Project source updated successfully",
  };
}

/**
 * Update just the schema for a source (used after schema extraction)
 */
export async function updateSourceSchema(id: string, sourceSchema: Record<string, any>) {
  if (!id) {
    throw new Error("Source ID is required");
  }

  const result = await db
    .update(projectSources)
    .set({
      schema: sourceSchema,
      lastSyncAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projectSources.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Source with ID ${id} not found`);
  }
  reindexSourceLater(id, 'schema extracted');

  return {
    success: true,
    data: result[0],
    message: "Source schema updated successfully",
  };
}

/**
 * Update the semantic model (Claude-authored superset) for a source.
 * Pass null to clear it (runtime then falls back to the raw `schema`).
 */
export async function updateSourceSemanticModel(id: string, semanticModel: Record<string, any> | null) {
  if (!id) {
    throw new Error("Source ID is required");
  }

  const result = await db
    .update(projectSources)
    .set({
      semanticModel,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projectSources.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Source with ID ${id} not found`);
  }
  reindexSourceLater(id, 'semantic model changed');

  return {
    success: true,
    data: decryptRow(result[0]),
    message: "Source semantic model updated successfully",
  };
}

/**
 * Delete a project source
 */
export async function deleteProjectSource(params: DeleteProjectSourceParams) {
  const { id } = params;

  if (!id) {
    throw new Error("Source ID is required");
  }

  const result = await db
    .delete(projectSources)
    .where(eq(projectSources.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Source with ID ${id} not found`);
  }
  reindexSourceLater(id, 'source deleted');

  return {
    success: true,
    data: result[0],
    message: "Project source deleted successfully",
  };
}

/**
 * Get primary source for a project
 */
export async function getPrimarySource(projectId: string) {
  const result = await db
    .select()
    .from(projectSources)
    .where(and(
      eq(projectSources.projectId, projectId),
      eq(projectSources.isPrimary, true),
      eq(projectSources.isActive, true)
    ))
    .limit(1);

  if (result.length === 0) {
    // If no primary, return first active source
    const fallback = await db
      .select()
      .from(projectSources)
      .where(and(
        eq(projectSources.projectId, projectId),
        eq(projectSources.isActive, true)
      ))
      .limit(1);

    if (fallback.length === 0) {
      return { success: true, data: null };
    }
    return { success: true, data: decryptRow(fallback[0]) };
  }

  return {
    success: true,
    data: decryptRow(result[0]),
  };
}

/**
 * Set a source as primary (and unset others)
 */
export async function setPrimarySource(id: string) {
  // Get the source to find its project
  const source = await db
    .select()
    .from(projectSources)
    .where(eq(projectSources.id, id))
    .limit(1);

  if (source.length === 0) {
    throw new Error(`Source with ID ${id} not found`);
  }

  const projectId = source[0].projectId;

  // Unset all primary for this project
  await db
    .update(projectSources)
    .set({ isPrimary: false, updatedAt: new Date().toISOString() })
    .where(eq(projectSources.projectId, projectId));

  // Set this one as primary
  const result = await db
    .update(projectSources)
    .set({ isPrimary: true, updatedAt: new Date().toISOString() })
    .where(eq(projectSources.id, id))
    .returning();

  return {
    success: true,
    data: decryptRow(result[0]),
    message: "Primary source updated successfully",
  };
}
