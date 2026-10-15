import { db, schema } from './drizzle-db';
import { eq, and, asc, desc, SQL } from 'drizzle-orm';
import type { DSLRendererProps } from './dsl-types';

const { reports } = schema;

/**
 * Report CRUD Operations using Drizzle ORM
 */

export interface CreateReportParams {
  reportId: string;
  projectId: string;
  name?: string;
  description?: string;
  report?: DSLRendererProps;
  published?: boolean;
  createdBy?: string;
}

export interface ScheduleConfig {
  frequency: 'once' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  time: string;
  timezone: string;
  scheduledDate?: string;
  dayOfWeek?: string;
  dayOfMonth?: string;
  monthOfQuarter?: string;
  monthOfYear?: string;
  format: 'pdf' | 'csv' | 'excel';
  recipients: string[];
  enabled: boolean;
  emailSubject?: string;
  emailBody?: string;
}

export interface UpdateReportParams {
  id: number;
  name?: string;
  description?: string;
  report?: DSLRendererProps;
  published?: boolean;
  scheduleConfig?: ScheduleConfig | null;
  lastScheduledAt?: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface GetReportParams {
  id: number;
}

export interface DeleteReportParams {
  id: number;
}

export interface QueryReportsParams {
  filters?: {
    reportId?: string;
    projectId?: string;
    createdBy?: string;
    updatedBy?: string;
    name?: string;
    published?: boolean;
  };
  limit?: number;
  sort?: 'ASC' | 'DESC';
}

/**
 * Create a new report
 */
export async function createReport(params: CreateReportParams) {
  const { reportId, projectId, name, description, report, published, createdBy } = params;

  if (!reportId) {
    throw new Error('reportId is required');
  }

  if (!projectId) {
    throw new Error('projectId is required');
  }

  const result = await db
    .insert(reports)
    .values({
      reportId,
      projectId,
      name: name || null,
      description: description || null,
      report: report || null,
      published: published ?? false,
      createdBy: createdBy || null,
    })
    .returning();

  return {
    success: true,
    data: result[0],
    message: 'Report created successfully',
  };
}

/**
 * Get all reports
 */
export async function getAllReports(limit: number = 50) {
  const result = await db.select().from(reports).orderBy(reports.createdAt).limit(limit);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Get a single report by ID
 */
export async function getReport(params: GetReportParams) {
  const { id } = params;

  if (!id) {
    throw new Error('Report ID is required');
  }

  const result = await db
    .select()
    .from(reports)
    .where(eq(reports.id, id))
    .limit(1);

  if (result.length === 0) {
    throw new Error(`Report with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
  };
}

/**
 * Query reports with filters, limit, and sort
 */
export async function queryReports(params: QueryReportsParams) {
  const { filters = {}, limit = 50, sort = 'DESC' } = params;

  // Build filter conditions
  const conditions: SQL[] = [];

  if (filters.reportId) {
    conditions.push(eq(reports.reportId, filters.reportId));
  }

  if (filters.projectId) {
    conditions.push(eq(reports.projectId, filters.projectId));
  }

  if (filters.createdBy) {
    conditions.push(eq(reports.createdBy, filters.createdBy));
  }

  if (filters.updatedBy) {
    conditions.push(eq(reports.updatedBy, filters.updatedBy));
  }

  if (filters.name) {
    conditions.push(eq(reports.name, filters.name));
  }

  if (filters.published !== undefined) {
    conditions.push(eq(reports.published, filters.published));
  }

  // Build query
  let query = db.select().from(reports);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  // Apply sort
  const orderBy = sort === 'ASC' ? asc(reports.createdAt) : desc(reports.createdAt);
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
 * Update a report
 */
export async function updateReport(params: UpdateReportParams) {
  const { id, name, description, report, published, createdBy, updatedBy } = params;

  if (!id) {
    throw new Error('Report ID is required');
  }

  const updateData: any = {
    updatedAt: new Date().toISOString(),
  };

  if (report !== undefined) {
    updateData.report = report;
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

  if (params.scheduleConfig !== undefined) {
    updateData.scheduleConfig = params.scheduleConfig;
  }

  if (params.lastScheduledAt !== undefined) {
    updateData.lastScheduledAt = params.lastScheduledAt;
  }

  const result = await db
    .update(reports)
    .set(updateData)
    .where(eq(reports.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Report with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: 'Report updated successfully',
  };
}

/**
 * Delete a report
 */
export async function deleteReport(params: DeleteReportParams) {
  const { id } = params;

  if (!id) {
    throw new Error('Report ID is required');
  }

  const result = await db
    .delete(reports)
    .where(eq(reports.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Report with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: 'Report deleted successfully',
  };
}
