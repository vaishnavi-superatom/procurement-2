import { db, schema } from "./drizzle-db";
import { eq, desc, asc, and, SQL, sql, count } from "drizzle-orm";

const { artifacts } = schema;

export interface CreateArtifactParams {
	name: string;
	createdBy?: string;
	dsl?: Record<string, any>;
	type?: string;
	filters?: Record<string, any>;
	status?: string;
}

export interface GetArtifactParams {
	id: number;
}

export interface DeleteArtifactParams {
	id: number;
}

export interface UpdateArtifactParams {
	id: number;
	name?: string;
	dsl?: Record<string, any>;
	type?: string;
	filters?: Record<string, any>;
	status?: string;
	deleted?: boolean;
}

export async function createArtifact(params: CreateArtifactParams) {
	const { name, createdBy, dsl, type, filters, status } = params;

	if (!name) {
		throw new Error("name is required");
	}

	const result = await db
		.insert(artifacts)
		.values({
			name,
			createdBy: createdBy || null,
			dsl: dsl || null,
			type: type || null,
			filters: filters || null,
			status: status || null,
		})
		.returning();

	return {
		success: true,
		data: result[0],
		message: "Artifact created successfully",
	};
}

export async function getAllArtifacts(limit: number = 50) {
	const result = await db
		.select()
		.from(artifacts)
		.where(eq(artifacts.deleted, false))
		.orderBy(desc(artifacts.createdAt))
		.limit(limit);

	return {
		success: true,
		data: result,
		count: result.length,
	};
}

export async function getArtifact(params: GetArtifactParams) {
	const { id } = params;

	if (!id) {
		throw new Error("Artifact ID is required");
	}

	const result = await db
		.select()
		.from(artifacts)
		.where(eq(artifacts.id, id))
		.limit(1);

	if (result.length === 0) {
		throw new Error(`Artifact with ID ${id} not found`);
	}

	return {
		success: true,
		data: result[0],
	};
}

export async function deleteArtifact(params: DeleteArtifactParams) {
	const { id } = params;

	if (!id) {
		throw new Error("Artifact ID is required");
	}

	// Soft delete
	const result = await db
		.update(artifacts)
		.set({ deleted: true, updatedAt: new Date().toISOString() })
		.where(eq(artifacts.id, id))
		.returning();

	if (result.length === 0) {
		throw new Error(`Artifact with ID ${id} not found`);
	}

	return {
		success: true,
		data: result[0],
		message: "Artifact deleted successfully",
	};
}

export async function updateArtifact(params: UpdateArtifactParams) {
	const { id, name, dsl, type, filters, status, deleted } = params;

	if (!id) {
		throw new Error("Artifact ID is required");
	}

	const updateData: Record<string, any> = {
		updatedAt: new Date().toISOString(),
	};

	if (name !== undefined) updateData.name = name;
	if (dsl !== undefined) updateData.dsl = dsl;
	if (type !== undefined) updateData.type = type;
	if (filters !== undefined) updateData.filters = filters;
	if (status !== undefined) updateData.status = status;
	if (deleted !== undefined) updateData.deleted = deleted;

	const result = await db
		.update(artifacts)
		.set(updateData)
		.where(eq(artifacts.id, id))
		.returning();

	if (result.length === 0) {
		throw new Error(`Artifact with ID ${id} not found`);
	}

	return {
		success: true,
		data: result[0],
		message: "Artifact updated successfully",
	};
}

export interface QueryArtifactsParams {
	filters?: {
		createdBy?: string;
		type?: string;
		status?: string;
		name?: string;
		deleted?: boolean;
		createdAt?: string; // Date in YYYY-MM-DD format
	};
	limit?: number;
	offset?: number;
	sort?: "ASC" | "DESC";
}

/**
 * Query artifacts with filters, limit, and sort
 */
export async function queryArtifacts(params: QueryArtifactsParams) {
	const { filters = {}, limit = 50, offset = 0, sort = "DESC" } = params;

	// Build filter conditions
	const conditions: SQL[] = [];

	// Default to non-deleted unless explicitly specified
	if (filters.deleted !== undefined) {
		conditions.push(eq(artifacts.deleted, filters.deleted));
	} else {
		conditions.push(eq(artifacts.deleted, false));
	}

	if (filters.createdBy) {
		conditions.push(eq(artifacts.createdBy, filters.createdBy));
	}

	if (filters.type) {
		conditions.push(eq(artifacts.type, filters.type));
	}

	if (filters.status) {
		conditions.push(eq(artifacts.status, filters.status));
	}

	if (filters.name) {
		conditions.push(eq(artifacts.name, filters.name));
	}

	// Filter by createdAt date (compare just the date part)
	if (filters.createdAt) {
		conditions.push(sql`DATE(${artifacts.createdAt}) = ${filters.createdAt}`);
	}

	// Get total count of matching records (before pagination)
	let countQuery = db.select({ count: count() }).from(artifacts);
	if (conditions.length > 0) {
		countQuery = countQuery.where(and(...conditions)) as typeof countQuery;
	}
	const totalCountResult = await countQuery;
	const totalCount = totalCountResult[0]?.count || 0;

	// Build data query with pagination
	let query = db.select().from(artifacts);

	if (conditions.length > 0) {
		query = query.where(and(...conditions)) as typeof query;
	}

	// Apply sort
	const orderBy = sort === "ASC" ? asc(artifacts.createdAt) : desc(artifacts.createdAt);
	query = query.orderBy(orderBy) as typeof query;

	// Apply pagination
	query = query.limit(limit).offset(offset) as typeof query;

	const result = await query;

	return {
		success: true,
		data: result,
		count: totalCount,
	};
}
