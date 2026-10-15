import type { SuperatomSDK } from '@superatomai/sdk-node';
import type { ChromaManager } from '../../../database/chromadb/src/chroma-manager';

/**
 * Context passed to collection registration functions
 */
export interface CollectionContext {
	sdk: SuperatomSDK;
	chromaManagers: {
		knowledgeBase: ChromaManager;
		conversations: ChromaManager;
		components: ChromaManager;
		bookmarks: ChromaManager;
		schemaTables: ChromaManager;
		sourceSummaries: ChromaManager;
	};
}

/**
 * Function signature for registering collections
 */
export type CollectionRegistrar = (ctx: CollectionContext) => Promise<void>;
