import * as fs from 'fs';
import * as path from 'path';

/**
 * The tools every coding agent runs, and how a workspace reaches them.
 *
 * All tools live in ONE place, `backend/agent-tools/`, one folder per audience:
 *
 *   common/              lookups every agent uses — sources, query, schema,
 *                        entities, concepts
 *   dashboard-builder/   the dashboard builder's own tools
 *
 * A workspace never gets copies. Each folder an agent uses is LINKED in under a
 * short name (`tools/`, `dash/`), so editing a tool reaches every live
 * workspace on its next command, and nothing specific to a run is ever written
 * to disk. What a tool needs to know about the run — the bridge address, whose
 * identity it queries as, which dashboard — arrives as environment variables
 * (SA_BRIDGE_URL, SA_CONTEXT_TOKEN, …), set by the agent when it starts.
 *
 * Every tool is a thin script — bash or node — whose second line is
 * `# name — what it is for` (or `// …`): the work is on the bridge.
 * `describeTools` reads those lines, so a prompt lists the tools from the tools
 * themselves and can never drift from them. Files starting with `_` are helpers
 * the tools share, not tools.
 */

// process.cwd(), not __dirname: compiled, this file runs from dist/backend/src/…,
// where ../../ is dist/backend — no tools there. cwd is backend/ under ts-node,
// PM2 and the Docker image alike, as .prompts elsewhere already assumes.
export const AGENT_TOOLS_ROOT = path.join(process.cwd(), 'agent-tools');

/**
 * Link tool folders into a workspace: `{ tools: 'common' }` makes
 * `<dir>/tools` point at `agent-tools/common`.
 */
export function linkToolFolders(dir: string, links: Record<string, string>): void {
	for (const [name, folder] of Object.entries(links)) {
		const target = path.join(AGENT_TOOLS_ROOT, folder);
		// A dangling link reads to the agent as "tools exist but are broken";
		// absent reads as "this deployment has none". The second is the honest one.
		if (!fs.existsSync(target)) continue;
		const link = path.join(dir, name);
		// Workspaces persist, so an existing link can point at a stale path (repo
		// moved, worktree). Repoint rather than trust it.
		try {
			if (fs.realpathSync(link) === fs.realpathSync(target)) continue;
		} catch { /* missing or dangling — fall through and recreate */ }
		fs.rmSync(link, { force: true, recursive: false });
		// 'junction', not 'dir': a Windows dir symlink needs admin or Developer Mode
		// and fails with EPERM otherwise. Junctions need neither; elsewhere the type
		// argument is ignored and this is an ordinary symlink.
		fs.symlinkSync(target, link, 'junction');
	}
}

export interface ToolSummary {
	/** How the agent calls it, e.g. `tools/find-schema`. */
	name: string;
	/** The one line from the tool's header: what it is for. */
	summary: string;
}

/**
 * The tools in the linked folders, each with the one-line summary from its own
 * header (`# find-schema — find which table and column holds something.`).
 * `{ tools: 'common' }` lists `agent-tools/common/*` as `tools/<name>`.
 */
export function describeTools(links: Record<string, string>): ToolSummary[] {
	const out: ToolSummary[] = [];
	for (const [name, folder] of Object.entries(links)) {
		const dir = path.join(AGENT_TOOLS_ROOT, folder);
		let files: string[] = [];
		try {
			// `_name` files are helpers the tools share, not tools.
			files = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && !f.startsWith('_')).sort();
		} catch {
			continue;
		}
		for (const file of files) {
			const header = fs.readFileSync(path.join(dir, file), 'utf-8').split(/\r?\n/)[1] ?? '';
			// "# find-schema — what it does." (bash) or "// inventory — what it does."
			// (node) → "what it does."
			const summary = header.replace(/^(#|\/\/)\s*/, '').replace(/^[\w-]+\s+[—-]\s+/, '').trim();
			out.push({ name: `${name}/${file}`, summary });
		}
	}
	return out;
}

/** The tool list as prompt text, one aligned line per tool. */
export function toolsSection(links: Record<string, string>): string {
	const tools = describeTools(links);
	if (!tools.length) return '  (none — no tools are available to this agent)';
	const width = Math.max(...tools.map((t) => t.name.length));
	return tools.map((t) => `  ${t.name.padEnd(width)}  ${t.summary}`).join('\n');
}
