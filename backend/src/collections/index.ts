import type { SuperatomSDK } from '@superatomai/sdk-node';
import { registerDashboardAgentCollection, registerCodingAgentCollection } from '@superatomai/sdk-node';
import { ChromaManager, chromaConfig } from '../../../database/chromadb/src/chroma-manager';
import type { CollectionContext } from './types';

// Import all collection registrars
import { registerDatabaseCollections } from './database';
import { registerMssqlDatabaseCollections } from './mssql-database';
import { registerKnowledgeBaseCollections } from './knowledge-base';
import { registerBookmarksCollections, syncBookmarksOnStartup } from './bookmarks';
import { registerKbNodesCollections, syncKbNodesOnStartup } from './kb-nodes';
import { registerDashboardsCollections } from './dashboards';
import { registerDashboardAgentConversationsCollections } from './dashboard-agent-conversations';
import { registerReportsConversationsCollections } from './reports-conversations';
import { registerReportsCollections } from './reports';
import { registerUIsCollections } from './uis';

import { registerUserConversationsCollections } from './user-conversations';
import { registerComponentsCollections } from './components';
import { registerExternalToolsCollections } from './external-tools';
import { registerMenusCollections } from './menus';
import { registerArtifactsCollections } from './artifacts';
import { registerProjectDetailsCollections } from './project-details';
import { registerProjectSourcesCollections } from './project-sources';
import { registerReportAlertsCollections } from './report-alerts';
import { registerSchemaEmbeddingsCollections } from './schema-embeddings';
import { registerSourceEmbeddingsCollections } from './source-embeddings';
import { registerScriptRecipesCollections } from './script-recipes';
import { registerScriptsAdminCollections } from './scripts-admin';
import { registerAnswerFeedbackCollections } from './answer-feedback';
import { registerSpeechCollections } from './speech';
import { registerEntitySearchCollections } from './entity-search';
import { registerConceptsCollections } from './concepts';
import { registerAnswerValidationsCollections } from './answer-validations';
import { registerDashboardBuilderCollections } from './dashboard-builder';
import { registerDashboardBuilderAgentCollections } from './dashboard-builder-agent';
import { registerCompositionGraphCollections } from './composition-graph';
import { registerPrCommentsCollections } from './pr-comments';
import { registerRfqWorkflowCollections } from './rfq-workflow';
import { registerRfqVendorCommentsCollections } from './rfq-vendor-comments';
import { registerVendorProfilesCollections } from './vendor-profiles';

// Re-export types
export type { CollectionContext, CollectionRegistrar } from './types';

/**
 * Initialize ChromaDB managers for different collections
 */
function createChromaManagers() {
	return {
		// Cosine for the same reason as schemaTables below: under Chroma's default
		// squared-L2, `1 - distance` is NOT a similarity (d 0.92-1.21 reports 0.08
		// down to -0.2 for real cosines of 0.54-0.40), so the score recorded per
		// source is wrong and any threshold placed on it would silence retrieval
		// entirely. rebuildIfSpaceChanged() re-embeds on the metric change.
		knowledgeBase: new ChromaManager(undefined, undefined, 'cosine'),
		conversations: new ChromaManager(undefined, chromaConfig.USER_CONVERSATIONS_COLLECTION_NAME),
		components: new ChromaManager(undefined, chromaConfig.COMPONENTS_COLLECTION_NAME),
		bookmarks: new ChromaManager(undefined, chromaConfig.BOOKMARKS_COLLECTION_NAME),
		// Cosine so pre-resolution scores ARE cosine similarity and its cut-offs
		// mean something. Under Chroma's default squared-L2 the reported "0.4"
		// gate was really cosine ≈ 0.25 — effectively no filter at all.
		schemaTables: new ChromaManager(undefined, chromaConfig.SCHEMA_TABLES_COLLECTION_NAME, 'cosine'),
		sourceSummaries: new ChromaManager(undefined, chromaConfig.SOURCE_SUMMARIES_COLLECTION_NAME),
	};
}

/**
 * Register all SDK collections
 * @param sdk - The SuperAtom SDK instance
 */
export async function registerAllCollections(sdk: SuperatomSDK): Promise<void> {
	// Initialize ChromaDB managers
	const chromaManagers = createChromaManagers();

	// Create collection context
	const ctx: CollectionContext = {
		sdk,
		chromaManagers,
	};

	// Register all collections
	await registerDatabaseCollections(ctx);
	await registerMssqlDatabaseCollections(ctx);
	await registerKnowledgeBaseCollections(ctx);
	await registerBookmarksCollections(ctx);
	await registerKbNodesCollections(ctx);
	await registerDashboardsCollections(ctx);
	await registerDashboardAgentConversationsCollections(ctx);
	await registerReportsConversationsCollections(ctx);
	await registerReportsCollections(ctx);
	await registerUIsCollections(ctx);
	await registerUserConversationsCollections(ctx);
	await registerComponentsCollections(ctx);
	await registerExternalToolsCollections(ctx);
	await registerMenusCollections(ctx);
	await registerArtifactsCollections(ctx);
	await registerProjectDetailsCollections(ctx);
	await registerProjectSourcesCollections(ctx);
	await registerReportAlertsCollections(ctx);
	await registerSchemaEmbeddingsCollections(ctx);
	await registerSourceEmbeddingsCollections(ctx);
	await registerScriptRecipesCollections(ctx);
	await registerScriptsAdminCollections(ctx);
	await registerAnswerFeedbackCollections(ctx);
	await registerSpeechCollections(ctx);
	await registerEntitySearchCollections(ctx);
	await registerConceptsCollections(ctx);
	await registerAnswerValidationsCollections(ctx);
	await registerCompositionGraphCollections(ctx);
	await registerPrCommentsCollections(ctx);
	await registerRfqWorkflowCollections(ctx);
	await registerRfqVendorCommentsCollections(ctx);
	await registerVendorProfilesCollections(ctx);

	// Program-generated dashboards — kept apart from the JSON-DSL dashboard collections.
	await registerDashboardBuilderCollections(ctx);
	await registerDashboardBuilderAgentCollections(ctx);

	// Whole-dashboard generation via Pi — fully generic now: sdk-nodejs
	// defaults AGENTS.md's location to .prompts/dashboard-agent and runtime
	// state to .pi-dashboard-agent-runtime (both relative to this process's
	// own cwd, overridable via PI_AGENT_DIR/PI_AGENT_RUNTIME_DIR), and reads
	// the tool list / current dashboard state from sdk.getTools() and the
	// 'dashboards'.'query' collection this project already registers above —
	// nothing project-specific left to configure here.
	registerDashboardAgentCollection(sdk);

	// Open-ended coding-agent chat (the admin UI's Agents tab), as opposed to
	// dashboard-agent's single deliverable. Defaults come from sdk-nodejs:
	// harness from CODING_AGENT_HARNESS (codex), per-thread workspaces under
	// CODING_AGENT_RUNTIME_DIR (.coding-agent-runtime relative to this
	// process's cwd). Requires `pnpm add @openai/codex-sdk` + `codex login`;
	// without them the first turn fails with a clear "not installed" message
	// rather than breaking startup.
	registerCodingAgentCollection(sdk);

	console.log('🚀 All collections registered!\n');

	// Auto-sync bookmarks on startup (async, don't block)
	syncBookmarksOnStartup(sdk);

	// Auto-sync kb-nodes on startup (async, don't block)
	syncKbNodesOnStartup(sdk);
}
