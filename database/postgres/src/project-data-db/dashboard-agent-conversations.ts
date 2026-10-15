import { db, schema } from "./drizzle-db";
import { eq, and, asc, desc, SQL } from "drizzle-orm";

const { dashboardAgentConversations } = schema;

/**
 * Dashboard agent conversation history — one row per Pi run, success or not,
 * so failures/aborts are visible for debugging (see `status`).
 */

export interface CreateDashboardAgentConversationParams {
  dashboardId: string;
  projectId?: string;
  userId?: string;
  userPrompt: string;
  // Whatever real narration exists — the full text on success, or whatever
  // was actually streamed before a failure (can be empty on failure).
  responseText: string;
  // The full draft pi wrote — {mode:'full',dsl} or {mode:'partial',widgets} —
  // stored alongside responseText in the same jsonb `response` column.
  dsl?: unknown;
  status?: 'success' | 'error' | 'aborted'; // defaults to 'success'
  // The failure detail, in whatever shape it naturally has. Separate from
  // responseText — never coerced into it. Ignored when status === 'success'.
  error?: unknown;
}

export interface QueryDashboardAgentConversationsParams {
  filters?: {
    dashboardId?: string;
    projectId?: string;
    userId?: string;
  };
  limit?: number;
  sort?: "ASC" | "DESC";
}

export async function createDashboardAgentConversation(params: CreateDashboardAgentConversationParams) {
  const { dashboardId, projectId, userId, userPrompt, responseText, dsl, status = 'success', error } = params;

  if (!dashboardId) {
    throw new Error("dashboardId is required");
  }
  if (!userPrompt) {
    throw new Error("userPrompt is required");
  }
  // Only require real narration on success — a failure can genuinely have
  // nothing to show (e.g. it failed before generating anything).
  if (status === 'success' && !responseText) {
    throw new Error("responseText is required");
  }

  const result = await db
    .insert(dashboardAgentConversations)
    .values({
      dashboardId,
      projectId: projectId || null,
      userId: userId || null,
      userPrompt,
      // An abort is the user's own choice, not a failure — never store an
      // error for it, regardless of what the caller passes.
      response: { response_text: responseText || null, dsl: dsl ?? null, error: status === 'error' ? (error ?? null) : null },
      status,
    })
    .returning();

  return {
    success: true,
    data: result[0],
  };
}

export async function getDashboardAgentConversationById(id: number) {
  if (!id) {
    throw new Error("id is required");
  }

  const result = await db
    .select()
    .from(dashboardAgentConversations)
    .where(eq(dashboardAgentConversations.id, id))
    .limit(1);

  if (result.length === 0) {
    return { success: false, data: null };
  }

  return { success: true, data: result[0] };
}

export async function queryDashboardAgentConversations(params: QueryDashboardAgentConversationsParams) {
  const { filters = {}, limit = 50, sort = "DESC" } = params;

  const conditions: SQL[] = [];

  if (filters.dashboardId) {
    conditions.push(eq(dashboardAgentConversations.dashboardId, filters.dashboardId));
  }
  if (filters.projectId) {
    conditions.push(eq(dashboardAgentConversations.projectId, filters.projectId));
  }
  if (filters.userId) {
    conditions.push(eq(dashboardAgentConversations.userId, filters.userId));
  }

  let query = db.select().from(dashboardAgentConversations);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  const orderBy =
    sort === "ASC" ? asc(dashboardAgentConversations.createdAt) : desc(dashboardAgentConversations.createdAt);
  query = query.orderBy(orderBy) as typeof query;
  query = query.limit(limit) as typeof query;

  const result = await query;

  return {
    success: true,
    data: result,
    count: result.length,
  };
}
