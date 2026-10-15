import { T_TOOL } from "./types";
import { createAllDirectTools } from './direct';

/**
 * Sentinel tool for script-resident datasets (post-JS computed data from
 * the script flow, and ctx.emit() datasets). Components targeting these
 * sources are rendered with toolId='script_dataset' so the frontend's
 * executeByQueryId resolves them via the queryCache short-circuit instead
 * of attempting to re-execute SQL. The fn here only fires if the cache
 * has expired — in that case the user must re-ask the question to
 * regenerate the dataset. See backend/docs/SCRIPT-FLOW-IMPLEMENTATION.md.
 */
const SCRIPT_DATASET_TOOL: T_TOOL = {
    id: 'script_dataset',
    name: 'Script Dataset',
    description: 'Pre-computed dataset produced by a saved script. Rendered from the queryCache; cannot be re-executed independently.',
    params: {},
    fn: async () => ({
        error: 'Script dataset expired from cache. Re-ask the question to regenerate.',
    }),
};

const TOOLS: T_TOOL[] = [SCRIPT_DATASET_TOOL];

// Static tools (defined above)
export const STATIC_TOOLS = TOOLS;

/**
 * Get all tools including dynamic source tools and direct tools.
 * Source tools are generated from configured data sources.
 * Direct tools are project-specific pre-built function tools,
 * each linked to a specific source instance by ID.
 */
export function getAllTools(): T_TOOL[] {
    // Import here to avoid circular dependency
    const { getSourceManager } = require('../sources');

    const sourceManager = getSourceManager();
    const sourceTools = sourceManager?.getSourceTools() || [];

    // Create direct tools — each project config resolves its own source by ID
    let directTools: T_TOOL[] = [];
    if (sourceManager) {
        directTools = createAllDirectTools(
            (id: string) => sourceManager.getInstance(id)
        ) as T_TOOL[];
    }

    // Source tools first, then direct tools, then static tools
    return [...sourceTools, ...directTools, ...STATIC_TOOLS] as T_TOOL[];
}

// Default export for backward compatibility
export default TOOLS;