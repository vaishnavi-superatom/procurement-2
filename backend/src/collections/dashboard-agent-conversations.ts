import * as dashboardAgentConversationsService from '../../../database/postgres/src/project-data-db/dashboard-agent-conversations';
import type { CollectionContext } from './types';

/**
 * Dashboard agent conversation history — 'create' is called internally by
 * sdk-nodejs's dashboard-agent collection (via sdk.callCollection) after
 * every successful Pi run; 'query' is what the frontend calls to show past
 * prompts/responses for a dashboard.
 */
export async function registerDashboardAgentConversationsCollections({ sdk }: CollectionContext): Promise<void> {
	sdk.addCollection('dashboard-agent-conversations', 'create', async (params: {
		dashboardId: string;
		projectId?: string;
		userId?: string;
		userPrompt: string;
		responseText: string;
		dsl?: unknown;
		status?: 'success' | 'error' | 'aborted';
		error?: unknown;
	}) => {
		return dashboardAgentConversationsService.createDashboardAgentConversation(params);
	});

	sdk.addCollection('dashboard-agent-conversations', 'query', async (params: {
		filters?: { dashboardId?: string; projectId?: string; userId?: string };
		limit?: number;
		sort?: 'ASC' | 'DESC';
	}) => {
		return dashboardAgentConversationsService.queryDashboardAgentConversations(params);
	});

	// Fetch a single conversation by its own row id — used to look up the exact
	// saved response for an analytics event via its conversationId.
	sdk.addCollection('dashboard-agent-conversations', 'getById', async (params: { id: number }) => {
		const { id } = params;
		if (!id) throw new Error('id required');
		return dashboardAgentConversationsService.getDashboardAgentConversationById(Number(id));
	});
}
