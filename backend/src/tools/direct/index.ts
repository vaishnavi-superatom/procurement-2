/**
 * Direct Tools Loader
 *
 * Direct tools are pre-built function tools with hardcoded business logic.
 * They are called directly by the MainAgent (no SourceAgent/SQL generation).
 *
 * Each project has its own subfolder with tool files and a config that links
 * them to a specific source instance by ID.
 *
 * A tool is exposed to the agent ONLY by being listed in PROJECT_CONFIGS below.
 *
 * See README.md in this folder for the full architecture + how a direct tool is
 * sent to the LLM. See _example/ for a generic, copy-me reference tool — it is
 * intentionally NOT imported/registered here, so it never reaches the LLM.
 *
 * To add a new project:
 * 1. Create a folder: direct/{project-name}/
 * 2. Add tool files (functions + factory)
 * 3. Create index.ts exporting { sourceId, createTools }
 * 4. Import and add to PROJECT_CONFIGS below
 */

import type { SourceTool } from '../../sources/core/types';

/** Execute function signature matching source instance execute() */
export type ExecuteFn = (params: { sql: string; params?: Record<string, any> }) => Promise<any>;

interface ProjectToolsConfig {
    sourceId: string;
    createTools: (execute: ExecuteFn) => SourceTool[];
}

// Registry of all ACTIVE project tool configs exposed to the agent.
// Empty by default = no direct tools are surfaced to the LLM (SQL sources only).
// To add one: import its module and push it here (see _example/ for the shape).
const PROJECT_CONFIGS: ProjectToolsConfig[] = [];

/**
 * Create all direct tools by resolving each project's source instance.
 * Called from tools/index.ts with a source instance lookup function.
 */
export function createAllDirectTools(getSourceInstance: (id: string) => any | undefined): SourceTool[] {
    const tools: SourceTool[] = [];

    for (const config of PROJECT_CONFIGS) {
        const instance = getSourceInstance(config.sourceId);
        if (!instance) {
            console.warn(`[DirectTools] Source '${config.sourceId}' not found — skipping its direct tools`);
            continue;
        }
        try {
            const execute = (params: any) => instance.execute(params);
            const projectTools = config.createTools(execute);
            tools.push(...projectTools);
            console.log(`[DirectTools] Loaded ${projectTools.length} direct tool(s) for source '${config.sourceId}'`);
        } catch (error) {
            console.error(`[DirectTools] Failed to create tools for source '${config.sourceId}':`, error);
        }
    }

    return tools;
}
