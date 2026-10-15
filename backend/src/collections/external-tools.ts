import type { CollectionContext } from './types';
import { getAllTools, STATIC_TOOLS } from '../tools';
import { queryCache, ScriptStore, runScript } from '@superatomai/sdk-node';
import { scriptRecipeStore } from './script-recipes';

/**
 * A script-dataset regeneration descriptor — what a `script_dataset` queryId
 * token decodes to once we moved off the non-executable placeholder SQL. Lets
 * us re-run the saved recipe for FRESH data on cache expiry (#6). See
 * backend/docs/SCRIPT-FLOW-SCALING-ISSUES.md and project memory
 * `project_script_dataset_expiry_fix`.
 */
interface ScriptDatasetDescriptor {
    kind: 'script_dataset';
    recipeId: string;
    params?: Record<string, any>;
    datasetRef: string;
}

function asScriptDatasetDescriptor(query: any): ScriptDatasetDescriptor | null {
    if (query && typeof query === 'object' && query.kind === 'script_dataset' && query.recipeId && query.datasetRef) {
        return query as ScriptDatasetDescriptor;
    }
    return null;
}

/**
 * Re-run the saved script to regenerate a computed (post-JS) dataset and refresh
 * the cache under the SAME queryId. Returns fresh `{ data, count }`, or null if
 * the recipe is gone / the source is unreachable / the dataset isn't produced —
 * in which case the caller surfaces an honest "couldn't refresh" message rather
 * than stale data. The re-run is bounded by the runner's concurrency cap (#2).
 */
async function regenerateScriptDataset(
    descriptor: ScriptDatasetDescriptor,
    queryId: string,
): Promise<{ data: any[]; count: number } | null> {
    try {
        const store = new ScriptStore({ store: scriptRecipeStore });
        const recipe = await store.get(descriptor.recipeId);
        if (!recipe || !recipe.scriptBody) {
            console.warn(`[ExternalTools] regen: recipe '${descriptor.recipeId}' not found or body missing`);
            return null;
        }
        const scriptPath = store.getScriptPath(recipe);
        const result = await runScript(recipe, scriptPath, descriptor.params || {}, {
            externalTools: getAllTools() as any,
        });
        if (!result.success) {
            console.warn(`[ExternalTools] regen: script '${recipe.name}' failed: ${result.error}`);
            return null;
        }
        const match = result.executedQueries.find((q: any) => q.sourceId === descriptor.datasetRef);
        if (!match) {
            console.warn(`[ExternalTools] regen: datasetRef '${descriptor.datasetRef}' not in script output`);
            return null;
        }
        const payload = { data: match.data, count: match.count };
        queryCache.set(queryId, payload); // refresh under the same token (no new IV)
        console.log(`[ExternalTools] regenerated script dataset '${descriptor.datasetRef}' (${match.count} rows)`);
        return payload;
    } catch (err) {
        console.error('[ExternalTools] script-dataset regeneration failed:', err);
        return null;
    }
}

/**
 * Register external-tools collection for form-based tool execution
 * This allows the DynamicForm component to execute external tools via WebSocket
 */
export async function registerExternalToolsCollections(ctx: CollectionContext): Promise<void> {
    const { sdk } = ctx;

    /**
     * Execute an external tool with the provided parameters and form data
     * Called by DynamicForm when submitting a form with externalTool prop
     */
    sdk.addCollection('external-tools', 'execute', async (params: {
        toolId: string;
        toolName: string;
        data: Record<string, any>;
        [key: string]: any
    }) => {
        const { toolId, toolName, data, ...otherParams } = params;

        console.log(`[ExternalTools] Executing tool: ${toolName} (${toolId})`);
        console.log(`[ExternalTools] Tool parameters:`, otherParams);
        console.log(`[ExternalTools] Form data:`, data);

        // Get all tools (static + dynamic source tools)
        const allTools = getAllTools();

        // Find the tool by ID
        const tool = allTools.find(t => t.id === toolId);
        if (!tool) {
            console.error(`[ExternalTools] Tool not found: ${toolId}`);
            return {
                success: false,
                error: `Tool '${toolId}' not found. Available tools: ${allTools.map(t => t.id).join(', ')}`
            };
        }

        // Execute the tool with merged parameters
        // For create/update operations, the form data goes into the 'data' field
        try {
            const toolParams = {
                ...otherParams,
                data: data
            };

            console.log(`[ExternalTools] Calling tool function with params:`, toolParams);
            const result = await tool.fn(toolParams);


            // Check if the result indicates an error
            if (result && result.error) {
                const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
                return {
                    success: false,
                    error: errMsg || `Tool '${toolName}' returned an error`,
                    data: result
                };
            }

            return {
                success: true,
                data: result,
                message: `${toolName} executed successfully`
            };
        } catch (error: any) {
            const errorMsg = error instanceof Error
                ? error.message
                : (error && typeof error === 'object')
                    ? (error.message || error.error || JSON.stringify(error))
                    : String(error);
            console.error(`[ExternalTools] Tool execution failed for ${toolName} (${toolId}):`, errorMsg);
            return {
                success: false,
                error: errorMsg || `Tool '${toolName}' execution failed unexpectedly`
            };
        }
    });

    /**
     * Execute a tool using a server-stored queryId (SQL never reaches the frontend)
     * Frontend sends queryId + optional filterParams; backend resolves queryId → SQL and executes
     */
    sdk.addCollection('external-tools', 'executeByQueryId', async (params: {
        toolId: string;
        queryId: string;
        params?: Record<string, any>;
        filterParams?: Record<string, any>;
    }) => {
        const { toolId, queryId, params: queryParams, filterParams } = params;

        console.log(`[ExternalTools] executeByQueryId: tool=${toolId}, queryId=${queryId}`);

        // Resolve queryId → stored SQL
        const stored = queryCache.getQuery(queryId);
        if (!stored) {
            console.error(`[ExternalTools] queryId not found or expired: ${queryId}`);
            return {
                success: false,
                error: `Query expired or not found (queryId: ${queryId}). Please refresh and try again.`
            };
        }

        // Cache short-circuit — when the queryCache already holds the row data
        // (script-resident datasets, validation-time results) and the caller
        // hasn't asked for filter overrides, serve from cache directly. We
        // intentionally skip the tool lookup here so script datasets with
        // sentinel toolIds ('script_dataset', 'computed:*') can render without
        // needing a real backend tool.
        const hasOverrides = (queryParams && Object.keys(queryParams).length > 0) || (filterParams && Object.keys(filterParams).length > 0);
        if (stored.data && !hasOverrides) {
            console.log(`[ExternalTools] executeByQueryId: returning cached data for ${queryId} (tool=${toolId})`);
            return {
                success: true,
                data: stored.data,
                message: 'Tool executed successfully (cached)'
            };
        }

        // Script-dataset regeneration (#6) — computed/post-JS datasets have no
        // re-runnable SQL, so on a cache miss we re-run the saved recipe to get
        // FRESH data (never persist stale computed rows). Reached when the cached
        // data has expired/evicted. Tokens minted before this shipped hold a
        // placeholder string (not a descriptor) and fall through to the sentinel.
        const descriptor = asScriptDatasetDescriptor(stored.query);
        if (descriptor) {
            const regen = await regenerateScriptDataset(descriptor, queryId);
            if (regen) {
                return { success: true, data: regen, message: 'Script dataset regenerated' };
            }
            return {
                success: false,
                error: 'Could not refresh this data — the underlying script could not be re-run (recipe removed or source unavailable). Please re-ask the question.',
            };
        }

        // Re-execution path — we need a real tool to run the stored SQL.
        const allTools = getAllTools();
        const tool = allTools.find(t => t.id === toolId);
        if (!tool) {
            console.error(`[ExternalTools] Tool not found: ${toolId}`);
            return {
                success: false,
                error: `Tool '${toolId}' not found.`
            };
        }

        // Build tool parameters: resolved SQL + params (static + filter overrides)
        const mergedParams = { ...queryParams, ...filterParams };
        const toolParams: Record<string, any> = {
            sql: stored.query,
            ...(Object.keys(mergedParams).length > 0 && { params: mergedParams }),
        };

        console.log(`[ExternalTools] Executing tool with resolved query (${String(stored.query).substring(0, 80)}...)`);

        try {
            const result = await tool.fn(toolParams);

            if (result && result.error) {
                const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
                return { success: false, error: errMsg || `Tool '${toolId}' returned an error`, data: result };
            }

            return {
                success: true,
                data: result,
                message: `Tool executed successfully`
            };
        } catch (error: any) {
            const errorMsg = error instanceof Error
                ? error.message
                : (error && typeof error === 'object')
                    ? (error.message || error.error || JSON.stringify(error))
                    : String(error);
            console.error(`[ExternalTools] executeByQueryId failed for tool=${toolId}, queryId=${queryId}:`, errorMsg);
            return { success: false, error: errorMsg || `Tool '${toolId}' execution failed unexpectedly` };
        }
    });

    /**
     * Look up the stored SQL query behind a queryId
     * Used for debugging/inspecting what query a component is using
     */
    sdk.addCollection('external-tools', 'getQuery', async (params: { queryId: string }) => {
        const { queryId } = params;

        if (!queryId) {
            return { success: false, error: 'queryId is required' };
        }

        const stored = queryCache.getQuery(queryId);
        if (!stored) {
            return { success: false, error: `Query not found or expired (queryId: ${queryId})` };
        }

        return {
            success: true,
            queryId,
            query: stored.query,
            hasData: stored.data !== null,
        };
    });

    console.log(`✓ External tools collection registered (${STATIC_TOOLS.length} static tools + dynamic source tools)`);
}
