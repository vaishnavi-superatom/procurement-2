import { db, schema } from "./drizzle-db";
import { eq, and, asc, desc, SQL } from "drizzle-orm";

const { reportsConversations } = schema;

/**
 * Report-generation conversation history — one row per report run, success or
 * not, so failures/aborts are visible for debugging (see `status`). Mirrors
 * dashboard-agent-conversations.ts.
 */

export interface CreateReportsConversationParams {
  reportId: string;
  projectId?: string;
  userId?: string;
  userPrompt: string;
  // Whatever real narration exists — currently always empty on failure, since
  // the report flow has no progressive streaming to capture (unlike chat/dashboard).
  responseText: string;
  // The report content that was generated (llmResponse.data — components
  // etc.), stored alongside responseText in the same jsonb `response` column.
  dsl?: unknown;
  status?: 'success' | 'error' | 'aborted'; // defaults to 'success'
  // The failure detail, in whatever shape it naturally has. Separate from
  // responseText — never coerced into it. Ignored when status === 'success'.
  error?: unknown;
}

export interface QueryReportsConversationsParams {
  filters?: {
    reportId?: string;
    projectId?: string;
    userId?: string;
  };
  limit?: number;
  sort?: "ASC" | "DESC";
}

export async function createReportsConversation(params: CreateReportsConversationParams) {
  const { reportId, projectId, userId, userPrompt, responseText, dsl, status = 'success', error } = params;

  if (!reportId) {
    throw new Error("reportId is required");
  }
  if (!userPrompt) {
    throw new Error("userPrompt is required");
  }
  // Only require real narration on success — a failure can genuinely have
  // nothing to show.
  if (status === 'success' && !responseText) {
    throw new Error("responseText is required");
  }

  const result = await db
    .insert(reportsConversations)
    .values({
      reportId,
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

export async function getReportsConversationById(id: number) {
  if (!id) {
    throw new Error("id is required");
  }

  const result = await db
    .select()
    .from(reportsConversations)
    .where(eq(reportsConversations.id, id))
    .limit(1);

  if (result.length === 0) {
    return { success: false, data: null };
  }

  return { success: true, data: result[0] };
}

export async function queryReportsConversations(params: QueryReportsConversationsParams) {
  const { filters = {}, limit = 50, sort = "DESC" } = params;

  const conditions: SQL[] = [];

  if (filters.reportId) {
    conditions.push(eq(reportsConversations.reportId, filters.reportId));
  }
  if (filters.projectId) {
    conditions.push(eq(reportsConversations.projectId, filters.projectId));
  }
  if (filters.userId) {
    conditions.push(eq(reportsConversations.userId, filters.userId));
  }

  let query = db.select().from(reportsConversations);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  const orderBy =
    sort === "ASC" ? asc(reportsConversations.createdAt) : desc(reportsConversations.createdAt);
  query = query.orderBy(orderBy) as typeof query;
  query = query.limit(limit) as typeof query;

  const result = await query;

  return {
    success: true,
    data: result,
    count: result.length,
  };
}
