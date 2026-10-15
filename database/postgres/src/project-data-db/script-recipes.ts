import { db, schema } from './drizzle-db';
import { and, eq, or, sql, desc, isNull } from 'drizzle-orm';

const { scriptRecipes } = schema;

/**
 * Script Recipes — Postgres-backed metadata store for the script flow.
 *
 * This replaces the old "read every file in scripts-store/ and send the whole
 * catalog to the LLM" matcher. Metadata lives here; the executable body stays
 * on disk as scripts-store/<file_base>.ts (editable). Matching is Postgres FTS
 * over weighted name/tags/intent, returning a small shortlist for the LLM.
 *
 * See backend/docs/SCRIPT-FLOW-SCALING-ISSUES.md (#1, #3, #7).
 */

const MAX_FAILURE_RATE = 0.2;
const HEALTH_MIN_RUNS = 5;
const DEFAULT_SEARCH_LIMIT = 20;
const SAFETY_NET_FLOOR = 3;   // if FTS returns fewer than this, top up with popular scripts
const SAFETY_NET_SIZE = 5;

export interface ScriptRecipeRow {
	id: string;
	projectId: string | null;
	version: number;
	name: string;
	intentDescription: string;
	tags: string[] | null;
	createdFrom: string | null;
	sourceIds: string[] | null;
	tables: string[] | null;
	parameters: any;
	components: any;
	displayPreference: any;
	fileBase: string;
	bodyHash: string | null;
	successCount: number;
	failureCount: number;
	lastUsed: string | null;
	parentId: string | null;
	forkDepth: number | null;
	forkReason: string | null;
	status: string;
	turnId: string | null;
	lastError: any;
	// User-directed edit provenance (see commitScriptRecipeEdit).
	editedBy: string | null;
	editedFrom: string | null;
	history: any;
	createdAt: string | null;
	updatedAt: string | null;
}

/** Weighted tsvector used for ranking (name/tags = A, intent = B, source question = C). */
function rankVector() {
	return sql`(
		setweight(to_tsvector('english', coalesce(${scriptRecipes.name}, '')), 'A') ||
		setweight(to_tsvector('english', coalesce(array_to_string(${scriptRecipes.tags}, ' '), '')), 'A') ||
		setweight(to_tsvector('english', coalesce(${scriptRecipes.intentDescription}, '')), 'B') ||
		setweight(to_tsvector('english', coalesce(${scriptRecipes.createdFrom}, '')), 'C')
	)`;
}

/** verified AND (under the failure-rate threshold OR too few runs to judge). */
function healthyVerified() {
	return and(
		eq(scriptRecipes.status, 'verified'),
		sql`(
			(${scriptRecipes.successCount} + ${scriptRecipes.failureCount}) < ${HEALTH_MIN_RUNS}
			OR ${scriptRecipes.failureCount}::float
			   / NULLIF(${scriptRecipes.successCount} + ${scriptRecipes.failureCount}, 0) <= ${MAX_FAILURE_RATE}
		)`,
	);
}

function projectScope(projectId?: string) {
	// When a project is given, match its rows plus any project-less (single-VM) rows.
	if (projectId) return or(eq(scriptRecipes.projectId, projectId), isNull(scriptRecipes.projectId));
	return undefined;
}

/** Tokenize a prompt into lowercase word tokens for the tags-overlap fallback. */
function promptTokens(prompt: string): string[] {
	return Array.from(
		new Set(
			(prompt.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length >= 3),
		),
	).slice(0, 30);
}

/**
 * Full-text search for the best-matching verified recipes. Returns a ranked
 * shortlist (default 20). The matcher LLM then picks among these — so this
 * only needs high recall, not precision.
 */
export async function searchScriptRecipes(params: {
	prompt: string;
	projectId?: string;
	limit?: number;
}): Promise<ScriptRecipeRow[]> {
	const { prompt, projectId, limit = DEFAULT_SEARCH_LIMIT } = params;
	const tsquery = sql`websearch_to_tsquery('english', ${prompt})`;
	const tokens = promptTokens(prompt);

	// Index-backed lexical match: OR the per-field tsvector conditions (each has a
	// matching functional GIN index) plus a tags-array overlap fallback.
	const textMatch = or(
		sql`to_tsvector('english', ${scriptRecipes.name}) @@ ${tsquery}`,
		sql`to_tsvector('english', ${scriptRecipes.intentDescription}) @@ ${tsquery}`,
		sql`to_tsvector('english', coalesce(${scriptRecipes.createdFrom}, '')) @@ ${tsquery}`,
		tokens.length > 0 ? sql`${scriptRecipes.tags} && ARRAY[${sql.join(tokens.map(t => sql`${t}`), sql`, `)}]::text[]` : sql`false`,
	);

	const rows = await db
		.select()
		.from(scriptRecipes)
		.where(and(healthyVerified(), projectScope(projectId), textMatch))
		.orderBy(
			desc(sql`ts_rank(${rankVector()}, ${tsquery})`),
			desc(scriptRecipes.successCount),
			desc(scriptRecipes.lastUsed),
		)
		.limit(limit);

	// Safety net — a phrasing mismatch shouldn't hide popular scripts entirely.
	if (rows.length < SAFETY_NET_FLOOR) {
		const seen = new Set(rows.map(r => r.id));
		const popular = await db
			.select()
			.from(scriptRecipes)
			.where(and(healthyVerified(), projectScope(projectId)))
			.orderBy(desc(scriptRecipes.successCount), desc(scriptRecipes.lastUsed))
			.limit(SAFETY_NET_SIZE);
		for (const p of popular) if (!seen.has(p.id)) rows.push(p as ScriptRecipeRow);
	}

	return rows as ScriptRecipeRow[];
}

/** Fetch a single recipe by id (any status — drafts included). */
export async function getScriptRecipe(id: string): Promise<ScriptRecipeRow | null> {
	const rows = await db.select().from(scriptRecipes).where(eq(scriptRecipes.id, id)).limit(1);
	return (rows[0] as ScriptRecipeRow) || null;
}

/**
 * List ALL recipes for a project — any status (drafts included) and any health.
 * Unlike `searchScriptRecipes` (which the matcher uses, filtered to healthy
 * verified rows), this is the admin/curation view, so it must show everything.
 * Ordered most-recently-touched first.
 */
export async function listScriptRecipes(projectId?: string): Promise<ScriptRecipeRow[]> {
	const scope = projectScope(projectId);
	const base = db.select().from(scriptRecipes);
	const rows = scope
		? await base.where(scope).orderBy(desc(scriptRecipes.updatedAt))
		: await base.orderBy(desc(scriptRecipes.updatedAt));
	return rows as ScriptRecipeRow[];
}

/**
 * Reset a recipe's health counters (admin action). After an admin fixes the
 * body of a script that had been disabled by the failure-rate guard, its
 * success/failure history is stale — clearing it (and lastError) lets the
 * matcher consider the script again.
 */
export async function resetScriptRecipeStats(id: string): Promise<void> {
	await db
		.update(scriptRecipes)
		.set({ successCount: 0, failureCount: 0, lastError: null, updatedAt: new Date().toISOString() })
		.where(eq(scriptRecipes.id, id));
}

/** Count healthy verified recipes (what the matcher would consider). */
export async function countScriptRecipes(projectId?: string): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(scriptRecipes)
		.where(and(healthyVerified(), projectScope(projectId)));
	return rows[0]?.n ?? 0;
}

/** Insert or update a recipe row (keyed by id). */
export async function upsertScriptRecipe(row: Partial<ScriptRecipeRow> & { id: string; name: string; intentDescription: string; fileBase: string }): Promise<void> {
	const now = new Date().toISOString();
	const values = { ...row, updatedAt: now };
	await db
		.insert(scriptRecipes)
		.values(values as any)
		.onConflictDoUpdate({
			target: scriptRecipes.id,
			set: {
				name: values.name,
				intentDescription: values.intentDescription,
				projectId: values.projectId ?? null,
				tags: values.tags ?? null,
				createdFrom: values.createdFrom ?? null,
				sourceIds: values.sourceIds ?? null,
				tables: values.tables ?? null,
				parameters: values.parameters ?? null,
				components: values.components ?? null,
				displayPreference: values.displayPreference ?? null,
				fileBase: values.fileBase,
				bodyHash: values.bodyHash ?? null,
				version: values.version ?? 1,
				status: values.status ?? 'verified',
				turnId: values.turnId ?? null,
				parentId: values.parentId ?? null,
				forkDepth: values.forkDepth ?? 0,
				forkReason: values.forkReason ?? null,
				lastError: values.lastError ?? null,
				updatedAt: now,
			},
		});
}

/** Atomically bump success/failure counters and last-used. */
export async function updateScriptRecipeStats(
	id: string,
	patch: { successDelta?: number; failureDelta?: number; lastUsed?: string },
): Promise<void> {
	const set: Record<string, any> = { updatedAt: new Date().toISOString() };
	if (patch.successDelta) set.successCount = sql`${scriptRecipes.successCount} + ${patch.successDelta}`;
	if (patch.failureDelta) set.failureCount = sql`${scriptRecipes.failureCount} + ${patch.failureDelta}`;
	if (patch.lastUsed) set.lastUsed = patch.lastUsed;
	await db.update(scriptRecipes).set(set).where(eq(scriptRecipes.id, id));
}

/** Promote a draft to verified, stamping provenance + optional fork lineage. */
export async function promoteScriptRecipe(
	id: string,
	patch: {
		sourceIds: string[];
		tables: string[];
		fileBase?: string;
		parentId?: string;
		forkDepth?: number;
		forkReason?: string;
		components?: any;
	},
): Promise<ScriptRecipeRow | null> {
	const now = new Date().toISOString();
	const set: Record<string, any> = {
		status: 'verified',
		failureCount: 0,
		successCount: sql`GREATEST(${scriptRecipes.successCount}, 1)`,
		lastError: null,
		turnId: null,
		sourceIds: patch.sourceIds,
		tables: patch.tables,
		lastUsed: now,
		updatedAt: now,
	};
	if (patch.fileBase !== undefined) set.fileBase = patch.fileBase;
	if (patch.parentId !== undefined) set.parentId = patch.parentId;
	if (patch.forkDepth !== undefined) set.forkDepth = patch.forkDepth;
	if (patch.forkReason !== undefined) set.forkReason = patch.forkReason;
	if (patch.components !== undefined) set.components = patch.components;

	const rows = await db.update(scriptRecipes).set(set).where(eq(scriptRecipes.id, id)).returning();
	return (rows[0] as ScriptRecipeRow) || null;
}

/**
 * Commit a user-directed edit onto an EXISTING recipe (version N+1, same id).
 *
 * The id stays stable on purpose: cached conversations, script_dataset
 * regeneration descriptors and persisted component specs all point at it, so
 * the correction applies retroactively instead of stranding them on the old
 * body. See backend/docs/SCRIPT-EDIT-DESIGN.md § Component 5.
 *
 * Health counters reset because the old body's success/failure history says
 * nothing about the new one — and a pre-edit failure streak would otherwise
 * keep the corrected script below the matcher's health filter. Component specs
 * are cleared because they were validated against the OLD column shape.
 */
export async function commitScriptRecipeEdit(
	id: string,
	patch: {
		name?: string;
		intentDescription?: string;
		tags?: string[];
		parameters?: any;
		bodyHash: string;
		fileBase?: string;
		sourceIds?: string[];
		tables?: string[];
		editedBy?: string;
		editedFrom?: string;
		historyEntry: Record<string, any>;
	},
): Promise<ScriptRecipeRow | null> {
	const now = new Date().toISOString();
	const set: Record<string, any> = {
		version: sql`${scriptRecipes.version} + 1`,
		bodyHash: patch.bodyHash,
		status: 'verified',
		turnId: null,
		lastError: null,
		// Stale: describes the superseded body.
		successCount: 0,
		failureCount: 0,
		// Validated against the old shape — force regeneration on the next run.
		// NOTE: `displayPreference` is deliberately NOT touched here. Specs are
		// bindings that go stale when the SQL changes; the user's rendering CHOICE
		// does not. Clearing both is what made a chart type vanish after any data edit.
		components: null,
		// Append, never overwrite: the full edit chain is the rollback trail.
		history: sql`COALESCE(${scriptRecipes.history}, '[]'::jsonb) || ${JSON.stringify([patch.historyEntry])}::jsonb`,
		lastUsed: now,
		updatedAt: now,
	};
	if (patch.fileBase !== undefined) set.fileBase = patch.fileBase;
	if (patch.name !== undefined) set.name = patch.name;
	if (patch.intentDescription !== undefined) set.intentDescription = patch.intentDescription;
	if (patch.tags !== undefined) set.tags = patch.tags;
	if (patch.parameters !== undefined) set.parameters = patch.parameters;
	if (patch.sourceIds !== undefined) set.sourceIds = patch.sourceIds;
	if (patch.tables !== undefined) set.tables = patch.tables;
	if (patch.editedBy !== undefined) set.editedBy = patch.editedBy;
	if (patch.editedFrom !== undefined) set.editedFrom = patch.editedFrom;

	const rows = await db.update(scriptRecipes).set(set).where(eq(scriptRecipes.id, id)).returning();
	return (rows[0] as ScriptRecipeRow) || null;
}

/** Stamp the most recent draft execution error + bump failure count. */
export async function recordScriptDraftError(
	id: string,
	err: { phase: string; message: string; attempt: number; at: string },
): Promise<void> {
	await db
		.update(scriptRecipes)
		.set({
			lastError: err,
			failureCount: sql`${scriptRecipes.failureCount} + 1`,
			updatedAt: new Date().toISOString(),
		})
		.where(and(eq(scriptRecipes.id, id), eq(scriptRecipes.status, 'draft')));
}

/** Delete a recipe row (the on-disk body is removed by the caller). */
export async function deleteScriptRecipe(id: string): Promise<void> {
	await db.delete(scriptRecipes).where(eq(scriptRecipes.id, id));
}

/** True if `fileBase` is already taken by a different recipe in this project. */
export async function fileBaseTaken(fileBase: string, projectId: string | null, excludeId: string): Promise<boolean> {
	const rows = await db
		.select({ id: scriptRecipes.id })
		.from(scriptRecipes)
		.where(and(
			eq(scriptRecipes.fileBase, fileBase),
			projectId ? eq(scriptRecipes.projectId, projectId) : isNull(scriptRecipes.projectId),
		))
		.limit(2);
	return rows.some(r => r.id !== excludeId);
}
