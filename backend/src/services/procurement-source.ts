import { runAsSystem } from '@superatomai/sdk-node';
import { getSourceManager } from '../sources/core/source-manager';

// The procurement data source (Neon): the same one the PR and RFQ screens
// query (TOOL_ID in frontend modules/PurchaseRequests).
//local-source id
export const PROCUREMENT_SOURCE_ID = 'postgres-6a0f22831b3f';
//prod-source id
//export const PROCUREMENT_SOURCE_ID = 'postgres-0fc80d2496ff';

/**
 * Run fixed, server-built SQL against the procurement source as a system flow.
 * Writes need the source's writeMode to be at least 'dml'.
 */
export async function queryProcurement<T = any>(label: string, sql: string, params?: Record<string, unknown>): Promise<T[]> {
	const instance = getSourceManager()?.getInstance(PROCUREMENT_SOURCE_ID);
	if (!instance) {
		throw new Error('The procurement data source is not connected');
	}
	const result = await runAsSystem(label, () => instance.execute({ sql, params }));
	return result.data as T[];
}
