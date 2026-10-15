import { getSourceManager } from '../sources';
import { getAllTools } from '../tools';
import { getEntityCatalog } from '../../../database/postgres/src/project-data-db/entity-search';
import { getConceptCatalog } from '../../../database/postgres/src/project-data-db/concepts';

/**
 * Data access for a coding agent, as workspace executables.
 *
 * Delivered as shims rather than MCP because codex gates MCP tool calls on the
 * sandbox: under workspace-write they need approval, a headless run must set
 * approvalPolicy 'never', and that denies rather than grants. Only
 * danger-full-access permits them — which drops the filesystem sandbox
 * altogether. Bash needs no approval, so the shims keep the capability and the
 * sandbox both.
 *
 * Resolved at call time, not import time: script-bridge binds an ephemeral port
 * during startup and the source manager initialises then too.
 */
export interface BridgeAccess {
	bridgeUrl: string;
	sources: Array<{ id: string; name?: string; description?: string; searchable?: boolean; type?: string }>;
	directTools?: Array<{ id: string; name?: string; description?: string; params?: Record<string, string> }>;
	/** Entity types ./resolve-entities can resolve names against (e.g. "customer", "project") — see includeEntityResolution. */
	entityTypes?: string[];
	/** Every verified concept — name, aliases, and what it is for. See includeConceptCatalog. */
	conceptCatalog?: Array<{ name: string; kind?: string; aliases?: string[]; description?: string | null }>;
	/** Whether ./knowledge-base is offered — see includeKnowledgeBase. */
	knowledgeBase?: boolean;
}

/**
 * Null when the bridge is down or no source is connected — the agent is then
 * told it has no data access, rather than handed a broken tool.
 *
 * Called with no options it offers raw data access only (./sources, ./query) —
 * what a read-only agent like the concept builder or the answer agent needs.
 * The options add what an agent that builds things needs:
 *
 * `includeDirectTools` also offers pre-built business-logic tools via
 * ./run-tool, not just raw ./query. Off by default: a read-only agent has no
 * business invoking one of these directly, only reading the data they read.
 *
 * `includeEntityResolution` lists the entity-type catalog (for ./sources) so
 * ./resolve-entities gets offered — kept as a separate flag since a caller
 * could plausibly want one without the other.
 *
 * `includeConceptCatalog` lists every verified concept — name, aliases and what
 * it is for (for ./concept-catalog) — deliberately its OWN flag and its OWN
 * bridge endpoint rather than a method on a shared direct tool: tools in
 * getAllTools() are shared with MainAgent/SourceAgent's own flow, and the
 * catalog should stay reachable only by an agent whose workspace has this shim.
 *
 * `includeKnowledgeBase` offers ./knowledge-base — same reasoning:
 * MainAgent/SourceAgent already get KB context injected upfront through their
 * own mechanism, and a second, callable path to the same data there would be
 * redundant and confusing.
 */
export async function bridgeAccess(opts: {
	includeDirectTools?: boolean;
	includeEntityResolution?: boolean;
	includeConceptCatalog?: boolean;
	includeKnowledgeBase?: boolean;
} = {}): Promise<BridgeAccess | null> {
	const bridgeUrl = process.env.SCRIPT_BRIDGE_URL;
	if (!bridgeUrl) {
		console.warn('[coding-agents] SCRIPT_BRIDGE_URL unset — data access not offered');
		return null;
	}

	// The source manager's own list, NOT getAllTools(), for ./query — that also
	// returns direct tools and static tools, which are a different thing
	// (pre-built business logic, not raw data to read).
	//
	// Deliberately not filtered by an id suffix: that is source-type specific
	// (postgres yields `_query`, NetSuite `_suiteql`), and a suffix guess
	// silently offered this project nothing.
	//
	// searchable: whether this source carries a schemaSearchFn (base-source.ts's
	// getTool() attaches one for medium/large/very_large schemas) — the same flag
	// the SourceAgent's search_schema tool is offered on, so an agent knows which
	// toolIds ./schema-search actually works against.
	const manager = getSourceManager();
	const sources = (manager?.getSourceTools() ?? []).map((t: any) => ({
		id: t.id,
		name: t.name,
		description: t.description?.slice(0, 200),
		...(t.schemaSearchFn ? { searchable: true } : {}),
		// The SQL dialect; the federation tool has no instance, so no type.
		type: manager?.getInstance(t.id.replace(/_query$|_suiteql$/, ''))?.getType(),
	}));

	const directTools = opts.includeDirectTools
		? getAllTools()
			.filter((t: any) => t.toolType === 'direct')
			.map((t: any) => ({ id: t.id, name: t.name, description: t.description?.slice(0, 400), params: t.params }))
		: [];

	let entityTypes: string[] = [];
	if (opts.includeEntityResolution) {
		try {
			entityTypes = (await getEntityCatalog()).data.map((t) => t.entityType);
		} catch (err: any) {
			console.warn(`[coding-agents] entity catalog unavailable — ./resolve-entities not offered: ${err?.message ?? err}`);
		}
	}

	/**
	 * Undefined means unreachable. An empty array means reachable and empty.
	 *
	 * The shim writer treats them differently: no store means no tool, an empty
	 * store means a tool that returns nothing. Collapsing them would take
	 * ./concept-catalog away from a project that has not written its first
	 * concept — the one case where an agent most needs to see that the
	 * vocabulary is empty rather than find the tool missing.
	 */
	let conceptCatalog: Array<{ name: string; kind?: string; aliases?: string[]; description?: string | null }> | undefined;
	if (opts.includeConceptCatalog) {
		try {
			conceptCatalog = (await getConceptCatalog()).data;
		} catch (err: any) {
			console.warn(`[coding-agents] concept catalog unavailable — ./concept-catalog not offered: ${err?.message ?? err}`);
		}
	}

	const knowledgeBase = !!opts.includeKnowledgeBase;

	if (!sources.length && !directTools.length && !entityTypes.length && !conceptCatalog && !knowledgeBase) return null;
	return {
		bridgeUrl,
		sources,
		...(directTools.length ? { directTools } : {}),
		...(entityTypes.length ? { entityTypes } : {}),
		...(conceptCatalog ? { conceptCatalog } : {}),
		...(knowledgeBase ? { knowledgeBase } : {}),
	};
}
