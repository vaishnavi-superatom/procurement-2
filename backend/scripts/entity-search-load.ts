/**
 * Load a prepared entity map + sample-value dump into the entity search engine.
 *
 * The authored files live in backend/entity-store/ (scripts/ holds only tooling).
 * Paths are resolved against the CWD, so run these from backend/:
 *
 *   pnpm tsx scripts/entity-search-load.ts --map entity-store/entity_map.json --values entity-store/entity_sample_values.json
 *   pnpm tsx scripts/entity-search-load.ts ... --dry-run      # report, write nothing
 *   pnpm tsx scripts/entity-search-load.ts ... --only branch  # one entity type, no wipe
 *   pnpm tsx scripts/entity-search-load.ts ... --only "branch name,state name"  # several, comma-separated
 *   pnpm tsx scripts/entity-search-load.ts --stats            # what is loaded now
 *
 * A load REPLACES the store: existing entity types and values are cleared first,
 * so the files are the whole truth rather than a patch on top of whatever was
 * there. (--only skips the wipe, being an explicit partial load.)
 *
 * The loader is deliberately DUMB: it loads what the files contain. Every entity
 * in the map file becomes a concept; every entity whose samples carry an id gets
 * its values indexed. It holds no per-client list of what "should" be indexed —
 * that decision belongs to whoever produces the dump, and a hardcoded list here
 * silently skipped a whole client's entities once because their names differed.
 *
 * The contract the files must honour (backend/docs/ENTITY-SEARCH-DESIGN.md § 2.1):
 * the VALUES file carries bounded master data only — the names and codes a user
 * says out loud. Transaction attributes (`amount`, `gcn no`, `gcn date`) must
 * stay out of it: they grow forever and resolve to nothing anybody asks for.
 * They still belong in the MAP file, which records where they live.
 */

import dotenv from 'dotenv';
import { resolve as pathResolve } from 'path';
import { readFileSync } from 'fs';
import {
	upsertEntityType, indexValues, stats, getEntityCatalog, clearAllEntityTypes,
	type IndexValueInput, type ValueKind,
} from '../../database/postgres/src/project-data-db/entity-search';

dotenv.config({ path: pathResolve(__dirname, '../.env') });

const args = process.argv.slice(2);
const argVal = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
const dryRun = args.includes('--dry-run');
// Comma-separated so one call can safely refresh a related group (e.g. the
// four location entity types) without a full wipe touching everything else
// another entity type's maintainer is responsible for. A single name still
// works exactly as before -- splitting a string with no comma just yields
// a 1-item array.
const onlyList = argVal('--only')?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const statsOnly = args.includes('--stats');
const mapFile = argVal('--map');
const valuesFile = argVal('--values');

// `entity_type` is canonical — it matches the values file and the DB column.
// `entity` is accepted because the map file currently uses it; keeping both
// tolerated means the two files can be aligned without a lockstep change.
//
// `synonyms` feeds resolveEntityTypes' matching (entity_type + gloss + synonyms[],
// exact hit on any scores 1.00), so a paraphrased concept name is not dropped as unmatched.
interface MapEntry { entity?: string; entity_type?: string; mapped_to: string; synonyms?: string[] }
const conceptName = (m: MapEntry) => (m.entity_type ?? m.entity ?? '').trim();
interface ValueEntry {
	entity_type: string;
	id_field?: string;
	value_field?: string;
	row_count?: number;       // rows available at source
	full_dump?: boolean;      // true when sample_values is the COMPLETE set
	total_count?: number;     // legacy name for row_count
	indexed?: boolean;        // the dump's OWN verdict, overrides the structural one
	not_indexed_because?: string;
	note?: string;            // free prose from the dump, e.g. coverage caveats
	sample_values: any[];
}

/**
 * Count columns a dump may carry (booking_count, usage_count, ...) are deliberately NOT
 * copied into attrs: they are a snapshot from when the dump was made, and surfaced on a
 * resolve hit they read as current. A live count must come from a query at answer time.
 */
const COUNT_KEYS: string[] = [];

/**
 * Indexable == the samples carry an id to resolve TO. That is a STRUCTURAL fact
 * about the dump, not a judgement about the entity: a value with no id cannot be
 * resolved to anything, whatever it represents.
 *
 * WHAT BELONGS IN THE DUMP IS THE DUMP'S RESPONSIBILITY. This loader indexes
 * every entity that has ids, so a file that includes transaction attributes
 * (`amount` as {id, value:56250}, `gcn date`, `gcn no`) will index those too —
 * unbounded rows that mirror the source database and answer nothing, since
 * nobody looks up "which entity is 56250?". Keep such entities out of the values
 * file; they belong in the entity map, which records where they live instead.
 * See backend/docs/ENTITY-SEARCH-DESIGN.md § 2.1.
 */
function isIndexable(e: ValueEntry): boolean {
	// An explicit `indexed: false` is the dump SAYING so, which outranks anything
	// inferred from the sample shape — same principle as above, just stated
	// directly instead of implied by leaving the ids out.
	if (e.indexed === false) return false;
	const first = (e.sample_values || []).find(s => s !== null && s !== undefined);
	return !!first && typeof first === 'object' && !Array.isArray(first)
		&& 'id' in first && 'value' in first;
}

/** Why a non-indexable entity was skipped — printed so the split is auditable. */
function skipReason(e: ValueEntry): string {
	if (e.indexed === false) return e.not_indexed_because || 'dump declares indexed: false';
	const first = (e.sample_values || [])[0];
	if (first === undefined) return 'no sample values';
	if (typeof first !== 'object') return `bare ${typeof first} values — no id to resolve to`;
	if (Array.isArray(first)) return 'array samples — expected objects';
	return `object without id+value (keys: ${Object.keys(first).slice(0, 4).join(',')})`;
}

function toValues(e: ValueEntry): IndexValueInput[] {
	const out: IndexValueInput[] = [];
	for (const s of e.sample_values || []) {
		if (!s || typeof s !== 'object' || s.id === null || s.id === undefined) continue;
		const attrs: Record<string, any> = {};
		if (s.code != null && s.code !== '') attrs.code = String(s.code);
		for (const k of COUNT_KEYS) if (s[k] != null) attrs[k] = s[k];
		if (s.vehicle_type_id != null) attrs.vehicleTypeId = s.vehicle_type_id;
		// service network name: which branch controls it, and whether it's live.
		// Not scopeSql/stateId-type fields -- those are COMPUTED (a live join +
		// name-matching against com_mst_city), not static dump data, so they stay
		// out of this loader entirely and get enriched afterward by
		// scripts/index-location-hierarchy.ts. This is just a straight copy.
		if (s.controlling_location_id != null) attrs.controllingLocationId = s.controlling_location_id;
		if (s.active != null) attrs.active = s.active;
		if (s.title != null && s.title !== '') attrs.title = String(s.title);

		const push = (value: any, kind: ValueKind) => {
			const v = String(value ?? '').trim();
			if (v) out.push({ instanceId: String(s.id), value: v, valueKind: kind, attrs });
		};
		push(s.value, 'name');
		// A code is bounded master data too, and users paste codes ("C000163").
		if (s.code != null && String(s.code).trim() && String(s.code) !== String(s.value)) {
			push(s.code, 'code');
		}
	}
	return out;
}

async function main() {
	if (statsOnly) {
		const s: any = await stats();
		console.table(s.byEntity.filter((r: any) => r.values > 0));
		console.log(`total values: ${s.totalValues} | table size: ${s.indexSize}`);
		const cat = await getEntityCatalog();
		console.log(`entity map: ${cat.count} type(s)`);
		process.exit(0);
	}

	if (!mapFile || !valuesFile) {
		console.error('Usage: --map <entity_map.json> --values <entity_sample_values.json> [--dry-run] [--only <entityType>]');
		process.exit(1);
	}

	const mapEntries: MapEntry[] = JSON.parse(readFileSync(pathResolve(mapFile), 'utf-8'));
	const valueEntries: ValueEntry[] = JSON.parse(readFileSync(pathResolve(valuesFile), 'utf-8'));
	const byType = new Map(valueEntries.map(v => [v.entity_type, v]));

	console.log(`\nentity map file : ${mapEntries.length} concepts`);
	console.log(`values file     : ${valueEntries.length} entries`);
	console.log(`target          : ${process.env.PROJECT_DATABASE_URL?.split('/').pop()?.split('?')[0]}`);
	if (dryRun) console.log('DRY RUN — no writes');

	// A load is AUTHORITATIVE: the files define the whole store. Without clearing,
	// a dump that renames concepts leaves both generations resident and every
	// instance resolves twice — reported as ambiguity from data that is not
	// ambiguous. Skipped for --only, which is deliberately a partial load.
	if (!dryRun && !onlyList) {
		const cleared = await clearAllEntityTypes();
		if (cleared.deleted) console.log(`cleared ${cleared.deleted} existing entity type(s) and their values — the files are authoritative`);
	} else if (onlyList) {
		console.log(`--only ${onlyList.join(', ')}: partial load, existing entity types left intact`);
	}

	let mapped = 0, indexedTypes = 0, indexedValues = 0;
	const skipped: Array<[string, string]> = [];

	for (const m of mapEntries) {
		const name = conceptName(m);
		if (!name) { skipped.push(['(unnamed entry)', 'map entry has neither entity_type nor entity']); continue; }
		if (onlyList && !onlyList.includes(name)) continue;
		const v = byType.get(name);
		const indexable = v ? isIndexable(v) : false;

		// `mapping` is stored VERBATIM, never parsed into table/column fields.
		// Several entries are irreducibly prose — `amount` is "different column
		// per entity it's paired with", `route` spends 380 chars on spelling
		// traps. That guidance IS the value, and it is written for an LLM to
		// read. Presentation (full text vs truncated in the catalog) is decided
		// at render time, so it can change without touching stored data.
		const resolution: Record<string, any> = {
			mapping: m.mapped_to,
			// From the VALUES file — already structured there, not parsed out of prose.
			idField: v?.id_field,
			valueField: v?.value_field,
			indexed: indexable,
		};
		// Alternate phrasings of the concept name; see MapEntry.
		if (Array.isArray(m.synonyms) && m.synonyms.length) {
			resolution.synonyms = m.synonyms.map(s => String(s).trim()).filter(Boolean);
		}
		// Coverage caveats the dump wrote for a reader ("recent 6,720 of 688,344
		// true total"). Carried through untouched — it is written for the agent.
		if (v?.note) resolution.note = v.note;
		// 7 of the 9 indexed types are SAMPLES, not complete sets (customer ships
		// 500 of ~186k parties). Without this a reader cannot tell a full index
		// from a partial one — and "not found" means very different things.
		// Records whether the index holds the COMPLETE set. Without it, an
		// unresolved name is ambiguous: genuinely absent, or merely not dumped?
		const rowCount = v?.row_count ?? v?.total_count;
		if (rowCount) resolution.rowCount = rowCount;
		if (v && indexable) {
			resolution.indexedCount = v.sample_values.length;
			resolution.complete = v.full_dump === true || (!!rowCount && rowCount === v.sample_values.length);
		}
		// Make the scope rule self-documenting for whoever reads a row later.
		if (!indexable && v) resolution.notIndexedBecause = skipReason(v);

		if (!dryRun) await upsertEntityType({ entityType: name, resolution });
		mapped++;

		if (!v) { skipped.push([name, 'no entry in values file']); continue; }
		if (!indexable) { skipped.push([name, skipReason(v)]); continue; }

		const values = toValues(v);
		if (!dryRun && values.length) {
			await indexValues({ entityType: name, values, replace: true });
		}
		indexedTypes++; indexedValues += values.length;
		const rc = v.row_count ?? v.total_count;
		const complete = v.full_dump === true || (!!rc && rc === v.sample_values.length);
		const note = rc ? `${rc} at source${complete ? ', COMPLETE' : ' — PARTIAL'}` : 'coverage unknown';
		console.log(`  INDEX  ${name.padEnd(30)} ${String(values.length).padStart(5)} values from ${v.sample_values.length} rows (${note})`);
	}

	console.log(`\n  SKIPPED (entity map only — no resolvable id):`);
	for (const [name, why] of skipped) console.log(`         ${name.padEnd(30)} ${why}`);

	console.log(`\nentity map : ${mapped} concepts`);
	console.log(`value index: ${indexedTypes} types, ${indexedValues} values`);

	if (!dryRun) {
		const s: any = await stats();
		console.log(`verified   : ${s.totalValues} rows in search_values (${s.indexSize})`);
	}
	process.exit(0);
}

main().catch(err => {
	// drizzle puts the full SQL + params dump in err.message itself (huge, not
	// the reason) — the actual driver error (code/detail/real cause) is on
	// err.cause and was previously being silently dropped here.
	console.error('\nError:', err.cause?.message ?? err.message);
	if (err.cause) {
		const { code, detail, hint, column, table, constraint } = err.cause;
		console.error({ code, detail, hint, column, table, constraint });
	}
	process.exit(1);
});
