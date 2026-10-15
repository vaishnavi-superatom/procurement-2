import { db, schema } from './drizzle-db';
import { eq, and, desc, sql, SQL } from 'drizzle-orm';

const { answerFeedback } = schema;

export interface CreateAnswerFeedbackParams {
  uiBlockId: string;
  threadId?: string;
  userId?: string;
  userPrompt: string;
  answerSnapshot?: unknown;
  isCorrect?: boolean;
  status?: 'correct' | 'incorrect' | 'partial';
  feedbackText?: string;
}

export interface QueryAnswerFeedbackParams {
  filters?: {
    userId?: string;
    uiBlockId?: string;
  };
  limit?: number;
}

export interface QueryAnswerFeedbackAdvancedParams {
  page?: number;
  limit?: number;
  status?: 'all' | 'correct' | 'incorrect';
  userId?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
}

export async function createAnswerFeedback(params: CreateAnswerFeedbackParams) {
  const { uiBlockId, threadId, userId, userPrompt, answerSnapshot, status, feedbackText } = params;

  if (!uiBlockId) {
    throw new Error('uiBlockId is required');
  }

  if (!userPrompt) {
    throw new Error('userPrompt is required');
  }

 
  try {
    // Upsert on (user_id, ui_block_id) — re-submitting updates the feedback
    const result = await db
      .insert(answerFeedback)
      .values({
        uiBlockId,
        threadId: threadId || null,
        userId: userId || null,
        userPrompt,
        answerSnapshot: answerSnapshot ?? null,
        status: status,
        feedbackText: feedbackText || null,
      })
      .onConflictDoUpdate({
        target: [answerFeedback.userId, answerFeedback.uiBlockId],
        set: {
          status: status,
          feedbackText: feedbackText || null,
        },
      })
      .returning();

      
    return {
      success: true,
      data: result[0] || null,
    };
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
    console.error('[ANSWER-FEEDBACK] createAnswerFeedback failed:', errorMsg);
    throw new Error(`Failed to create answer feedback: ${errorMsg}`);
  }
}

export async function queryAnswerFeedback(params: QueryAnswerFeedbackParams) {
  const { filters = {}, limit = 50 } = params;

  try {
    const conditions: SQL[] = [];
    if (filters.userId) {
      conditions.push(eq(answerFeedback.userId, filters.userId));
    }
    if (filters.uiBlockId) {
      conditions.push(eq(answerFeedback.uiBlockId, filters.uiBlockId));
    }

    let query = db.select().from(answerFeedback);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    const result = await query
      .orderBy(desc(answerFeedback.createdAt))
      .limit(limit);

    return {
      success: true,
      data: result,
      count: result.length,
    };
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
    console.error('[ANSWER-FEEDBACK] queryAnswerFeedback failed:', errorMsg);
    throw new Error(`Failed to query answer feedback: ${errorMsg}`);
  }
}

export async function queryAnswerFeedbackAdvanced(params: QueryAnswerFeedbackAdvancedParams) {
  const {
    page = 1,
    limit = 10,
    status = 'all',
    userId,
    search,
    startDate,
    endDate,
  } = params;

  try {
    const conditions: SQL[] = [];

    // Filter by status
    if (status === 'correct') {
      conditions.push(eq(answerFeedback.status, 'correct'));
    } else if (status === 'incorrect') {
      conditions.push(eq(answerFeedback.status, 'incorrect'));
    }

    // Filter by userId
    if (userId) {
      conditions.push(eq(answerFeedback.userId, userId));
    }

    // Filter by date range
    if (startDate) {
      conditions.push(sql`${answerFeedback.createdAt} >= ${new Date(startDate).toISOString()}`);
    }
    if (endDate) {
      conditions.push(sql`${answerFeedback.createdAt} <= ${new Date(endDate).toISOString()}`);
    }

    // Search in userPrompt and feedbackText
    if (search) {
      conditions.push(
        sql`(${answerFeedback.userPrompt} ILIKE ${'%' + search + '%'} OR ${answerFeedback.feedbackText} ILIKE ${'%' + search + '%'})`
      );
    }

    // Build query
    let query = db.select().from(answerFeedback);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(answerFeedback)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const total = countResult[0]?.count || 0;

    // Apply pagination and ordering
    const offset = (page - 1) * limit;
    const result = await query
      .orderBy(desc(answerFeedback.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      success: true,
      data: result,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
    console.error('[ANSWER-FEEDBACK] queryAnswerFeedbackAdvanced failed:', errorMsg);
    throw new Error(`Failed to query answer feedback: ${errorMsg}`);
  }
}
