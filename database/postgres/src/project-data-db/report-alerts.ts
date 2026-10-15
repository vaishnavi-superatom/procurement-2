import { db, schema } from './drizzle-db';
import { eq, and, asc, desc, sql, SQL } from 'drizzle-orm';

const { reportAlerts, alertHistory } = schema;

/**
 * Report Alerts CRUD Operations using Drizzle ORM
 */

export interface CreateReportAlertParams {
  alertId: string;
  reportId: string;
  projectId: string;
  name?: string;
  enabled?: boolean;
  metricDescription?: string;
  sourceId?: string;
  generatedQuery?: string;
  resultColumn?: string;
  conditionType?: string;
  config?: any;
  checkInterval?: string;
  recipients?: string[];
  emailSubject?: string;
  cooldownMinutes?: number;
  createdBy?: string;
}

export interface UpdateReportAlertParams {
  id: number;
  name?: string;
  enabled?: boolean;
  metricDescription?: string;
  sourceId?: string;
  generatedQuery?: string;
  resultColumn?: string;
  conditionType?: string;
  config?: any;
  checkInterval?: string;
  recipients?: string[];
  emailSubject?: string;
  cooldownMinutes?: number;
  // Tracking fields (updated by the engine, not the user)
  lastCheckedAt?: string;
  lastTriggeredAt?: string;
  lastValue?: number;
  consecutiveErrors?: number;
  status?: string;
}

export interface QueryReportAlertsParams {
  filters?: {
    alertId?: string;
    reportId?: string;
    projectId?: string;
    enabled?: boolean;
    status?: string;
    createdBy?: string;
  };
  limit?: number;
  sort?: 'ASC' | 'DESC';
}

export interface CreateAlertHistoryParams {
  alertId: string;
  value?: number;
  reason?: string;
  analysis?: string;
}

/**
 * Create a new report alert
 */
export async function createReportAlert(params: CreateReportAlertParams) {
  const { alertId, reportId, projectId } = params;

  if (!alertId) {
    throw new Error('alertId is required');
  }

  if (!reportId) {
    throw new Error('reportId is required');
  }

  if (!projectId) {
    throw new Error('projectId is required');
  }

  const result = await db
    .insert(reportAlerts)
    .values({
      alertId,
      reportId,
      projectId,
      name: params.name || null,
      enabled: params.enabled ?? true,
      metricDescription: params.metricDescription || null,
      sourceId: params.sourceId || null,
      generatedQuery: params.generatedQuery || null,
      resultColumn: params.resultColumn || null,
      conditionType: params.conditionType || null,
      config: params.config || null,
      checkInterval: params.checkInterval || '1h',
      recipients: params.recipients || [],
      emailSubject: params.emailSubject || null,
      cooldownMinutes: params.cooldownMinutes ?? 60,
      createdBy: params.createdBy || null,
    })
    .returning();

  return {
    success: true,
    data: result[0],
    message: 'Report alert created successfully',
  };
}

/**
 * Get all report alerts
 */
export async function getAllReportAlerts(limit: number = 50) {
  const result = await db.select().from(reportAlerts).orderBy(desc(reportAlerts.createdAt)).limit(limit);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Get a single report alert by ID
 */
export async function getReportAlert(params: { id: number }) {
  const { id } = params;

  if (!id) {
    throw new Error('Alert ID is required');
  }

  const result = await db
    .select()
    .from(reportAlerts)
    .where(eq(reportAlerts.id, id))
    .limit(1);

  if (result.length === 0) {
    throw new Error(`Report alert with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
  };
}

/**
 * Query report alerts with filters, limit, and sort
 */
export async function queryReportAlerts(params: QueryReportAlertsParams) {
  const { filters = {}, limit = 50, sort = 'DESC' } = params;

  const conditions: SQL[] = [];

  if (filters.alertId) {
    conditions.push(eq(reportAlerts.alertId, filters.alertId));
  }

  if (filters.reportId) {
    conditions.push(eq(reportAlerts.reportId, filters.reportId));
  }

  if (filters.projectId) {
    conditions.push(eq(reportAlerts.projectId, filters.projectId));
  }

  if (filters.enabled !== undefined) {
    conditions.push(eq(reportAlerts.enabled, filters.enabled));
  }

  if (filters.status) {
    conditions.push(eq(reportAlerts.status, filters.status));
  }

  if (filters.createdBy) {
    conditions.push(eq(reportAlerts.createdBy, filters.createdBy));
  }

  let query = db.select().from(reportAlerts);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  const orderBy = sort === 'ASC' ? asc(reportAlerts.createdAt) : desc(reportAlerts.createdAt);
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
 * Update a report alert
 */
export async function updateReportAlert(params: UpdateReportAlertParams) {
  const { id } = params;

  if (!id) {
    throw new Error('Alert ID is required');
  }

  const updateData: any = {
    updatedAt: new Date().toISOString(),
  };

  if (params.name !== undefined) updateData.name = params.name;
  if (params.enabled !== undefined) updateData.enabled = params.enabled;
  if (params.metricDescription !== undefined) updateData.metricDescription = params.metricDescription;
  if (params.sourceId !== undefined) updateData.sourceId = params.sourceId;
  if (params.generatedQuery !== undefined) updateData.generatedQuery = params.generatedQuery;
  if (params.resultColumn !== undefined) updateData.resultColumn = params.resultColumn;
  if (params.conditionType !== undefined) updateData.conditionType = params.conditionType;
  if (params.config !== undefined) updateData.config = params.config;
  if (params.checkInterval !== undefined) updateData.checkInterval = params.checkInterval;
  if (params.recipients !== undefined) updateData.recipients = params.recipients;
  if (params.emailSubject !== undefined) updateData.emailSubject = params.emailSubject;
  if (params.cooldownMinutes !== undefined) updateData.cooldownMinutes = params.cooldownMinutes;
  if (params.lastCheckedAt !== undefined) updateData.lastCheckedAt = params.lastCheckedAt;
  if (params.lastTriggeredAt !== undefined) updateData.lastTriggeredAt = params.lastTriggeredAt;
  if (params.lastValue !== undefined) updateData.lastValue = params.lastValue;
  if (params.consecutiveErrors !== undefined) updateData.consecutiveErrors = params.consecutiveErrors;
  if (params.status !== undefined) updateData.status = params.status;

  const result = await db
    .update(reportAlerts)
    .set(updateData)
    .where(eq(reportAlerts.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Report alert with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: 'Report alert updated successfully',
  };
}

/**
 * Delete a report alert
 */
export async function deleteReportAlert(params: { id: number }) {
  const { id } = params;

  if (!id) {
    throw new Error('Alert ID is required');
  }

  const result = await db
    .delete(reportAlerts)
    .where(eq(reportAlerts.id, id))
    .returning();

  if (result.length === 0) {
    throw new Error(`Report alert with ID ${id} not found`);
  }

  return {
    success: true,
    data: result[0],
    message: 'Report alert deleted successfully',
  };
}

/**
 * Query alerts that are due for evaluation.
 * Returns only enabled alerts where:
 * - lastCheckedAt is NULL (never checked), OR
 * - lastCheckedAt + checkInterval <= NOW()
 */
export async function queryDueAlerts(limit: number = 500) {
  const result = await db.select().from(reportAlerts).where(
    and(
      eq(reportAlerts.enabled, true),
      sql`(
        ${reportAlerts.lastCheckedAt} IS NULL
        OR ${reportAlerts.lastCheckedAt} + (
          CASE ${reportAlerts.checkInterval}
            WHEN '15m' THEN INTERVAL '15 minutes'
            WHEN '1h'  THEN INTERVAL '1 hour'
            WHEN '6h'  THEN INTERVAL '6 hours'
            WHEN '1d'  THEN INTERVAL '1 day'
            WHEN '1w'  THEN INTERVAL '7 days'
            ELSE INTERVAL '1 hour'
          END
        ) <= NOW()
      )`,
    ),
  ).limit(limit);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}

/**
 * Create an alert history entry
 */
export async function createAlertHistory(params: CreateAlertHistoryParams) {
  const { alertId } = params;

  if (!alertId) {
    throw new Error('alertId is required');
  }

  const result = await db
    .insert(alertHistory)
    .values({
      alertId,
      value: params.value ?? null,
      reason: params.reason || null,
      analysis: params.analysis || null,
    })
    .returning();

  return {
    success: true,
    data: result[0],
  };
}

/**
 * Get alert history for an alert
 */
export async function getAlertHistory(params: { alertId: string; limit?: number }) {
  const { alertId, limit = 20 } = params;

  if (!alertId) {
    throw new Error('alertId is required');
  }

  const result = await db
    .select()
    .from(alertHistory)
    .where(eq(alertHistory.alertId, alertId))
    .orderBy(desc(alertHistory.triggeredAt))
    .limit(limit);

  return {
    success: true,
    data: result,
    count: result.length,
  };
}
