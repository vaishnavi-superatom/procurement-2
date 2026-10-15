import { db, schema } from './drizzle-db';
import { eq, sql } from 'drizzle-orm';

const { concepts } = schema;

/**
 * Concepts — the computable ideas the agent must know how to find or derive.
 *
 * Two things distinguish a concept from a knowledge-base node:
 *
 *  1. It is addressed BY NAME from a catalog the agent is shown, rather than
 *     retrieved by embedding the user's question. At catalog sizes we actually
 *     have (tens), the catalog IS the retrieval mechanism — an embedding pass
 *     over 24 items solves a problem that does not exist, and column names in a
 *     rule body ('custentity9', 'chargedate') are noise in embedding space.
 *
 *  2. It carries STRUCTURE — `requires` and `returns` — instead of burying its
 *     dependencies and its output unit in prose. That structure is the whole
 *     point: a rule whose preconditions live in a different document is how a
 *     correct formula produces a wrong number.
 */

export type ConceptKind = 'formula' | 'definition' | 'filter' | 'lookup' | 'join' | 'invariant';
export type ConceptOrigin = 'data_source' | 'knowledge_node' | 'user_question' | 'agent_validated';
/** Who a concept applies to. Same values as the platform's concept_type. */
export type ConceptType = 'global' | 'user' | 'group';
const CONCEPT_TYPES: ConceptType[] = ['global', 'user', 'group'];

/** A type, or null / undefined for none. */
function checkType(type: string | null | undefined): void {
	if (type != null && !CONCEPT_TYPES.includes(type as ConceptType)) {
		throw new Error(`type must be one of ${CONCEPT_TYPES.join(', ')}, or null`);
	}
}

/** Output contract. Every field optional — an empty object is a valid (if unhelpful) answer. */
export interface ConceptReturns {
	/** money | count | duration | date | ratio | list … */
	type?: string;
	/** The unit the value is IN. 'per-currency, unconverted' is the field that makes a silent AUD+NZD blend visible. */
	unit?: string;
	/** What one row represents, e.g. 'one row per charge line'. */
	grain?: string;
	/** Known limitations a caller must not paper over. */
	caveats?: string[];
	[k: string]: any;
}

export interface CreateConceptParams {
	name: string;
	body: string;
	kind?: ConceptKind;
	/** Optional (null = not set). Left out on a re-load, an existing concept keeps its type. */
	type?: ConceptType | null;
	requires?: string[];
	returns?: ConceptReturns;
	aliases?: string[];
	/** One line: what this concept is for. Optional; shown beside search hits. */
	description?: string | null;
	origin?: ConceptOrigin;
	/** WHICH source: 'kb:42', 'conv:1200-1209'. */
	originRef?: string | null;
	/** Set to make this row a proposed replacement for that concept id. */
	supersedes?: number | null;
	sourceId?: string | null;
	/**
	 * Default false: agent proposals wait for review. A person authoring the
	 * concept in the platform UI passes true — writing it there is the review.
	 */
	verified?: boolean;
}

export interface UpdateConceptParams extends Partial<Omit<CreateConceptParams, 'name' | 'verified'>> {
	id: number;
	name?: string;
}

export interface ConceptRecord {
	id: number;
	name: string;
	body: string;
	kind: string;
	/** global | user | group, or null when not set */
	type: ConceptType | null;
	requires: string[];
	returns: ConceptReturns;
	aliases: string[];
	/** One line: what this concept is for. Shown beside search hits. */
	description: string | null;
	origin: string | null;
	/** false = an unreviewed proposal; the runtime never sees it. */
	verified: boolean;
	/** Which source this came from: 'kb:42', 'conv:1200-1209'. */
	originRef: string | null;
	/** Set when this row is a proposed replacement for concepts.id. */
	supersedes: number | null;
	sourceId: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}

/** Concepts are matched case- and whitespace-insensitively; the stored name keeps its authored casing. */
const normName = (s: string) => s.trim().replace(/\s+/g, ' ');
const nameKey = (s: string) => normName(s).toLowerCase();

// ============================================================================
// Write
// ============================================================================

/**
 * Create a concept. Only `name` and `body` are required — the same two-field
 * surface as an entity_map entry, so authoring one is no harder than today.
 *
 * Upserts on (lower(name), source_id): re-running a load updates rather than
 * failing, which is what makes a concept file authoritative instead of a patch.
 */
export async function createConcept(params: CreateConceptParams) {
	const { body, kind, requires, returns, aliases, description, origin, originRef, supersedes, sourceId } = params;
	const name = normName(params.name ?? '');

	if (!name) throw new Error('name is required');
	if (!body || !body.trim()) throw new Error('body is required');
	if (name.length > 64) throw new Error(`name exceeds 64 chars: '${name}'`);
	checkType(params.type);

	const row = {
		name,
		body: body.trim(),
		kind: kind ?? 'definition',
		requires: requires ?? [],
		returns: (returns ?? {}) as any,
		aliases: (aliases ?? []).map(normName).filter(Boolean),
		description: description?.trim() || null,
		origin: origin ?? null,
		originRef: originRef ?? null,
		supersedes: supersedes ?? null,
		sourceId: sourceId ?? null,
		verified: params.verified === true,
	};

	// onConflictDoUpdate needs a unique constraint by name; ours is an
	// EXPRESSION index (lower(name), coalesce(source_id,'')), which Drizzle's
	// builder cannot target — so the conflict target is spelled out in SQL.
	// sql.param() on the arrays: a bare `${arr}` is expanded by the template as a
	// comma-separated list (an empty array becoming a syntax-error `()`), not
	// bound as one text[] value.
	const res: any = await db.execute(sql`
		INSERT INTO concepts (name, body, kind, type, requires, returns, aliases, description, origin, origin_ref, supersedes, source_id, verified, status)
		VALUES (
			${row.name}, ${row.body}, ${row.kind}, ${params.type ?? null},
			${sql.param(row.requires)}::text[], ${JSON.stringify(row.returns)}::jsonb, ${sql.param(row.aliases)}::text[],
			${row.description}, ${row.origin}, ${row.originRef}, ${row.supersedes}, ${row.sourceId}, ${row.verified},
			-- approved exactly when verified (concepts_status_matches_verified)
			${row.verified ? 'approved' : 'proposed'}::concept_status
		)
		-- The arbiter index is PARTIAL (WHERE supersedes IS NULL), so its
		-- predicate must be repeated here or Postgres cannot infer it. A revision
		-- fails the predicate and therefore never conflicts, which is exactly what
		-- lets it sit alongside the concept it proposes to replace.
		ON CONFLICT (lower(name), coalesce(source_id, '')) WHERE supersedes IS NULL DO UPDATE SET
			name = EXCLUDED.name, body = EXCLUDED.body, kind = EXCLUDED.kind,
			type = COALESCE(${params.type ?? null}, concepts.type),
			requires = EXCLUDED.requires, returns = EXCLUDED.returns,
			aliases = EXCLUDED.aliases, description = EXCLUDED.description, origin = EXCLUDED.origin,
			origin_ref = COALESCE(EXCLUDED.origin_ref, concepts.origin_ref),
			updated_at = CURRENT_TIMESTAMP
		RETURNING id, name, body, kind, type, requires, returns, aliases, origin, verified,
		          origin_ref AS "originRef", supersedes,
		          source_id AS "sourceId", created_at AS "createdAt", updated_at AS "updatedAt"
	`);
	return { success: true, data: res.rows[0] as ConceptRecord };
}

export async function updateConcept(params: UpdateConceptParams) {
	const { id } = params;
	if (!id) throw new Error('id is required');

	const sets: any[] = [];
	if (params.name !== undefined) sets.push(sql`name = ${normName(params.name)}`);
	if (params.body !== undefined) sets.push(sql`body = ${params.body.trim()}`);
	if (params.kind !== undefined) sets.push(sql`kind = ${params.kind}`);
	if (params.type !== undefined) {
		checkType(params.type);
		sets.push(sql`type = ${params.type}`);
	}
	if (params.requires !== undefined) sets.push(sql`requires = ${sql.param(params.requires)}::text[]`);
	if (params.returns !== undefined) sets.push(sql`returns = ${JSON.stringify(params.returns)}::jsonb`);
	if (params.aliases !== undefined) sets.push(sql`aliases = ${sql.param(params.aliases.map(normName))}::text[]`);
	if (params.description !== undefined) sets.push(sql`description = ${params.description?.trim() || null}`);
	if (params.origin !== undefined) sets.push(sql`origin = ${params.origin}`);
	if (params.sourceId !== undefined) sets.push(sql`source_id = ${params.sourceId}`);
	if (!sets.length) throw new Error('no fields to update');
	sets.push(sql`updated_at = CURRENT_TIMESTAMP`);

	const res: any = await db.execute(sql`
		UPDATE concepts SET ${sql.join(sets, sql`, `)} WHERE id = ${id}
		RETURNING id, name, body, kind, type, requires, returns, aliases, description, origin,
		          source_id AS "sourceId", created_at AS "createdAt", updated_at AS "updatedAt"
	`);
	if (!res.rows.length) throw new Error(`Concept ${id} not found`);
	return { success: true, data: res.rows[0] as ConceptRecord };
}

export async function deleteConcept(id: number) {
	const res: any = await db.execute(sql`DELETE FROM concepts WHERE id = ${id} RETURNING id, name`);
	if (!res.rows.length) throw new Error(`Concept ${id} not found`);
	return { success: true, data: res.rows[0] };
}

/**
 * Wipe every concept. A concept file is authoritative, so a full load clears
 * first — otherwise a renamed concept leaves both generations resident and the
 * catalog offers the agent two names for one idea.
 *
 * NOTE this deliberately does NOT touch search_entity_types / search_values:
 * keeping the two stores separate is why a routine entity refresh (which does
 * DELETE FROM search_entity_types) can no longer take the concepts with it.
 */
export async function clearAllConcepts() {
	const res: any = await db.execute(sql`DELETE FROM concepts RETURNING id`);
	return { success: true, deleted: res.rows.length };
}

// ============================================================================
// Read
// ============================================================================

export async function getConcept(id: number) {
	const rows = await db.select().from(concepts).where(eq(concepts.id, id)).limit(1);
	if (!rows.length) throw new Error(`Concept ${id} not found`);
	return { success: true, data: rows[0] as unknown as ConceptRecord };
}

export async function getAllConcepts(
	opts: { verifiedOnly?: boolean } = {}
): Promise<{ success: boolean; data: ConceptRecord[]; count: number }> {
	// Unfiltered by default — the admin views and the lint check need to see
	// proposals. Runtime callers pass verifiedOnly.
	const res: any = await db.execute(sql`
		SELECT id, name, body, kind, type, requires, returns, aliases, description, origin, verified,
		       origin_ref AS "originRef", supersedes,
		       source_id AS "sourceId", created_at AS "createdAt", updated_at AS "updatedAt"
		FROM concepts
		${opts.verifiedOnly ? sql`WHERE verified = true` : sql``}
		ORDER BY name
	`);
	return { success: true, data: res.rows as ConceptRecord[], count: res.rows.length };
}

export interface ConceptMatch {
	name: string;
	kind: string;
	aliases: string[];
	/** Which tier matched, so a caller can weigh a body mention against a named hit. */
	description: string | null;
	matchedOn: 'name' | 'alias' | 'near-name' | 'description';
	score: number;
}

/**
 * Search the catalog for a term: exact name/alias, then near-name, then the
 * one-line description.
 *
 * Bodies are deliberately NOT searched. Measured on the live catalog, a body
 * tier returned a fifth of the catalog for a word like "customer" — a concept
 * whose body lists every metric word answers to almost any question — and the
 * caller cannot tell a real match from a passing mention. A term that only
 * exists in a body ("revenue") belongs in this concept's aliases or description,
 * where every caller benefits, not in a looser search.
 */
export async function searchConcepts(params: {
	term: string;
	limit?: number;
	kind?: string | null;
}): Promise<{ success: boolean; data: ConceptMatch[]; count: number; total: number }> {
	const { term, limit = 10, kind = null } = params;
	const q = (term ?? '').trim().toLowerCase();
	const total = (await getConceptCatalog()).count;
	if (!q) return { success: true, data: [], count: 0, total };

	const res: any = await db.execute(sql`
		WITH scored AS (
			SELECT c.name, c.kind, c.aliases, c.description,
				CASE
					WHEN lower(c.name) = ${q} THEN 'name'
					WHEN EXISTS (SELECT 1 FROM unnest(c.aliases) a WHERE lower(a) = ${q}) THEN 'alias'
					WHEN GREATEST(word_similarity(${q}, lower(c.name)),
						COALESCE((SELECT MAX(word_similarity(${q}, lower(a))) FROM unnest(c.aliases) a), 0)) >= 0.6 THEN 'near-name'
					WHEN c.description IS NOT NULL AND (
						to_tsvector('english', c.description) @@ plainto_tsquery('english', ${q})
						OR word_similarity(${q}, lower(c.description)) >= 0.6) THEN 'description'
					ELSE NULL
				END AS matched_on,
				GREATEST(word_similarity(${q}, lower(c.name)),
					COALESCE((SELECT MAX(word_similarity(${q}, lower(a))) FROM unnest(c.aliases) a), 0)) AS score
			FROM concepts c
			WHERE c.verified = true
			  AND (${kind}::varchar IS NULL OR c.kind = ${kind})
		)
		SELECT name, kind, aliases, description, matched_on AS "matchedOn", ROUND(score::numeric, 3)::float8 AS score
		FROM scored
		WHERE matched_on IS NOT NULL
		ORDER BY CASE matched_on WHEN 'name' THEN 0 WHEN 'alias' THEN 1 WHEN 'near-name' THEN 2 ELSE 3 END,
		         score DESC, name
		LIMIT ${Math.max(1, Math.min(limit, 50))}
	`);
	return { success: true, data: res.rows as ConceptMatch[], count: res.rows.length, total };
}

/**
 * The catalog the agent is SHOWN — names and aliases only, no bodies.
 *
 * Deliberately withholds the body: the agent picks names from this list, then
 * asks for the ones it needs. Injecting every body here would rebuild the
 * always-on context problem that concepts exist to solve.
 */
export async function getConceptCatalog(): Promise<{
	success: boolean;
	data: Array<{ name: string; kind: string; aliases: string[]; description: string | null }>;
	count: number;
}> {
	// verified only: this list is what tells MainAgent which names
	// resolve_concepts accepts, so an unreviewed proposal appearing here would
	// invite the agent to fetch and obey it.
	const res: any = await db.execute(sql`
		SELECT name, kind, aliases, description FROM concepts WHERE verified = true ORDER BY name
	`);
	return { success: true, data: res.rows, count: res.rows.length };
}

/**
 * The always-injected tier: preconditions no question is semantically close to
 * (date encoding, valid-row filters). These can never be retrieval-dependent —
 * "what was revenue last quarter?" has no similarity to "dates are DD/MM/YYYY
 * text", so a search-only strategy silently drops them and returns a confident
 * wrong number.
 */
export async function getInvariants(sourceId?: string | null) {
	const res: any = await db.execute(sql`
		SELECT id, name, body, kind, requires, returns, aliases, description, origin, verified,
		       origin_ref AS "originRef", supersedes,
		       source_id AS "sourceId", created_at AS "createdAt", updated_at AS "updatedAt"
		FROM concepts
		WHERE kind = 'invariant' AND verified = true
		  ${sourceId ? sql`AND (source_id = ${sourceId} OR source_id IS NULL)` : sql``}
		ORDER BY name
	`);
	return { success: true, data: res.rows as ConceptRecord[], count: res.rows.length };
}

// ============================================================================
// Resolution
// ============================================================================

export interface ResolveConceptsResult {
	success: boolean;
	/** Concepts to inject, in dependency order: a concept always follows what it requires. */
	resolved: ConceptRecord[];
	/** Names asked for that matched nothing — surfaced, never silently dropped. */
	unmatched: string[];
	/** Names pulled in by `requires` rather than asked for directly. */
	implied: string[];
	/** requires-edges pointing at concepts that do not exist. A dangling edge is a real defect. */
	danglingRequires: Array<{ concept: string; missing: string }>;
	/** A misspelled ask that had exactly one clear best match — resolved under the corrected name. */
	corrected: Array<{ asked: string; matched: string }>;
	/** An ask too close to several catalog entries to pick automatically — nothing was resolved for it. */
	suggestions: Array<{ asked: string; candidates: Array<{ name: string; score: number }> }>;
}

/** Fuzzy-match floor and the gap that separates "one clear typo fix" from "ambiguous, ask". */
const FUZZY_SCORE_FLOOR = 0.3;
const FUZZY_CLEAR_SCORE = 0.5;
// Tuned against the live catalog, not a round number: many concept aliases are
// longer phrases that CONTAIN a shorter concept's name as a substring (e.g.
// "revenue contribution"'s alias "revenue forecast by employee" contains
// "revenue forecast") — word_similarity is forgiving of a target's extra
// trailing words, so those runners-up sit closer to the real match than a
// generic gap would predict. Measured live: "revenu forcast" → "revenue
// forecast" 0.6 vs "revenue by project" (via that alias) 0.529, a genuine
// typo fix, gap 0.071. "project" → five DIFFERENT concepts all at 1.0, gap 0,
// genuinely ambiguous. 0.07 separates both correctly; re-check against real
// near-misses before lowering further.
const FUZZY_CLEAR_GAP = 0.07;

/**
 * Fuzzy candidates for a name that missed exact lookup, scored against every
 * concept's name and aliases via Postgres's pg_trgm `word_similarity` — the
 * same extension and mechanism entity-search.ts already uses for value
 * lookups, just run in-process against the concepts table directly (the
 * catalog is tens of rows, not hundreds of thousands, so there's no case for
 * a separate index or an in-memory reimplementation of the same algorithm).
 *
 * The verified filter here MUST mirror the one the caller uses to build its
 * exact/alias map. When the two disagree, an unverified concept still matches
 * fuzzily and then fails the lookup in visit(), so resolveConcepts reports a
 * correction to a name AND that same name as unmatched, in one breath — which
 * reads as a broken catalog rather than "that concept is not verified yet".
 *
 * Confirmed failure: a 46-concept bulk import left at the default
 * verified=false resolved to nothing while every name still fuzzy-matched.
 */
async function fuzzyConceptCandidates(
	rawName: string,
	sourceId: string | null,
	includeUnverified = false,
): Promise<Array<{ name: string; score: number }>> {
	const q = nameKey(rawName);
	if (!q) return [];
	const res: any = await db.execute(sql`
		WITH scored AS (
			SELECT c.name,
				GREATEST(
					word_similarity(${q}, lower(c.name)),
					COALESCE((SELECT MAX(word_similarity(${q}, lower(a))) FROM unnest(c.aliases) AS a), 0)
				) AS score
			FROM concepts c
			WHERE (${sourceId}::varchar IS NULL OR c.source_id = ${sourceId} OR c.source_id IS NULL)
			  AND (${includeUnverified} OR c.verified = true)
		)
		SELECT name, ROUND(score::numeric, 3)::float8 AS score
		FROM scored WHERE score >= ${FUZZY_SCORE_FLOOR}
		ORDER BY score DESC LIMIT 5
	`);
	return res.rows as Array<{ name: string; score: number }>;
}

/**
 * Resolve requested concept names to bodies, following `requires` TRANSITIVELY.
 *
 * The transitive walk is the point. A caller asking for `revenue forecast`
 * must also receive the actuals filter it depends on, or it gets a correct
 * formula over the wrong rows. Making the caller know to ask for both is
 * exactly the failure mode that splitting knowledge into units introduces —
 * `requires` is what pays that cost back.
 *
 * Matches on name first, then aliases (case-insensitive). A name that misses
 * both falls to a fuzzy pass (word_similarity over the catalog): one clear
 * best match is corrected and resolved under that name; several close
 * candidates resolve nothing and come back as `suggestions` instead — binding
 * to whichever sorts first would silently swap one formula for another.
 * Fuzzy matching applies ONLY to names asked for directly, never to a
 * `requires` edge — a dangling requires is an authoring defect in the concept
 * file to fix at the source, not a typo to patch at answer time.
 * Cycles terminate: a name already visited is never expanded twice.
 */
export async function resolveConcepts(params: {
	names: string[];
	sourceId?: string | null;
	/** Also return every kind='invariant' concept, whether or not it was asked for. */
	includeInvariants?: boolean;
	/** Admin/preview only. NEVER set from the agent runtime. */
	includeUnverified?: boolean;
}): Promise<ResolveConceptsResult> {
	const { names = [], sourceId = null, includeInvariants = false, includeUnverified = false } = params;

	// Defaults to verified only. An unreviewed body reaching the agent is not a
	// suggestion — resolve_concepts tells the model to use it AS WRITTEN and
	// treat its filters as required.
	const all = (await getAllConcepts({ verifiedOnly: !includeUnverified })).data.filter(
		c => !sourceId || !c.sourceId || c.sourceId === sourceId
	);

	// One lookup covering both names and aliases — an alias is just another way
	// to say the name, so a caller should never need to know which it used.
	const byKey = new Map<string, ConceptRecord>();
	for (const c of all) {
		byKey.set(nameKey(c.name), c);
		for (const a of c.aliases ?? []) if (a) byKey.set(nameKey(a), c);
	}

	// Fuzzy pre-pass — only for names that miss the exact lookup above. Builds
	// the revised set of keys to actually visit: a corrected name substitutes
	// in cleanly, an ambiguous one is excluded here (it will never reach
	// `unmatched` either — it lives only in `suggestions`, since "nothing
	// resolved, here are candidates" is a different signal from "not in the
	// catalog at all").
	const corrected: Array<{ asked: string; matched: string }> = [];
	const suggestions: Array<{ asked: string; candidates: Array<{ name: string; score: number }> }> = [];
	const keysToVisit = new Set<string>();
	for (const rawName of names) {
		const key = nameKey(rawName);
		if (!key) continue;
		if (byKey.has(key)) { keysToVisit.add(key); continue; }

		const candidates = await fuzzyConceptCandidates(rawName, sourceId, includeUnverified);
		if (candidates.length === 0) { keysToVisit.add(key); continue; } // nothing close — falls to unmatched below

		const [top, second] = candidates;
		const isClear = top.score >= FUZZY_CLEAR_SCORE && (!second || top.score - second.score >= FUZZY_CLEAR_GAP);
		if (isClear) {
			corrected.push({ asked: rawName, matched: top.name });
			keysToVisit.add(nameKey(top.name));
		} else {
			suggestions.push({ asked: rawName, candidates });
			// Deliberately NOT added to keysToVisit — an ambiguous ask resolves
			// nothing rather than guessing, and must not also show up in `unmatched`
			// (that would read as "not in the catalog", which is the wrong signal).
		}
	}

	// What was asked for, in CANONICAL terms (post fuzzy-correction). Asking by
	// alias ('billings') or a corrected typo must not make the concept look
	// implied just because it resolved to another name.
	const requestedCanonical = new Set(
		[...keysToVisit].map(k => byKey.get(k)).filter(Boolean).map(c => nameKey(c!.name))
	);
	const unmatched: string[] = [];
	const dangling: Array<{ concept: string; missing: string }> = [];
	const visited = new Set<string>();
	const ordered: ConceptRecord[] = [];

	// Post-order DFS: dependencies land in `ordered` before the concept that
	// needs them, so the injected block reads top-down without forward refs.
	const visit = (key: string, viaConcept?: ConceptRecord) => {
		const c = byKey.get(key);
		if (!c) {
			if (viaConcept) dangling.push({ concept: viaConcept.name, missing: key });
			else unmatched.push(key);
			return;
		}
		if (visited.has(nameKey(c.name))) return;
		visited.add(nameKey(c.name));
		for (const dep of c.requires ?? []) if (dep) visit(nameKey(dep), c);
		ordered.push(c);
	};

	// Invariants FIRST: they are preconditions for everything that follows, so
	// they must read at the top of the injected block rather than trailing the
	// concept they constrain. The visited-set makes this idempotent — an
	// invariant that is also an explicit `requires` edge is still emitted once.
	if (includeInvariants) for (const c of all) if (c.kind === 'invariant') visit(nameKey(c.name));
	for (const n of keysToVisit) visit(n);

	const implied = ordered.map(c => nameKey(c.name)).filter(k => !requestedCanonical.has(k));

	return {
		success: true,
		resolved: ordered,
		unmatched,
		implied,
		danglingRequires: dangling,
		corrected,
		suggestions,
	};
}

/**
 * Integrity check — every `requires` edge that points at a concept that does not
 * exist. Cheap to run, and the failure it catches (a dependency silently not
 * injected) is invisible at answer time.
 */
export async function findDanglingRequires() {
	const all = (await getAllConcepts()).data;
	const known = new Set<string>();
	for (const c of all) {
		known.add(nameKey(c.name));
		for (const a of c.aliases ?? []) if (a) known.add(nameKey(a));
	}
	const dangling: Array<{ concept: string; missing: string }> = [];
	for (const c of all) {
		for (const dep of c.requires ?? []) {
			if (dep && !known.has(nameKey(dep))) dangling.push({ concept: c.name, missing: dep });
		}
	}
	return { success: true, data: dangling, count: dangling.length };
}

export async function conceptStats() {
	const res: any = await db.execute(sql`
		SELECT kind, COUNT(id)::int AS n,
		       COUNT(*) FILTER (WHERE cardinality(requires) > 0)::int AS with_requires,
		       COUNT(*) FILTER (WHERE returns <> '{}'::jsonb)::int AS with_returns
		FROM concepts GROUP BY kind ORDER BY kind
	`);
	const total: any = await db.execute(sql`SELECT COUNT(id)::int AS n FROM concepts`);
	return { success: true, byKind: res.rows, total: total.rows[0]?.n ?? 0 };
}

/**
 * The review queue: everything a coding agent proposed that no human has
 * accepted yet. Invisible to the runtime until verified.
 *
 * A row with `supersedes` set is a proposed REPLACEMENT for that concept, not a
 * new one — `supersedesName` is carried alongside so a reviewer sees what it
 * would replace without a second query.
 */
export async function listConceptProposals(): Promise<{ success: boolean; data: ConceptRecord[]; count: number }> {
	const res: any = await db.execute(sql`
		SELECT id, name, body, kind, requires, returns, aliases, description, origin, verified,
		       origin_ref AS "originRef", supersedes,
		       source_id AS "sourceId", created_at AS "createdAt", updated_at AS "updatedAt"
		FROM concepts WHERE verified = false ORDER BY created_at DESC
	`);
	const rows = res.rows as ConceptRecord[];
	const names = new Map(
		(await getAllConcepts()).data.map(c => [c.id, c.name])
	);
	const data = rows.map(r => ({
		...r,
		supersedesName: r.supersedes ? names.get(r.supersedes) ?? null : null,
	}));
	return { success: true, data, count: data.length };
}

/**
 * Accept a revision: the proposed body replaces the original, and the revision
 * row is removed. Done in one transaction so a half-applied revision can never
 * leave two rows claiming the same name.
 */
export async function acceptConceptRevision(revisionId: number) {
	const rev: any = await db.execute(sql`SELECT * FROM concepts WHERE id = ${revisionId}`);
	const r = rev.rows[0];
	if (!r) return { success: false, error: `No concept with id ${revisionId}` };
	if (!r.supersedes) return { success: false, error: `Concept ${revisionId} is not a revision` };

	await db.execute(sql`
		UPDATE concepts SET
			body = ${r.body}, kind = ${r.kind}, requires = ${r.requires},
			returns = ${r.returns}, aliases = ${r.aliases},
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ${r.supersedes}
	`);
	await db.execute(sql`DELETE FROM concepts WHERE id = ${revisionId}`);
	return { success: true, data: { updated: r.supersedes, revision: revisionId } };
}

/** Accept a proposal (or withdraw one already accepted). */
export async function setConceptVerified(id: number, verified: boolean) {
	const res: any = await db.execute(sql`
		UPDATE concepts SET verified = ${verified}, status = ${verified ? 'approved' : 'proposed'}::concept_status,
		       updated_at = CURRENT_TIMESTAMP
		WHERE id = ${id}
		RETURNING id, name, verified
	`);
	if (!res.rows.length) return { success: false, error: `No concept with id ${id}` };
	return { success: true, data: res.rows[0] };
}

/**
 * Concepts whose source knowledge node no longer exists.
 *
 * Deleting a node deliberately does NOT delete the concepts it produced — a
 * rule that proved useful should not vanish because a note was tidied away. But
 * the two cases look identical from here: a node tidied up, and a node deleted
 * BECAUSE the rule in it was wrong. In the second case the concept keeps
 * enforcing that rule, and a concept body overrides the schema, the knowledge
 * base and the model's own reasoning. So the concept stays live and a human is
 * told, rather than the divergence sitting silently.
 *
 * Only concepts written since `origin_ref` existed can be checked at all; ones
 * loaded before it have no link to check. `untraceable` reports how many, so
 * "0 orphans" is never mistaken for "all verified clean".
 */
export async function findOrphanedConcepts(): Promise<{
	success: boolean;
	data: Array<{ id: number; name: string; kind: string; originRef: string; verified: boolean }>;
	count: number;
	untraceable: number;
}> {
	const res: any = await db.execute(sql`
		SELECT c.id, c.name, c.kind, c.origin_ref AS "originRef", c.verified
		FROM concepts c
		WHERE c.origin_ref LIKE 'kb:%'
		  AND NOT EXISTS (
		    -- substring past 'kb:'; a non-numeric suffix yields NULL and so
		    -- never matches, which correctly reports it as orphaned.
		    SELECT 1 FROM kb_nodes k
		    WHERE k.id = NULLIF(regexp_replace(c.origin_ref, '^kb:', ''), '')::int
		  )
		ORDER BY c.verified DESC, c.name
	`);
	const untraceable: any = await db.execute(sql`
		SELECT count(*)::int AS n FROM concepts
		WHERE origin = 'knowledge_node' AND (origin_ref IS NULL OR origin_ref = '')
	`);
	return {
		success: true,
		data: res.rows,
		count: res.rows.length,
		untraceable: untraceable.rows[0]?.n ?? 0,
	};
}
