import { UIBlock } from '@superatomai/sdk-node';
import * as answerFeedbackService from '../../../database/postgres/src/project-data-db/answer-feedback';
import type { CollectionContext } from './types';

/**
 * Create answer feedback with dual-write:
 * 1. Write to LOCAL answer_feedback (authoritative)
 * 2. Forward to CENTRAL sa-api (best-effort, no-fail)
 */
export async function createAnswerFeedback(params: {
	uiBlockId: string;
	threadId?: string;
	userId?: string;
	userPrompt: string;
	answerSnapshot?: unknown;
	status?: "correct" | "incorrect" | "partial" ;
	feedbackText?: string;
}) {
	// STEP 1: Write to LOCAL answer_feedback (AUTHORITATIVE)
	// This is the source of truth - must succeed

	let db_response = await answerFeedbackService.createAnswerFeedback({
		uiBlockId: params.uiBlockId,
		threadId: params.threadId,
		userId: params.userId,
		userPrompt: params.userPrompt,
		answerSnapshot: params.answerSnapshot,
		status: params.status,
		feedbackText: params.feedbackText,
	});

	

	// STEP 2: Forward to CENTRAL sa-api (BEST-EFFORT, NO-FAIL)
	// This must never block or throw - local write is already done
	try {
		const apiBase = process.env.SA_API_BASE_URL;
		const serviceToken = process.env.SA_INTERNAL_SERVICE_TOKEN;

		// If env vars aren't set, skip silently (local write already succeeded)
		if (!apiBase || !serviceToken) {
			console.warn('[answer-feedback] Central forward skipped: SA_API_BASE_URL or SA_INTERNAL_SERVICE_TOKEN not set');
			return false;
		}

		console.log('[answer-feedback] Forwarding to central sa-api at:', apiBase);

		// TODO: Resolve CENTRAL org/user/project IDs
		// (Use the same identity resolution as chat_analytics ingest)
		const centralIdentity = {
			orgId: process.env.SA_ORG_ID,
			projectId: process.env.SUPERATOM_PROJECT_ID,
			userId: params.userId,
		};

		const payload = {
			...centralIdentity,
			threadId: params.threadId,
			uiBlockId: params.uiBlockId,
			userPrompt: params.userPrompt,
			status : params.status,
			feedbackText: params.feedbackText || null,
			answerSnapshot: params.answerSnapshot || null,
		};

		console.log('[answer-feedback] Central payload:', JSON.stringify(payload, null, 2));

		const response = await fetch(
			`${apiBase}/answer-feedback`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-SA-Service-Token': serviceToken,
				},
				body: JSON.stringify(payload),
			}
		);

		console.log('[answer-feedback] Central response status:', response.status);

		if (!response.ok) {
			const responseText = await response.text();
			console.warn(
				`[answer-feedback] Central forward failed (${response.status}): ${responseText}`
			);
		} else {
			console.log('[answer-feedback] Central forward successful! Data sent to Neon.');
		}
	} catch (error) {
		// Silence errors - local write already succeeded
		console.warn('[answer-feedback] Central forward error (local row stands):', error);
	}

	return db_response;
}

/**
 * Query answer feedback from LOCAL database
 */
export async function queryAnswerFeedback(params: {
	filters?: { userId?: string; uiBlockId?: string };
	limit?: number;
}) {
	return answerFeedbackService.queryAnswerFeedback(params);
}

/**
 * Register answer feedback collections with SDK
 */
export async function registerAnswerFeedbackCollections({ sdk }: CollectionContext): Promise<void> {
	// Create answer feedback — local write + best-effort central forward
	sdk.addCollection('answer-feedback', 'create', async (params: any) => {
		let { uiBlockId, threadId, userId, userPrompt, answerSnapshot, status, feedbackText } = params;

		console.log('[ANSWER-FEEDBACK] Raw params received:', params);

		if (!uiBlockId) {
			throw new Error('uiBlockId is required');
		}

		if (!userPrompt) {
			throw new Error('userPrompt is required');
		}

		try {
			console.log('[ANSWER-FEEDBACK] Creating feedback for uiBlockId:', uiBlockId, 'status:', status);
			const result = await createAnswerFeedback({
				uiBlockId,
				threadId,
				userId,
				userPrompt,
				answerSnapshot,
				status,
				feedbackText,
			});
			// console.log('[ANSWER-FEEDBACK] Local write successful, ID:', result.data?.id);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[ANSWER-FEEDBACK] Create failed:', errorMsg);
			throw new Error(`Failed to create answer feedback: ${errorMsg}`);
		}
	});

	// Query answer feedback
	sdk.addCollection('answer-feedback', 'query', async (params: any) => {
		try {
			console.log('[ANSWER-FEEDBACK] Querying feedback with filters:', params.filters);
			const result = await queryAnswerFeedback(params);
			console.log('[ANSWER-FEEDBACK] Query returned', result.count, 'results');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[ANSWER-FEEDBACK] Query failed:', errorMsg);
		}
	})}