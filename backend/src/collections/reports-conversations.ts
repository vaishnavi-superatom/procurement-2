import * as reportsConversationsService from '../../../database/postgres/src/project-data-db/reports-conversations';
import type { CollectionContext } from './types';

/**
 * Report-generation conversation history — 'create' is called internally by
 * sdk-nodejs's reportComp flow (via the collections registry passed into
 * processReportCompRequest) after every successful report run; 'query' is
 * what the frontend calls to show past prompts/responses for a report.
 * Mirrors dashboard-agent-conversations.ts.
 */
export async function registerReportsConversationsCollections({ sdk }: CollectionContext): Promise<void> {
	sdk.addCollection('reports-conversations', 'create', async (params: {
		reportId: string;
		projectId?: string;
		userId?: string;
		userPrompt: string;
		responseText: string;
		dsl?: unknown;
		status?: 'success' | 'error' | 'aborted';
		error?: unknown;
	}) => {
		return reportsConversationsService.createReportsConversation(params);
	});

	sdk.addCollection('reports-conversations', 'query', async (params: {
		filters?: { reportId?: string; projectId?: string; userId?: string };
		limit?: number;
		sort?: 'ASC' | 'DESC';
	}) => {
		return reportsConversationsService.queryReportsConversations(params);
	});

	// Fetch a single conversation by its own row id — used to look up the exact
	// saved response for an analytics event via its conversationId.
	sdk.addCollection('reports-conversations', 'getById', async (params: { id: number }) => {
		const { id } = params;
		if (!id) throw new Error('id required');
		return reportsConversationsService.getReportsConversationById(Number(id));
	});
}
