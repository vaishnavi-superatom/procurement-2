/**
 * The agent's tools are no longer written into its workspace.
 *
 * They live once, in `backend/agent-tools/` — the shared lookups in `common/`
 * and the builder's own in `dashboard-builder/` — and are linked into the
 * workspace as `tools/` and `dash/` by coding-agents/tool-folders.ts. What a
 * tool needs about the session arrives as environment variables; see
 * agent-tools/dashboard-builder/_bridge.js.
 *
 * What remains here is the one constant the bridge shares with those tools.
 */

/** Rows any one agent call prints. Fixed; the agent cannot change it. Mirrored in dash/run-resolver. */
export const AGENT_ROWS = 30;
