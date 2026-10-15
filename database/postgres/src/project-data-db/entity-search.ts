/**
 * Entity Search — value index + entity map.
 *
 * Resolves free-form mentions in a user question ("FDC") to exact business ids
 * BEFORE the agent plans a query, and records how to reach a user-facing
 * concept ("customer", "lane") in the underlying source.
 *
 * Design: backend/docs/ENTITY-SEARCH-DESIGN.md
 *
 * Scope rule (§2.1): the value index holds BOUNDED master data only — names and
 * codes. Unbounded transaction identifiers (invoice no, GCN no, e-way bill) are
 * deliberately NOT indexed; they are reached through the entity map's
 * `resolution.matchPattern` instead.
 */

import { db } from './drizzle-db';
import { sql } from 'drizzle-orm';

export type ValueKind = 'name' | 'code' | 'alias';

export interface EntityTypeRecord {
	entityType: string;
	resolution: Record<string, any>;
	createdAt?: string;
	updatedAt?: string;
}

export interface IndexValueInput {
	instanceId: string | number;
	value: string;
	valueKind?: ValueKind;
	attrs?: Record<string, any>;
}

export interface ResolveHit {
	entityType: string;
	instanceId: string;
	value: string;        // the value that actually matched
	displayName: string;  // the instance's `name` value, even if a code matched
	valueKind: ValueKind;
	attrs: Record<string, any>;
	score: number;
	matchType: string;
}

export interface ResolveResult {
	query: string;
	resolved: boolean;
	ambiguous: boolean;
	hits: ResolveHit[];
}

/** Mirrors the SQL generated columns — keep the two in step. */
export function normalizeValue(v: string): { norm: string; squashed: string } {
	const lower = (v || '').toLowerCase();
	return {
		norm: lower.replace(/[^a-z0-9]+/g, ' ').trim(),
		squashed: lower.replace(/[^a-z0-9]+/g, ''),
	};
}

// ============================================================================
// Entity map
// ============================================================================

export async function upsertEntityType(params: {
	entityType: string;
	resolution: Record<string, any>;
}) {
	const { entityType, resolution } = params;
	if (!entityType?.trim()) throw new Error('entityType is required');
	if (!resolution || typeof resolution !== 'object') {
		throw new Error('resolution must be an object');
	}

	const res: any = await db.execute(sql`
		INSERT INTO search_entity_types (entity_type, resolution)
		VALUES (${entityType}, ${JSON.stringify(resolution)}::jsonb)
		ON CONFLICT (entity_type) DO UPDATE
			SET resolution = EXCLUDED.resolution,
			    updated_at = CURRENT_TIMESTAMP
		RETURNING entity_type AS "entityType", resolution,
		          created_at AS "createdAt", updated_at AS "updatedAt"
	`);

	return { success: true, data: res.rows[0] as EntityTypeRecord };
}

export async function getEntityTypes(): Promise<{ success: boolean; data: EntityTypeRecord[]; count: number }> {
	const res: any = await db.execute(sql`
		SELECT t.entity_type AS "entityType", t.resolution,
		       t.created_at AS "createdAt", t.updated_at AS "updatedAt",
		       COUNT(v.id)::int AS "valueCount"
		FROM search_entity_types t
		LEFT JOIN search_values v ON v.entity_type = t.entity_type
		GROUP BY t.entity_type, t.resolution, t.created_at, t.updated_at
		ORDER BY t.entity_type
	`);
	return { success: true, data: res.rows, count: res.rows.length };
}

export async function getEntityType(entityType: string) {
	const res: any = await db.execute(sql`
		SELECT entity_type AS "entityType", resolution,
		       created_at AS "createdAt", updated_at AS "updatedAt"
		FROM search_entity_types WHERE entity_type = ${entityType}
	`);
	if (!res.rows.length) throw new Error(`Entity type '${entityType}' not found`);
	return { success: true, data: res.rows[0] as EntityTypeRecord };
}

/**
 * Vocabulary for the system prompt: entity type NAMES only.
 *
 * Its only job is to let the LLM name a concept instead of guessing at our
 * wording — it can infer a question is about unpaid money, but not that we call
 * that `outstanding-balance`. The `resolution` text is deliberately excluded:
 * the agent fetches it via resolve_entities once it has named the concept, so
 * carrying it here too would duplicate it in every prompt for no gain.
 *
 * Same split the schema tiers already use: catalog in the prompt, detail on
 * demand. Static across turns, so it sits inside the cached prompt prefix.
 */
export async function getEntityCatalog(): Promise<{ success: boolean; data: Array<{ entityType: string }>; count: number }> {
	const res: any = await db.execute(sql`
		SELECT entity_type AS "entityType"
		FROM search_entity_types
		ORDER BY entity_type
	`);
	return { success: true, data: res.rows, count: res.rows.length };
}

/**
 * Look up entity map entries by concept name, fuzzily.
 *
 * The LLM picks from the catalog but may paraphrase ("outstanding balance" vs
 * `outstanding-balance`), so an exact key lookup would fail on a near-miss.
 * Matches against the type name, its gloss, and any `resolution.synonyms[]`.
 *
 * A name that matches nothing well returns `matched: null` WITH the closest
 * candidates, so the caller can say "did you mean…" instead of going silent —
 * a miss must stay visible.
 */
export async function resolveEntityTypes(params: {
	names: string[];
	minScore?: number;
	candidateLimit?: number;
}): Promise<{
	success: boolean;
	results: Array<{
		requested: string;
		matched: string | null;
		resolution: Record<string, any> | null;
		score: number;
		candidates: Array<{ entityType: string; score: number }>;
	}>;
	unmatched: string[];
}> {
	const { names, minScore = 0.5, candidateLimit = 3 } = params;
	if (!Array.isArray(names) || names.length === 0) {
		return { success: true, results: [], unmatched: [] };
	}

	const results = await Promise.all(names.map(async (name) => {
		const res: any = await db.execute(sql`
			WITH q AS (
				SELECT btrim(regexp_replace(lower(${name}), '[^a-z0-9]+', ' ', 'g')) AS q_norm,
				       regexp_replace(lower(${name}), '[^a-z0-9]+', '', 'g')        AS q_squashed
			),
			-- Every string that may stand for this concept: its key, its gloss,
			-- and its authored synonyms.
			terms AS (
				SELECT t.entity_type, t.resolution, term.v AS term
				FROM search_entity_types t
				CROSS JOIN LATERAL (
					SELECT t.entity_type AS v
					UNION ALL SELECT COALESCE(t.resolution->>'gloss', '')
					UNION ALL SELECT jsonb_array_elements_text(
						CASE WHEN jsonb_typeof(t.resolution->'synonyms') = 'array'
						     THEN t.resolution->'synonyms' ELSE '[]'::jsonb END)
				) term(v)
				WHERE COALESCE(term.v, '') <> ''
			),
			scored AS (
				SELECT te.entity_type, te.resolution,
					MAX(CASE
						WHEN btrim(regexp_replace(lower(te.term), '[^a-z0-9]+', ' ', 'g')) = q.q_norm     THEN 1.00
						WHEN regexp_replace(lower(te.term), '[^a-z0-9]+', '', 'g') = q.q_squashed         THEN 0.95
						WHEN btrim(regexp_replace(lower(te.term), '[^a-z0-9]+', ' ', 'g')) LIKE q.q_norm || '%' THEN 0.85
						-- REVERSE containment: the stored synonym appears inside the
						-- user's phrase ("pending payment" within "pending payments",
						-- "money owed" within "money owed to us"). Without this a
						-- longer user phrase never matches a shorter synonym. Guarded
						-- at 4 chars so a tiny term can't match every question.
						WHEN length(regexp_replace(lower(te.term), '[^a-z0-9]+', '', 'g')) >= 4
						     AND q.q_squashed LIKE '%' || regexp_replace(lower(te.term), '[^a-z0-9]+', '', 'g') || '%' THEN 0.75
						WHEN regexp_replace(lower(te.term), '[^a-z0-9]+', '', 'g') LIKE '%' || q.q_squashed || '%' THEN 0.70
						ELSE similarity(regexp_replace(lower(te.term), '[^a-z0-9]+', '', 'g'), q.q_squashed) * 0.6
					END) AS score
				FROM terms te, q
				WHERE q.q_squashed <> ''
				GROUP BY te.entity_type, te.resolution
			)
			SELECT entity_type AS "entityType", resolution,
			       ROUND(score::numeric, 3)::float8 AS score
			FROM scored
			WHERE score > 0
			ORDER BY score DESC, entity_type
			LIMIT ${candidateLimit}
		`);

		const rows = res.rows as Array<{ entityType: string; resolution: any; score: number }>;
		const best = rows[0];
		const hit = best && best.score >= minScore ? best : null;

		if (hit) {
			console.log(`[ENTITY-SEARCH] resolveEntityTypes("${name}") MATCHED "${hit.entityType}" score=${hit.score}`);
		} else {
			const cand = rows.map(r => `${r.entityType}(${r.score})`).join(', ') || 'none';
			console.log(`[ENTITY-SEARCH] resolveEntityTypes("${name}") UNMATCHED — candidates: ${cand}`);
		}

		return {
			requested: name,
			matched: hit ? hit.entityType : null,
			resolution: hit ? hit.resolution : null,
			score: best ? best.score : 0,
			// Always returned, so a miss surfaces as "did you mean" rather than silence.
			candidates: rows.map(r => ({ entityType: r.entityType, score: r.score })),
		};
	}));

	return {
		success: true,
		results,
		unmatched: results.filter(r => !r.matched).map(r => r.requested),
	};
}

/**
 * Wipe the whole store — every entity type, and by cascade every indexed value.
 *
 * A load is authoritative: the files define the entire store, not a patch on top
 * of it. Without this, a dump that renames concepts (e.g. "customer" ->
 * "customer name") leaves BOTH generations resident, and the same instance then
 * resolves once per generation — which the caller reports as ambiguity, from
 * data that is not actually ambiguous.
 */
export async function clearAllEntityTypes() {
	const res: any = await db.execute(sql`
		DELETE FROM search_entity_types RETURNING entity_type
	`);
	return { success: true, deleted: res.rows.length };
}

/** Cascades to every indexed value for the entity. */
export async function deleteEntityType(entityType: string) {
	const res: any = await db.execute(sql`
		DELETE FROM search_entity_types WHERE entity_type = ${entityType}
		RETURNING entity_type AS "entityType"
	`);
	if (!res.rows.length) throw new Error(`Entity type '${entityType}' not found`);
	return { success: true, data: res.rows[0] };
}

// ============================================================================
// Value index
// ============================================================================

/**
 * Bulk upsert. Re-indexing the same (entityType, instanceId, valueKind, value)
 * updates it rather than duplicating — see the uq_search_values index.
 *
 * `replace: true` makes the call authoritative for the entity: rows not present
 * in this batch are deleted afterwards. That is how a refresh drops values that
 * disappeared at the source, which a plain upsert would leave behind forever.
 */
export async function indexValues(params: {
	entityType: string;
	values: IndexValueInput[];
	replace?: boolean;
	chunkSize?: number;
}) {
	const { entityType, values, replace = false, chunkSize = 1000 } = params;
	if (!entityType?.trim()) throw new Error('entityType is required');
	if (!Array.isArray(values)) throw new Error('values must be an array');

	// FK would reject the insert anyway; fail with a usable message instead.
	await getEntityType(entityType);

	const startedAt = new Date().toISOString();
	let written = 0;

	const clean = values.filter(v => v && v.value != null && String(v.value).trim() !== '' && v.instanceId != null);

	for (let i = 0; i < clean.length; i += chunkSize) {
		const chunk = clean.slice(i, i + chunkSize);
		const rows = chunk.map(v => sql`(
			${entityType},
			${String(v.instanceId)},
			${String(v.value).trim()},
			${v.valueKind || 'name'},
			${JSON.stringify(v.attrs || {})}::jsonb,
			CURRENT_TIMESTAMP
		)`);

		const res: any = await db.execute(sql`
			INSERT INTO search_values (entity_type, instance_id, value, value_kind, attrs, updated_at)
			VALUES ${sql.join(rows, sql`, `)}
			ON CONFLICT (entity_type, instance_id, value_kind, md5(value)) DO UPDATE
				SET attrs = EXCLUDED.attrs,
				    updated_at = CURRENT_TIMESTAMP
			RETURNING id
		`);
		written += res.rows.length;
	}

	let deleted = 0;
	if (replace) {
		// Anything not touched by this run is stale at the source.
		const res: any = await db.execute(sql`
			DELETE FROM search_values
			WHERE entity_type = ${entityType} AND updated_at < ${startedAt}::timestamptz
			RETURNING id
		`);
		deleted = res.rows.length;
	}

	await db.execute(sql`
		UPDATE search_entity_types SET updated_at = CURRENT_TIMESTAMP
		WHERE entity_type = ${entityType}
	`);

	return { success: true, entityType, written, deleted, skipped: values.length - clean.length };
}

// Read-only: current value/attrs for every 'name'-kind row of an entity
// type. Exists so enrichment scripts outside this package (backend/scripts/)
// don't need to build their own db.execute(sql`...`) call — a script in a
// different package gets its OWN copy of drizzle-orm from its own
// node_modules, which TypeScript treats as a structurally different type
// from the one `db` here expects, even though it's the same version. Doing
// the raw SQL here instead avoids that cross-package type mismatch entirely.
export async function getNameValues(entityType: string): Promise<Array<{ instanceId: string; value: string; attrs: Record<string, any> }>> {
	const res: any = await db.execute(sql`
		SELECT instance_id, value, attrs FROM search_values
		WHERE entity_type = ${entityType} AND value_kind = 'name'
	`);
	return res.rows.map((r: any) => ({ instanceId: r.instance_id, value: r.value, attrs: r.attrs || {} }));
}

export async function deleteValues(params: { entityType: string; instanceId?: string }) {
	const { entityType, instanceId } = params;
	if (!entityType?.trim()) throw new Error('entityType is required');

	const res: any = instanceId
		? await db.execute(sql`DELETE FROM search_values WHERE entity_type = ${entityType} AND instance_id = ${instanceId} RETURNING id`)
		: await db.execute(sql`DELETE FROM search_values WHERE entity_type = ${entityType} RETURNING id`);

	return { success: true, deleted: res.rows.length };
}

// ============================================================================
// Resolve
// ============================================================================

/**
 * The exact/exact_normalized tiers. Used as both the trigger and the acceptance
 * bar for the strip fallback below: anything at or above this is a value the
 * mention actually names, not one it merely resembles.
 */
const EXACT_TIER_SCORE = 0.95;

/**
 * Ranked lookup, tiered so an exact match always beats a fuzzy one.
 *
 *   1.00 exact on value_norm          0.75 word match (tsquery)
 *   0.95 exact on value_squashed      0.70 starts-with on squashed
 *   0.85 prefix on value_norm         0.60 substring on squashed
 *                                     sim×0.5 trigram
 *
 * Results collapse to ONE row per (entityType, instanceId): an instance carries
 * several values (name, code, alias) and without this a single customer would
 * be reported as three separate matches.
 *
 * The trigram tier uses the `%` operator so the GIN index is usable; that
 * operator honours pg_trgm.similarity_threshold (default 0.3), so `minScore`
 * trims the tail rather than driving the index probe.
 */
export async function resolve(params: {
	query: string;
	entityType?: string;
	limit?: number;
	minScore?: number;
	perTypeCap?: number;
	/** Skip the unscoped retry, for callers that discard other-typed hits anyway. */
	scopedOnly?: boolean;
	/**
	 * A type that we already trusts (typically the entityType a prior scoped
	 * search was run against, being double-checked via an unscoped recheck).
	 * That type's own top-scoring ties are NEVER capped away by perTypeCap or
	 * limit — every OTHER type still gets the normal caps, unchanged.
	 * "Hindalco Industries" prefix-matches 16 real customer-name entities, all
	 * tied at score 0.85 — the untargeted fix (uncapping every type's ties)
	 * regressed the ORIGINAL crowding case this cap exists for ("FDC" unscoped
	 * ties 10 coincidental pan-no prefixes at the same score, which must stay
	 * capped so the real customer "F D C LIMITED" isn't buried) — scoping the
	 * escape hatch to only the caller's own already-trusted type fixes the
	 * former without reopening the latter (verified: with trustedType unset,
	 * "FDC" output is byte-identical to the pre-existing behavior).
	 */
	trustedType?: string;
}): Promise<ResolveResult> {

	const { query, entityType, limit = 10, minScore = 0.3, perTypeCap = 2, scopedOnly = false, trustedType } = params;

	if (!query || !query.trim()) {
		return { query: query || '', resolved: false, ambiguous: false, hits: [] };
	}

	const res: any = await db.execute(sql`
		WITH q AS (
			SELECT btrim(regexp_replace(lower(${query}), '[^a-z0-9]+', ' ', 'g')) AS q_norm,
			       regexp_replace(lower(${query}), '[^a-z0-9]+', '', 'g')        AS q_squashed
		),
		scored AS (
			SELECT sv.entity_type, sv.instance_id, sv.value, sv.value_kind, sv.attrs,
				CASE
					WHEN sv.value_norm     = q.q_norm                          THEN 1.00
					WHEN sv.value_squashed = q.q_squashed                      THEN 0.95
					WHEN sv.value_norm LIKE q.q_norm || '%'                    THEN 0.85
					-- The VALUE is a leading token-run of the QUERY — the mention
					-- glued a qualifier onto the real value ("surat branch" for
					-- branch "SURAT"). Every other tier asks whether the value
					-- starts with or contains the query; none asks the reverse, so
					-- this shape reached no tier at all and fell through to fuzzy,
					-- where the right answer lost 0.462 to 0.538 against a vehicle
					-- owner coincidentally named "SURAT BARAL". Scored BELOW prefix
					-- so a genuinely better match always wins; the 4-char floor
					-- stops a short generic value matching every query.
					WHEN length(sv.value_norm) >= 4
					     AND q.q_norm LIKE sv.value_norm || ' %'               THEN 0.80
					WHEN sv.value_tsv @@ plainto_tsquery('simple', q.q_norm)   THEN 0.75
					-- Starts-with on the squashed form. Separates a real acronym
					-- hit from an incidental mid-string one: 'FDC' opens
					-- 'fdclimited' but sits mid-word in '...divisionofdcm...'.
					WHEN sv.value_squashed LIKE q.q_squashed || '%'            THEN 0.70
					WHEN sv.value_squashed LIKE '%' || q.q_squashed || '%'     THEN 0.60
					ELSE similarity(sv.value_squashed, q.q_squashed) * 0.5
				END AS score,
				CASE
					WHEN sv.value_norm     = q.q_norm                          THEN 'exact'
					WHEN sv.value_squashed = q.q_squashed                      THEN 'exact_normalized'
					WHEN sv.value_norm LIKE q.q_norm || '%'                    THEN 'prefix'
					WHEN length(sv.value_norm) >= 4
					     AND q.q_norm LIKE sv.value_norm || ' %'               THEN 'query_prefix'
					WHEN sv.value_tsv @@ plainto_tsquery('simple', q.q_norm)   THEN 'word'
					WHEN sv.value_squashed LIKE q.q_squashed || '%'            THEN 'prefix_normalized'
					WHEN sv.value_squashed LIKE '%' || q.q_squashed || '%'     THEN 'contains'
					ELSE 'fuzzy'
				END AS match_type
			FROM search_values sv, q
			WHERE (${entityType ?? null}::varchar IS NULL OR sv.entity_type = ${entityType ?? null})
			  AND q.q_squashed <> ''
			  AND (
				sv.value_norm     = q.q_norm
				OR sv.value_squashed = q.q_squashed
				OR sv.value_norm LIKE q.q_norm || '%'
				OR (length(sv.value_norm) >= 4 AND q.q_norm LIKE sv.value_norm || ' %')
				OR sv.value_tsv @@ plainto_tsquery('simple', q.q_norm)
				OR sv.value_squashed LIKE q.q_squashed || '%'
				OR sv.value_squashed LIKE '%' || q.q_squashed || '%'
				OR sv.value_squashed % q.q_squashed
			  )
		),
		ranked AS (
			SELECT *, ROW_NUMBER() OVER (
				PARTITION BY entity_type, instance_id
				ORDER BY score DESC,
				         CASE value_kind WHEN 'name' THEN 0 WHEN 'code' THEN 1 ELSE 2 END,
				         length(value)
			) AS rn
			FROM scored
		),
		-- DIVERSITY CAP: rank candidates WITHIN each entity_type before the
		-- global limit is applied. Without this, a large/noisy type (e.g.
		-- 191k PAN codes) can fill every result slot with coincidental prefix
		-- matches, crowding out a smaller, more relevant type's real match
		-- (e.g. a customer name) that would otherwise never reach the caller
		-- at all — confirmed: "FDC" returned 5/5 pan-no hits, and the actual
		-- customer "F D C LIMITED" only showed up once the limit was raised
		-- to 20. Only applies to an UNSCOPED search (entityType IS NULL) — a
		-- scoped search already has just one type in play, so capping there
		-- would wrongly truncate a caller who explicitly asked for more.
		by_type AS (
			SELECT *, ROW_NUMBER() OVER (
				PARTITION BY entity_type
				ORDER BY score DESC,
				         CASE value_kind WHEN 'name' THEN 0 WHEN 'code' THEN 1 ELSE 2 END,
				         length(value), instance_id
			) AS type_rank,
			MAX(score) OVER (PARTITION BY entity_type) AS type_max_score
			FROM ranked
			WHERE rn = 1 AND score >= ${minScore}
		),
		-- TRUSTED-TYPE ESCAPE HATCH: perTypeCap stays exactly as-is for every
		-- type EXCEPT trustedType — that one type's own top-scoring ties are
		-- never capped away. Scoped to a single caller-known type (not "any
		-- tied type") specifically so this can't reopen the FDC/pan-no
		-- crowding case above: pan-no was never the trustedType in a
		-- customer-name recheck, so its 10-way coincidental tie stays capped
		-- at perTypeCap regardless of how this escape hatch behaves for
		-- customer name.
		by_type_filtered AS (
			SELECT * FROM by_type
			WHERE ${entityType ?? null}::varchar IS NOT NULL
			   OR type_rank <= ${perTypeCap}
			   OR (${trustedType ?? null}::varchar IS NOT NULL AND entity_type = ${trustedType ?? null} AND score = type_max_score)
		),
		with_overall_max AS (
			SELECT *,
			       MAX(score) OVER () AS overall_max_score,
			       ROW_NUMBER() OVER (
					ORDER BY score DESC,
					         CASE value_kind WHEN 'name' THEN 0 WHEN 'code' THEN 1 ELSE 2 END,
					         length(value), instance_id
			       ) AS overall_rank
			FROM by_type_filtered
		),
		top AS (
			SELECT * FROM with_overall_max
			WHERE overall_rank <= ${limit}
			-- OVERALL-TIE ESCAPE HATCH: a tie for the single best score found is
			-- never truncated by the flat row-count limit either — fixes the
			-- plain SCOPED case (Hindalco scoped never even reached perTypeCap,
			-- since that cap is bypassed entirely when entityType is set; it was
			-- only ever the outer LIMIT doing the damage there).
			OR score = overall_max_score
		)
		SELECT t.entity_type AS "entityType",
		       t.instance_id AS "instanceId",
		       t.value,
		       COALESCE(dn.value, t.value) AS "displayName",
		       t.value_kind  AS "valueKind",
		       t.attrs,
		       ROUND(t.score::numeric, 3)::float8 AS score,
		       t.match_type  AS "matchType"
		FROM top t
		LEFT JOIN LATERAL (
			SELECT s2.value FROM search_values s2
			WHERE s2.entity_type = t.entity_type
			  AND s2.instance_id = t.instance_id
			  AND s2.value_kind = 'name'
			ORDER BY length(s2.value)
			LIMIT 1
		) dn ON true
		ORDER BY t.score DESC, length(t.value), t.instance_id
	`);

	let hits: ResolveHit[] = res.rows;
	const scope = entityType ? `entityType="${entityType}"` : 'entityType=ANY';
	console.log(`[ENTITY-SEARCH] resolve("${query}", ${scope}) tiered match: ${hits.length} hit(s)`);

	// FUZZY FALLBACK — when nothing matched, OR when the only thing that did
	// is the tiered query's own weak catchall (the `similarity() * 0.5` ELSE
	// branch in the scored CTE above, which is the ONLY tier that can score
	// <= 0.5 — every other tier is a hardcoded literal >= 0.60). That
	// catchall is plain trigram similarity(), which divides by the UNION of
	// trigrams: a query with extra words around the real value ("date field
	// allowance" against value "field allowance") gets diluted and scores
	// low even though the value is a clean substring match in spirit.
	//
	// word_similarity() scores the query against the BEST-MATCHING PORTION of
	// the value instead, which handles both that shape and true misspellings
	// ("PREMER ENRGES PHOTOOTAIC" shares no usable substring with "PREMIER
	// ENERGIES PHOTOVOLTAIC PRIVATE LIMITED"): measured 0.395 for the right
	// row vs 0.259 for its three sibling "PREMIER ENERGIES …" companies —
	// enough separation to pick correctly, and consistently the better score
	// whenever the weak catchall is what's being compared against.
	if (hits.length === 0 || hits[0].score <= 0.5) {
		const fuzzyHits = await resolveFuzzy({ query, entityType, limit, minScore });
		console.log(`[ENTITY-SEARCH] resolve("${query}", ${scope}) fuzzy fallback: ${fuzzyHits.length} hit(s)`);
		if (fuzzyHits.length && (hits.length === 0 || fuzzyHits[0].score > hits[0].score)) {
			hits = fuzzyHits;
		}
	}

	// UNSCOPED FALLBACK — an entityType hint is a caller's GUESS, not a fact.
	// If nothing matched inside that scope, the value may simply live under a
	// different type (e.g. "Kirby" tagged entityType='branch name' when it's
	// really a customer) — a wrong guess must not permanently kill a match
	// that would have succeeded unscoped.
	//
	// Also fires on a NONZERO but low-confidence scoped hit (score < 0.9, i.e.
	// short of the exact/exact_normalized tiers) — a mediocre in-scope match
	// must not silently outrank a real exact match sitting under a different
	// type, just because it was never checked. Real case: mention "date field
	// allowance" tagged entityType="deduction name" scored 0.81 (fuzzy)
	// against "FIELD ALLOWANCE DEDUCTION" while "FIELD ALLOWANCE" itself, an
	// exact (1.0) match, sat unchecked under entityType="field allowance".
	// Since an unscoped search is a strict superset of the scoped one (same
	// scoring, more rows), its top hit can only tie or beat the scoped top
	// hit, so this never loses to a worse candidate — it can only replace a
	// bad guess with a better one.
	if (entityType && !scopedOnly && (hits.length === 0 || hits[0].score < 0.9)) {
		const why = hits.length === 0 ? `nothing under "${entityType}"` : `best under "${entityType}" scored ${hits[0].score} — not high-confidence`;
		console.log(`[ENTITY-SEARCH] resolve("${query}") — ${why}, checking UNSCOPED (any entity type)`);
		// trustedType: entityType — this recheck is about confirming/completing
		// the ALREADY-scoped type, not discovering a new one. Without it, many
		// real same-type ties (e.g. a conglomerate's per-plant billing
		// entities — confirmed live: "Hindalco Industries" prefix-matches 16
		// real customer-name rows, all tied at 0.85) get perTypeCap-truncated
		// down to 2 arbitrary survivors (whichever have the shortest name —
		// pure tie-break noise, not relevance) the moment this fallback fires.
		const unscoped = await resolve({ query, limit, minScore, perTypeCap, trustedType: entityType });
		// >= not >: unscoped is a strict superset of the scoped candidate pool
		// (same scoring, more rows), so on a tie it can only be MORE complete,
		// never worse — e.g. a scoped-only result that misses a same-scoring
		// out-of-type candidate would silently hide real ambiguity instead of
		// surfacing it via the `ambiguous` flag below.
		if (unscoped.hits.length && (hits.length === 0 || unscoped.hits[0].score >= hits[0].score)) {
			return unscoped;
		}
	}

	// LEADING-WORD-STRIP FALLBACK — a mention that glues an extra descriptive
	// word onto the front of the real value ("date field allowance" for
	// "field allowance", the caller having meant "date" as a separate
	// requested column) dilutes trigram/word_similarity scoring even though
	// the real value is a clean, exact match once that word is dropped.
	// Real case: "date field allowance" scored 0.81 (fuzzy, wrong concept)
	// even fully unscoped, while "field allowance" alone scores 1.0 (exact,
	// right concept) — dropping one leading word turns a wrong guess into an
	// exact match. Recurses through the FULL resolve() pipeline (tiers,
	// fuzzy, unscoped) for the shorter query, so it naturally cascades
	// rather than duplicating that logic here. Bounded: each recursion drops
	// one word, so it terminates in at most (word count - 1) levels, and
	// only continues at all while the best score so far stays low-confidence
	// — a query that's already a good match never pays for this.
	//
	// BOTH ENDS, and only for an EXACT landing. Two faults were found live on
	// "Surat branch":
	//   1. Only the LEADING word was dropped. That is right for "date field
	//      allowance", where the noise leads, and exactly backwards here, where
	//      the qualifier trails — it searched "branch" and fuzzy-matched a
	//      vehicle owner named "PRADEEP KUMAR BRANWAL" at 0.571.
	//   2. Acceptance was purely relative (`stripped > current`), so that 0.571
	//      replaced everything simply by beating an equally weak 0.538.
	// A strip is only justified when dropping the word turns the mention into an
	// EXACT value — which is what both motivating cases actually do ("field
	// allowance" 1.00, "surat" 1.00). Requiring that kills the whole class of
	// generic leftovers: "transport" and "company" DO prefix-match real rows at
	// 0.85, so a mere "better score" test would still take them.
	const words = query.trim().split(/\s+/);
	if (words.length > 1 && (hits.length === 0 || hits[0].score < EXACT_TIER_SCORE)) {
		for (const strippedQuery of [words.slice(1).join(' '), words.slice(0, -1).join(' ')]) {
			const stripped = await resolve({ query: strippedQuery, entityType, limit, minScore, scopedOnly });
			const top = stripped.hits[0];
			if (top && top.score >= EXACT_TIER_SCORE && (hits.length === 0 || top.score > hits[0].score)) {
				console.log(`[ENTITY-SEARCH] resolve("${query}") — dropping to "${strippedQuery}": scored ${top.score} (${top.matchType}) vs ${hits.length ? hits[0].score : 'nothing'}`);
				return stripped;
			}
		}
	}

	if (hits.length) {
		console.log(`[ENTITY-SEARCH] resolve("${query}") RESOLVED — ${hits.length} hit(s) (limit was ${limit}):`);
		for (const h of hits) {
			console.log(`    entityType="${h.entityType}"  instanceId=${h.instanceId}  value="${h.value}"  score=${h.score}  matchType=${h.matchType}`);
		}
	} else {
		console.log(`[ENTITY-SEARCH] resolve("${query}") UNRESOLVED — no match at any tier, scoped or unscoped`);
	}

	return {
		query,
		resolved: hits.length > 0,
		// Several distinct instances scoring alike — the caller must disambiguate
		// or ask, never silently take the first.
		ambiguous: hits.length > 1 && hits[0].score - hits[1].score < 0.05,
		hits,
	};
}

/**
 * Typo-tolerant last resort, used only when every exact/substring tier missed.
 *
 * Candidate generation is deliberately cheap and index-backed: a row qualifies
 * if it contains the first 4 characters of ANY query word (`value_norm LIKE
 * '%prem%'` rides the trigram GIN index). Scoring then uses word_similarity on
 * that small candidate set, so the expensive metric never touches the whole
 * table. Words shorter than 4 characters are ignored — a 3-letter stem matches
 * far too much to be evidence of anything.
 *
 * Scores ARE the word_similarity value, which lands below the 0.60 substring
 * tier and above the 0.30 floor — so a fuzzy hit can never outrank a real one,
 * and `matchType: 'fuzzy'` tells the caller the name was corrected.
 */
async function resolveFuzzy(params: {
	query: string;
	entityType?: string;
	limit: number;
	minScore: number;
}): Promise<ResolveHit[]> {
	const { query, entityType, limit, minScore } = params;

	// This tier bridges misspelled NAMES; a near miss on a digit identifier is a
	// different record. GCN '1020139859' matched vendor code 'V102013' at 0.364.
	if (!/[a-z]/i.test(query)) return [];
	// Same reasoning for a category word carrying an embedded identifier
	// ("Project 314023", "Invoice 45210") — word_similarity can't weigh the
	// digits (they never token-match against a name), so it scores purely on
	// the surrounding word and can return a record that merely shares that
	// word. An identifier is looked up exactly or not at all, never corrected.
	if (/\d{3,}/.test(query)) return [];

	const stems = normalizeValue(query).norm
		.split(' ')
		.filter(w => w.length >= 4)
		.map(w => w.slice(0, 4));
	if (stems.length === 0) return [];

	const res: any = await db.execute(sql`
		WITH q AS (
			SELECT btrim(regexp_replace(lower(${query}), '[^a-z0-9]+', ' ', 'g')) AS q_norm
		),
		cand AS (
			SELECT sv.entity_type, sv.instance_id, sv.value, sv.value_kind, sv.attrs, sv.value_norm
			FROM search_values sv
			WHERE (${entityType ?? null}::varchar IS NULL OR sv.entity_type = ${entityType ?? null})
			  AND EXISTS (
				-- stems are [a-z0-9] only (normalizeValue strips everything else),
				-- so a comma-joined string is a safe carrier for the array.
				SELECT 1 FROM unnest(string_to_array(${stems.join(',')}, ',')) AS s(stem)
				WHERE sv.value_norm LIKE '%' || s.stem || '%'
			  )
		),
		scored AS (
			SELECT c.*, word_similarity(q.q_norm, c.value_norm) AS score
			FROM cand c, q
		),
		ranked AS (
			SELECT *, ROW_NUMBER() OVER (
				PARTITION BY entity_type, instance_id
				ORDER BY score DESC, length(value)
			) AS rn
			FROM scored WHERE score >= ${minScore}
		)
		SELECT r.entity_type AS "entityType",
		       r.instance_id AS "instanceId",
		       r.value,
		       COALESCE(dn.value, r.value) AS "displayName",
		       r.value_kind AS "valueKind",
		       r.attrs,
		       ROUND(r.score::numeric, 3)::float8 AS score,
		       'fuzzy' AS "matchType"
		FROM ranked r
		LEFT JOIN LATERAL (
			SELECT s2.value FROM search_values s2
			WHERE s2.entity_type = r.entity_type AND s2.instance_id = r.instance_id
			  AND s2.value_kind = 'name'
			ORDER BY length(s2.value) LIMIT 1
		) dn ON true
		WHERE r.rn = 1
		ORDER BY r.score DESC, length(r.value)
		LIMIT ${limit}
	`);

	return res.rows as ResolveHit[];
}

/**
 * Resolve several mentions in one round trip.
 *
 * A mention that resolves to nothing is returned with `resolved: false` and an
 * empty hit list — NEVER omitted. Callers must surface it as a failure instead
 * of answering for the subset that resolved, which is the specific behaviour
 * that produced "FDC Limited was not found in the customer master database".
 */
export async function resolveMany(params: {
	mentions: string[];
	entityType?: string;
	limit?: number;
	minScore?: number;
}): Promise<{ success: boolean; results: ResolveResult[]; unresolved: string[] }> {
	const { mentions, ...rest } = params;

	if (!Array.isArray(mentions) || mentions.length === 0) {
		return { success: true, results: [], unresolved: [] };
	}


	const results = await Promise.all(mentions.map(m => resolve({ query: m, ...rest })));

	return {
		success: true,
		results,
		unresolved: results.filter(r => !r.resolved).map(r => r.query),
	};
}

// ============================================================================
// Pattern registry — values that change daily and cannot be indexed
// ============================================================================

export interface RecognizedMention {
	mention: string;
	entityType: string;
	/** Where values of this shape live, e.g. "trp_trn_bookinginvoice.InvoiceNo". */
	field?: string;
	/** Ready-to-use SQL predicate, already normalised for this mention. */
	match?: string;
	/** Full lookup query when the entity declares one, placeholders filled in. */
	searchSql?: string;
	/** How the type was established: read off the value, or stated in the question. */
	via: 'pattern' | 'entityType';
	/** The entity map entry, so the agent gets joins/notes without a second call. */
	resolution: Record<string, any>;
}

/**
 * Squash-normalises both sides: the same invoice is stored as `CHL/2144/23-24`,
 * `CHL2144/23-24` and `CHL 4050/4051/23-24`, so `=` on raw text finds neither.
 */
function buildMatchSql(field: string, mention: string): string {
	const col = field.includes('.') ? field.split('.').slice(-1)[0] : field;
	const squashed = normalizeValue(mention).squashed.toUpperCase();
	return `REPLACE(REPLACE(REPLACE(REPLACE(UPPER(${col}),' ',''),'/',''),'-',''),'.','') LIKE '%${squashed}%'`;
}

/**
 * Fill a `searchSql` template: {{value}}/@value verbatim, {{squashed}}/@squashed
 * punctuation-stripped. Quotes are doubled — this text lands directly in SQL.
 */
function fillSearchSql(template: string, mention: string): string {
	const esc = (s: string) => s.replace(/'/g, "''");
	const raw = esc(mention.trim());
	const squashed = esc(normalizeValue(mention).squashed.toUpperCase());
	return template
		.replace(/\{\{\s*value\s*\}\}|@value\b/gi, raw)
		.replace(/\{\{\s*squashed\s*\}\}|@squashed\b/gi, squashed);
}

/**
 * The dump writes prose in `value_field` where no single column applies ("n/a —
 * identified by ID"), which would build unparseable SQL. Require table.Column.
 */
function usableField(v: unknown): string | undefined {
	return typeof v === 'string' && /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*){1,2}$/.test(v.trim())
		? v.trim() : undefined;
}

/** Shared shape-building so both routes emit identical entries. */
function buildRecognized(
	mention: string,
	entityType: string,
	resolution: Record<string, any>,
	via: 'pattern' | 'entityType',
): RecognizedMention {
	// `valueField` comes from the dump; `field` overrides it when the searchable
	// column isn't the one the dump names.
	const field = usableField(resolution?.field) ?? usableField(resolution?.valueField);
	const template = typeof resolution?.searchSql === 'string' ? resolution.searchSql : undefined;
	return {
		mention,
		entityType,
		field,
		match: field ? buildMatchSql(field, mention) : undefined,
		searchSql: template ? fillSearchSql(template, mention) : undefined,
		via,
		resolution,
	};
}

/**
 * Companion to recognizePatterns for when the question already named the type.
 * Needed because a regex cannot separate GCN from CCHS — identical 10-digit
 * shapes in the same column — so shape matching alone returns both.
 */
export async function locateByEntityType(
	pairs: Array<{ text: string; entityType: string }>,
	/** Types already resolved this turn, to skip a second lookup. */
	known?: Map<string, { matched: string; resolution: Record<string, any> }>,
): Promise<RecognizedMention[]> {
	const wanted = (pairs || [])
		.map(p => ({ text: String(p?.text ?? '').trim(), entityType: String(p?.entityType ?? '').trim() }))
		.filter(p => p.text && p.entityType);
	if (!wanted.length) return [];

	// One lookup per distinct type — mentions often share a label.
	const cache = new Map(known ?? []);
	const out: RecognizedMention[] = [];
	for (const { text, entityType } of wanted) {
		let hit = cache.get(entityType);
		if (!hit) {
			// Fuzzy, so "gcn number" reaches `gcn no` instead of finding nothing.
			const matched = await resolveEntityTypes({ names: [entityType] });
			const r = matched.results[0];
			if (r?.matched && r.resolution) cache.set(entityType, (hit = { matched: r.matched, resolution: r.resolution }));
		}
		if (!hit?.matched || !hit.resolution) continue;
		// Only useful if the entity actually declares where to look.
		const usable = usableField(hit.resolution.field) ?? usableField(hit.resolution.valueField);
		if (!usable && typeof hit.resolution.searchSql !== 'string') continue;
		out.push(buildRecognized(text, hit.matched, hit.resolution, 'entityType'));
	}
	return out;
}

/**
 * Recognise mentions the value index cannot hold.
 *
 * Invoice numbers, GCN numbers and e-way bills change every day, so indexing
 * them would mirror the source database and never be current (§ 2.1). What IS
 * stable is their SHAPE — so an entity map entry may declare a `pattern`, and a
 * mention matching it is reported as "not indexed, but it lives HERE".
 *
 * Deliberately does NOT query the source. A normalised lookup against
 * trp_trn_bookinginvoice measured ~5.5s (REPLACE() per row defeats every index,
 * and we cannot add a computed column to the client's database). Returning the
 * field and the predicate lets the agent fold this into the query it is already
 * writing, with its own date filters — one targeted query instead of a scan.
 *
 * Returns ALL matching patterns, never a single best guess: a PAN
 * ("AFHPL5475J") and a vehicle number ("AP39V8595") are both letters-and-digits,
 * so a collision is a real possibility and the caller must see both.
 */
export async function recognizePatterns(texts: string[]): Promise<RecognizedMention[]> {
	const wanted = (texts || []).map(t => String(t ?? '').trim()).filter(Boolean);
	if (!wanted.length) return [];

	const res: any = await db.execute(sql`
		SELECT entity_type AS "entityType", resolution
		FROM search_entity_types
		WHERE resolution ? 'pattern'
		ORDER BY entity_type
	`);
	if (!res.rows.length) return [];

	const out: RecognizedMention[] = [];
	for (const row of res.rows as Array<{ entityType: string; resolution: any }>) {
		const raw = row.resolution?.pattern;
		if (typeof raw !== 'string' || !raw.trim()) continue;
		// Authored data, but a malformed pattern must not take resolution down
		// with it — skip it and keep every other pattern working.
		let rx: RegExp;
		try {
			rx = new RegExp(raw, 'i');
		} catch (err) {
			console.warn(`[ENTITY-SEARCH] entity "${row.entityType}" has an invalid pattern, skipping: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		for (const mention of wanted) {
			if (!rx.test(mention)) continue;
			out.push(buildRecognized(mention, row.entityType, row.resolution, 'pattern'));
		}
	}
	return out;
}


// ============================================================================
// Combined lookup — backs the agent's single `resolve_entities` tool call
// ============================================================================

/**
 * One call, both halves of the question:
 *   mentions    — proper nouns/identifiers to turn into ids  ("FDC limited")
 *   entityTypes — concepts to turn into table/column/join facts ("outstanding balance")
 *
 * Either side may be omitted, so the agent can re-call mid-turn with just the
 * half it needs (e.g. resolving a name it only discovered after seeing data).
 *
 * `unresolved` is a first-class output, never an empty omission: a mention we
 * cannot resolve MUST reach the agent so it reports a miss instead of inventing
 * an id. That is the exact failure this whole subsystem exists to prevent.
 */
export async function resolveEntities(params: {
	mentions?: Array<{ text: string; entityType?: string }>;
	entityTypes?: string[];
	limit?: number;
	minScore?: number;
	/**
	 * Candidates kept per entity type. Threaded through so a caller that can
	 * WEIGH candidates itself may ask for more of them.
	 *
	 * The two callers want opposite things. MainAgent needs a decision made for
	 * it — a tool-call budget, no cheap exploratory SQL — so the conservative
	 * defaults stand. A coding agent reads labelled candidates and can run its
	 * own query to disambiguate, so withholding a low-scoring candidate loses
	 * information it would have used: `minScore` 0.3 dropped the correct
	 * "BHUBANESHWAR RO" region at 0.237 and left only a wrong service network
	 * at 0.313. Same latency either way — the scan dominates, not the filter.
	 */
	perTypeCap?: number;
}) {
	const { mentions = [], entityTypes = [], limit = 5, minScore = 0.3, perTypeCap } = params;

	const [valueSide, conceptSide] = await Promise.all([
		mentions.length
			? Promise.all(mentions.map(async (m) => {
				let r = await resolve({ query: m.text, entityType: m.entityType, limit, minScore, ...(perTypeCap !== undefined ? { perTypeCap } : {}) });
				// UNCAP FOR MENTIONS THAT WERE NEVER SCOPED. `trustedType` (see resolve())
				// only ever gets set on the fallback path INSIDE resolve() — reached when a
				// SCOPED search (a real m.entityType) comes back weak. A mention with no
				// entityType at all (the common, CORRECT case per this file's own
				// instructions: "never guess it") never takes a scoped attempt in the first
				// place, so that fallback never fires and the plain perTypeCap=2 cross-type
				// cap silently truncates a real same-type tie. Confirmed live: "EXIDE
				// INDUSTRIES" unscoped returned only 2 of 9 real branch entities (perTypeCap),
				// while the exact same query scoped to entityType="customer name" returned
				// all 9. Re-run once, trusting whichever type the top hit already won, to
				// uncap that type's own ties — cheap (one extra query, only when the mention
				// was unscoped and got at least one hit) and a no-op when there's no tie to
				// uncap.
				if (!m.entityType && r.hits.length > 0) {
					const refined = await resolve({ query: m.text, limit, minScore, ...(perTypeCap !== undefined ? { perTypeCap } : {}), trustedType: r.hits[0].entityType });
					if (refined.hits.length > r.hits.length) r = refined;
				}
				return { mention: m.text, requestedType: m.entityType ?? null, ...r };
			}))
			: Promise.resolve([]),
		entityTypes.length
			? resolveEntityTypes({ names: entityTypes })
			: Promise.resolve({ success: true, results: [], unmatched: [] as string[] }),
	]);

	// CROSS-WIRE — mentions and entityTypes resolve independently above, so a
	// concept the caller correctly named (conceptSide) never informs a
	// mention search that got the wrong type, or none at all (valueSide).
	// Confirmed failure case: "DFC" resolved entityTypes=["customer name"]
	// correctly in the SAME call where the mention itself searched unscoped
	// and never surfaced that type at all. If a concept matched here, and a
	// mention's own hits don't already include that type, run ONE small
	// SCOPED lookup for that (mention, type) pair — cheap (single-type, not
	// the full unscoped sweep) and only fires when there's something to
	// gain; zero extra cost when entityTypes matched nothing.
	const matchedConceptTypes = conceptSide.results.filter(r => r.matched).map(r => r.matched as string);
	if (matchedConceptTypes.length && valueSide.length) {
		await Promise.all(valueSide.map(async (v) => {
			// Unresolved means valueSide already swept EVERY type; a scoped search
			// is a subset of that, so it cannot find what the sweep missed.
			if (!v.resolved) return;
			// An exact hit is not a wrong-type guess — nothing to rescue.
			const strong = v.hits[0] && (v.hits[0].score >= 0.95
				|| v.hits[0].matchType === 'exact' || v.hits[0].matchType === 'exact_normalized');
			if (strong) return;
			for (const type of matchedConceptTypes) {
				if (v.hits.some(h => h.entityType === type)) continue; // already covered
				// valueSide ran this exact pair already; the `hits` check above can't
				// see that, because a miss leaves hits empty.
				if (v.requestedType === type) continue;
				// scopedOnly: `genuine` below drops anything not of `type`, so the
				// unscoped sweep would be dead work.
				const scoped = await resolve({ query: v.mention, entityType: type, limit: 3, minScore, scopedOnly: true });
				// resolve()'s own UNSCOPED FALLBACK can rescue a scoped miss
				// with hits of a DIFFERENT type — exactly what we don't want
				// here: the cross-wire specifically wants THIS type or
				// nothing, never a substitute. Filter down to genuine
				// same-type matches before accepting anything.
				const genuine = scoped.hits.filter(h => h.entityType === type);
				if (!genuine.length) continue;
				console.log(`[ENTITY-SEARCH] cross-wire: "${v.mention}" had no "${type}" candidate — scoped lookup found ${genuine.length}, merging in`);
				if (v.hits.length === 0) {
					// Was unresolved — this becomes the answer.
					v.hits = genuine;
					v.resolved = true;
					v.ambiguous = genuine.length > 1 && genuine[0].score - genuine[1].score < 0.05;
				} else {
					// Already had a top pick — leave it alone, but surface
					// the model-hinted type FIRST among alternatives rather
					// than buried behind unrelated types.
					v.hits = [v.hits[0], ...genuine, ...v.hits.slice(1)];
				}
			}
		}));
	}

	const resolved = valueSide
		.filter(v => v.resolved)
		.map(v => ({
			mention: v.mention,
			// Top pick — kept as top-level fields (unchanged shape) so
			// anything already reading entityType/instanceId/displayName off
			// this object keeps working exactly as before.
			entityType: v.hits[0].entityType,
			instanceId: v.hits[0].instanceId,
			displayName: v.hits[0].displayName,
			attrs: v.hits[0].attrs,
			score: v.hits[0].score,
			ambiguous: v.ambiguous,
			// EVERY other candidate found, not just same-type score-ties —
			// the diversity cap in resolve() guarantees a different type's
			// real match survives into `hits`, but a wrong top pick still
			// needs to be VISIBLE and labeled for the caller to override.
			// Confirmed failure case: "DFC" top-scored 5 pan-no codes at
			// 0.85 (coincidental prefix matches) while the actual customer
			// "F D C LIMITED" only reached 0.70 (its stored spaces block
			// the top scoring tier) — a 0.15 gap, so the old ambiguous-only
			// (<0.05 gap) alternatives never surfaced it at all. entityType
			// and matchType are included here (missing before) so the
			// caller can actually tell a pan-no candidate from a customer
			// one, instead of an unlabeled id/name/score triple.
			alternatives: v.hits.length > 1 ? v.hits.slice(1).map(h => ({
				entityType: h.entityType, instanceId: h.instanceId, displayName: h.displayName,
				score: h.score, matchType: h.matchType, attrs: h.attrs,
			})) : undefined,
		}));

	// Attach an imperative, data-proximate instruction directly onto any resolved
	// entry that has alternatives of the SAME entityType as the top pick (i.e. this
	// looks like one company's multiple branches/locations, not a genuine wrong-type
	// ambiguity like the "DFC" PAN-code case). A system-prompt paragraph stating this
	// policy once, far from the data, was confirmed NOT to hold across repeated live
	// tests (Hindalco, BEML, Coromandal — model kept asking the user to pick, or
	// silently combined every alternative's id into one query) — putting the
	// instruction ON the tool result itself, right next to the ids it governs, is
	// the fix for that: it cannot be scrolled past or diluted by the rest of the
	// prompt the way a standing policy statement can.
	// Compare names case- and whitespace-insensitively: "SUNIL KUMAR",
	// "sunil kumar" and "SUNIL  KUMAR" are one name, not three, and treating
	// them as three would send a shared-name collision down the branches path.
	const normName = (v: unknown) => String(v ?? '').toUpperCase().replace(/\s+/g, ' ').trim();

	for (const r of resolved) {
		if (!r.alternatives?.length) continue;
		// Only real ties (within 0.05) make a pick ambiguous; weaker partial matches don't.
		const ties = r.alternatives.filter(a => a.score >= r.score - 0.05);
		if (!ties.length) continue;
		const sameTypeAlts = ties.every(a => a.entityType === r.entityType);
		if (!sameTypeAlts) continue; // genuine cross-type ambiguity — let the model reason normally

		// SAME TYPE splits two ways, and the two need OPPOSITE instructions.
		// The discriminator is whether the candidates have distinguishable
		// names, which is data already in hand and needs no person-vs-company
		// taxonomy to maintain:
		//
		//   distinct names → "HINDALCO ... RENUKOOT / MURI / PUNE": one company's
		//     plants. Answer for one and list the rest; asking first is friction.
		//   one name → 178 vehicle owners all called "SUNIL KUMAR": unrelated
		//     records sharing a common name. Listing them prints one string 178
		//     times, and they are NOT branches — telling the user they are is
		//     false, and suppressing the question is wrong precisely here.
		const distinctNames = new Set([
			normName(r.displayName),
			...ties.map(a => normName(a.displayName)),
		]).size;

		if (distinctNames === 1) {
			(r as any).guidance =
				`"${r.displayName}" is NOT unique: ${ties.length + 1} separate ${r.entityType} ` +
				`records carry this exact name. They are DIFFERENT entities that happen to share a name, ` +
				`NOT branches of one thing — so do NOT filter on instanceId ${r.instanceId} as though it ` +
				`were "the" one, and do NOT sum across them. Tell the user the name is ambiguous, say how ` +
				`many records share it, and ask for something that separates them (an identifier, a ` +
				`location, a date range) — or, if the question is genuinely about all of them, say ` +
				`so explicitly in your answer and filter on the name rather than on one id.`;
			continue;
		}

		(r as any).guidance =
			`Use id ${r.instanceId} only — do not also filter on the alternatives' ids, do not ` +
			`sum or combine across them, and do not ask the user which one first. The ` +
			`${ties.length} alternative(s) are almost certainly other branches/locations ` +
			`of the same company: name them (by displayName) in the answer, beside the one used, ` +
			`so the user can ask for another one or for all combined.`;
	}

	const entityMap: Record<string, any> = {};
	for (const r of conceptSide.results) {
		if (r.matched) entityMap[r.matched] = r.resolution;
	}

	// AUTO-ATTACH the map for every type a mention actually resolved to.
	//
	// A resolved hit carries entityType + instanceId + displayName but NOT the
	// table/column, so a caller that did not also name the type got an id it
	// could not write a WHERE clause for — and only got the mapping by having
	// remembered to ask for a precondition it cannot see. Deliver it instead.
	//
	// Explicitly-requested entries win: a deliberate ask may carry scope detail
	// the auto-attached copy does not.
	const resolvedTypes = new Set(resolved.map(r => r.entityType).filter(Boolean));
	if (resolvedTypes.size) {
		try {
			// One query over a table of a few dozen rows, and only when something
			// resolved — cheaper than a per-type lookup.
			for (const t of (await getEntityTypes()).data as Array<any>) {
				if (resolvedTypes.has(t.entityType) && !(t.entityType in entityMap)) {
					entityMap[t.entityType] = t.resolution;
				}
			}
		} catch (err) {
			// Non-blocking: the ids are still correct and usable without the map.
			console.warn(`[ENTITY-SEARCH] auto-attach of resolved-type maps failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const unresolved = valueSide.filter(v => !v.resolved).map(v => v.mention);

	// Unindexed (§ 2.1) does not mean unlocatable — where these live IS known.
	// Two routes, differing only in how the entity type is established: the
	// question named it, or a regex reads it off the value's shape.
	const unresolvedSet = new Set(unresolved);

	// Shape first: it is evidence, whereas a caller's label is a guess.
	const byShape = unresolved.length ? await recognizePatterns(unresolved) : [];
	const shapeTypes = new Map<string, Set<string>>();
	for (const r of byShape) {
		if (!shapeTypes.has(r.mention)) shapeTypes.set(r.mention, new Set());
		shapeTypes.get(r.mention)!.add(r.entityType);
	}

	// A label can arrive on the mention or as a bare entityTypes entry beside it
	// ("gcn no" + "1020139859"); both are the question naming the type.
	const typedPairs: Array<{ text: string; entityType: string }> = [];
	for (const v of valueSide) {
		if (v.resolved) continue;
		const types = v.requestedType ? [v.requestedType] : matchedConceptTypes;
		for (const t of types) typedPairs.push({ text: v.mention, entityType: t });
	}

	// Reuse conceptSide's lookups — keyed by `requested`, which is what a
	// mention's label is compared against.
	const knownConcepts = new Map<string, { matched: string; resolution: Record<string, any> }>();
	for (const r of conceptSide.results as Array<any>) {
		if (r.matched && r.resolution) knownConcepts.set(r.requested, { matched: r.matched, resolution: r.resolution });
	}
	// A label PICKS AMONG shape-consistent candidates; it cannot introduce one
	// the shape rules out. "gcn no" separates the identical gcn/cchs shapes;
	// "invoice" on a booking-invoice value is a wrong guess and loses.
	// Filtered after locateByEntityType so the comparison uses canonical names.
	const typed = (await locateByEntityType(typedPairs, knownConcepts)).filter(t => {
		const shaped = shapeTypes.get(t.mention);
		if (!shaped?.size || shaped.has(t.entityType)) return true;
		console.log(`[ENTITY-SEARCH] "${t.mention}" labelled "${t.entityType}" but its shape says ${[...shaped].map(s => `"${s}"`).join(' / ')} — trusting the shape, dropping the label`);
		return false;
	});

	// Where the label survived it is the more specific answer, so it replaces
	// the shape hits for that mention rather than sitting alongside them.
	const typedMentions = new Set(typed.map(t => t.mention));
	const recognized = [...typed, ...byShape.filter(r => !typedMentions.has(r.mention))]
		.filter(r => unresolvedSet.has(r.mention));
	const unmatchedEntityTypes = conceptSide.results
		.filter(r => !r.matched)
		.map(r => ({ requested: r.requested, candidates: r.candidates }));

	// THIS is what actually reaches the LLM as the resolve_entities tool
	// result (JSON.stringify'd by handleResolveEntities in main-agent.ts) —
	// logged in full so a bad call is visible here, not just inferred from
	// what the model does three steps later.
	console.log(`[ENTITY-SEARCH] resolveEntities() → SENDING TO LLM: ${resolved.length} resolved, ${unresolved.length} unresolved, ${Object.keys(entityMap).length} concept(s) matched`);
	if (resolved.length) {
		console.log('  resolved:');
		for (const r of resolved) {
			console.log(`    "${r.mention}" → entityType="${r.entityType}" instanceId=${r.instanceId} (displayName="${r.displayName}", score=${r.score}${r.ambiguous ? ', AMBIGUOUS' : ''})`);
		}
	}
	if (unresolved.length) console.log(`  unresolved: ${unresolved.map(u => `"${u}"`).join(', ')}`);
	if (recognized.length) {
		console.log('  recognised by pattern (not indexed, but locatable):');
		for (const r of recognized) console.log(`    "${r.mention}" → ${r.entityType}${r.field ? ` @ ${r.field}` : ''}`);
	}
	if (Object.keys(entityMap).length) console.log(`  entityMap concepts matched: ${Object.keys(entityMap).map(k => `"${k}"`).join(', ')}`);
	if (unmatchedEntityTypes.length) console.log(`  entityTypes NOT matched: ${unmatchedEntityTypes.map(u => `"${u.requested}"`).join(', ')}`);

	// SELF-EVIDENTLY BROKEN CALL — entityTypes matched a concept that IS
	// indexed (has real instances to resolve to), but mentions was empty, so
	// nothing was ever looked up against it. Gated on `indexed === true`
	// specifically: ~30 of the 45 catalog concepts (booking amount, gcn
	// date, ...) are deliberately mapping-only with no instances at all —
	// "entityTypes: ['booking amount'], mentions: []" is the CORRECT shape
	// for those, not a bug, so this must never fire for them.
	// Confirmed real failure case (recurs non-deterministically — same
	// prompt, same model, sometimes sends mentions and sometimes doesn't): a
	// question ending "...and charge head name as a column" caused
	// entityTypes: ["deduction name"], mentions: [] — the literal catalog
	// term appearing in the question (as a column-label request, not
	// something to resolve) seems to short-circuit mention-extraction for
	// the OTHER real values in the same question ("field allowance",
	// "conveyance", ...). A prompt reminder alone didn't reliably prevent
	// this; flag it in the response itself — the one place already
	// guaranteed the caller's attention — rather than only in a console log
	// nobody reads.
	const indexedTypesWithNoMentions = Object.entries(entityMap)
		.filter(([, res]: [string, any]) => res?.indexed === true)
		.map(([type]) => type);
	const warning = (mentions.length === 0 && indexedTypesWithNoMentions.length > 0)
		? `entityTypes named ${indexedTypesWithNoMentions.map(t => `"${t}"`).join(', ')} — which ${indexedTypesWithNoMentions.length > 1 ? 'are' : 'is'} indexed — but mentions was empty, so nothing was resolved. If the question names specific values, pass each as a mention with its entityType and call resolve_entities again.`
		: undefined;
	if (warning) console.log(`  WARNING: ${warning}`);

	return {
		success: true,
		resolved,
		unresolved,
		// Kept SEPARATE from `unresolved` rather than reshaping it: callers
		// already treat unresolved as a string[] (the dispatch block, the replay
		// guard), and a mention being locatable does not make it resolved.
		recognized,
		entityMap,
		unmatchedEntityTypes,
		...(warning ? { warning } : {}),
	};
}

// ============================================================================
// Stats
// ============================================================================

export async function stats() {
	const res: any = await db.execute(sql`
		SELECT t.entity_type AS "entityType",
		       COUNT(v.id)::int                                        AS "values",
		       COUNT(DISTINCT v.instance_id)::int                      AS "instances",
		       COUNT(*) FILTER (WHERE v.value_kind = 'name')::int      AS "names",
		       COUNT(*) FILTER (WHERE v.value_kind = 'code')::int      AS "codes",
		       MAX(v.updated_at)                                       AS "lastIndexedAt"
		FROM search_entity_types t
		LEFT JOIN search_values v ON v.entity_type = t.entity_type
		GROUP BY t.entity_type
		ORDER BY t.entity_type
	`);

	const totals: any = await db.execute(sql`
		SELECT COUNT(*)::int AS "totalValues",
		       pg_size_pretty(pg_total_relation_size('search_values')) AS "indexSize"
		FROM search_values
	`);

	return { success: true, byEntity: res.rows, ...totals.rows[0] };
}

/**
 * How many values of each entity type match a term, with a few examples.
 *
 * `resolve` answers "which entity is this?" with a capped, ranked list; this
 * answers "how much is there?", which is the difference between "here are 5
 * hits" and "31 customers match this — narrow it". Same tiers as resolve so a
 * count can never disagree with what resolve would return.
 */
export async function countMatchesByType(params: {
	term: string;
	examplesPerType?: number;
}): Promise<Array<{ entityType: string; matches: number; examples: Array<{ instanceId: string; displayName: string }> }>> {
	const { term, examplesPerType = 3 } = params;
	const q = (term ?? '').trim().toLowerCase();
	if (!q) return [];
	const { norm, squashed } = normalizeValue(q);

	const res: any = await db.execute(sql`
		WITH matched AS (
			SELECT entity_type, instance_id, value,
			       ROW_NUMBER() OVER (PARTITION BY entity_type ORDER BY length(value), value) AS rn,
			       COUNT(*) OVER (PARTITION BY entity_type) AS matches
			FROM (
				SELECT DISTINCT entity_type, instance_id, value
				FROM search_values
				WHERE lower(value) = ${q}
				   OR value_norm = ${norm}
				   OR value_squashed LIKE ${'%' + squashed + '%'}
				   OR lower(value) LIKE ${'%' + q + '%'}
			) hits
		)
		SELECT entity_type AS "entityType", matches::int AS matches, instance_id AS "instanceId", value AS "displayName"
		FROM matched WHERE rn <= ${Math.max(1, examplesPerType)}
		ORDER BY matches DESC, entity_type, rn
	`);

	const byType = new Map<string, { entityType: string; matches: number; examples: Array<{ instanceId: string; displayName: string }> }>();
	for (const r of res.rows as any[]) {
		if (!byType.has(r.entityType)) byType.set(r.entityType, { entityType: r.entityType, matches: r.matches, examples: [] });
		byType.get(r.entityType)!.examples.push({ instanceId: r.instanceId, displayName: r.displayName });
	}
	return [...byType.values()];
}

/**
 * One entity's stored values by id — what to show once the agent has chosen it,
 * plus the other records carrying the same name, which is the ambiguity it must
 * not silently collapse.
 */
export async function getEntityById(params: {
	entityType: string;
	instanceId: string;
}): Promise<{ instanceId: string; entityType: string; values: Array<{ value: string; kind: string; attrs: Record<string, any> }>; sameNameIds: string[] } | null> {
	const { entityType, instanceId } = params;
	const res: any = await db.execute(sql`
		SELECT value, value_kind AS "kind", attrs
		FROM search_values
		WHERE entity_type = ${entityType} AND instance_id = ${instanceId}
		ORDER BY CASE value_kind WHEN 'name' THEN 0 WHEN 'code' THEN 1 ELSE 2 END, length(value)
	`);
	if (!res.rows.length) return null;

	const name = res.rows.find((r: any) => r.kind === 'name')?.value ?? res.rows[0].value;
	const same: any = await db.execute(sql`
		SELECT DISTINCT instance_id AS "instanceId" FROM search_values
		WHERE entity_type = ${entityType} AND lower(value) = ${String(name).toLowerCase()} AND instance_id <> ${instanceId}
		ORDER BY instance_id LIMIT 25
	`);
	return {
		instanceId, entityType,
		values: res.rows as any[],
		sameNameIds: (same.rows as any[]).map(r => r.instanceId),
	};
}
