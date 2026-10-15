/**
 * Load entity-store/concepts.json into the concepts table.
 *
 *   pnpm tsx scripts/concepts-load.ts
 *   pnpm tsx scripts/concepts-load.ts --dry-run   # report, write nothing
 *   pnpm tsx scripts/concepts-load.ts --stats     # what is loaded now
 *
 * A load REPLACES the store — clearAllConcepts() runs first, so the file is
 * the whole truth rather than a patch. After loading, runs findDanglingRequires()
 * so a typo'd `requires` edge (a dependency that silently never gets injected)
 * is caught here, not discovered later at answer time.
 */

import dotenv from 'dotenv';
import { resolve as pathResolve } from 'path';
import { readFileSync } from 'fs';
import {
	createConcept, clearAllConcepts, findDanglingRequires, conceptStats, setConceptVerified,
	type CreateConceptParams,
} from '../../database/postgres/src/project-data-db/concepts';

dotenv.config({ path: pathResolve(__dirname, '../.env') });

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const statsOnly = args.includes('--stats');

interface ConceptEntry {
	name: string;
	kind?: string;
	body: string;
	requires?: string[];
	returns?: Record<string, any>;
	aliases?: string[];
	/** One line: what this concept is for. Shown beside every search hit. */
	description?: string;
}

async function main() {
	if (statsOnly) {
		const s = await conceptStats();
		console.table(s.byKind);
		console.log(`total: ${s.total}`);
		const dangling = await findDanglingRequires();
		if (dangling.count) {
			console.log(`\nDANGLING REQUIRES (${dangling.count}):`);
			for (const d of dangling.data) console.log(`  ${d.concept} → '${d.missing}' (not found)`);
		}
		process.exit(0);
	}

	// Authored data lives in backend/entity-store/; scripts/ holds only tooling.
	const file = pathResolve(__dirname, '../entity-store/concepts.json');
	const entries: ConceptEntry[] = JSON.parse(readFileSync(file, 'utf-8'));

	// Every concept carries its own description — find-concept searches it
	// alongside name and alias, so one without it is much harder to retrieve.
	const undescribed = entries.filter(e => !e.description?.trim()).map(e => e.name);
	if (undescribed.length) console.warn(`WARNING: ${undescribed.length} concept(s) have no description: ${undescribed.join(', ')}`);

	console.log(`concepts file: ${entries.length} concept(s)`);
	console.log(`target       : ${process.env.PROJECT_DATABASE_URL?.split('/').pop()?.split('?')[0]}`);
	if (dryRun) console.log('DRY RUN — no writes');

	if (!dryRun) {
		const cleared = await clearAllConcepts();
		if (cleared.deleted) console.log(`cleared ${cleared.deleted} existing concept(s) — the file is authoritative`);
	}

	let created = 0;
	for (const e of entries) {
		const params: CreateConceptParams = {
			name: e.name,
			body: e.body,
			kind: (e.kind as any) ?? 'definition',
			requires: e.requires ?? [],
			returns: e.returns ?? {},
			aliases: e.aliases ?? [],
			// Descriptions live in their own file keyed by name, so replacing
			// concepts.json wholesale (how it is usually revised) cannot drop them.
			description: e.description ?? null,
			origin: 'knowledge_node',
		};
		if (!dryRun) {
			// This file is human-authored/reviewed truth, not an agent proposal —
			// unlike concept-builder.ts (which deliberately leaves verified false
			// for a human to review), a load from here should land verified
			// immediately or every concept shows up as pending in the UI.
			const result = await createConcept(params);
			await setConceptVerified(result.data.id, true);
		}
		created++;
		const req = e.requires?.length ? ` requires:[${e.requires.join(', ')}]` : '';
		const aka = e.aliases?.length ? ` aka:[${e.aliases.join(', ')}]` : '';
		console.log(`  ${dryRun ? 'WOULD CREATE' : 'CREATED'}  [${(e.kind ?? 'definition').padEnd(10)}] ${e.name}${req}${aka}`);
	}

	console.log(`\n${created} concept(s) ${dryRun ? 'would be created' : 'created'}`);

	if (!dryRun) {
		const dangling = await findDanglingRequires();
		if (dangling.count) {
			console.log(`\nDANGLING REQUIRES (${dangling.count}) — these 'requires' names do not match any concept:`);
			for (const d of dangling.data) console.log(`  ${d.concept} → '${d.missing}'`);
		} else {
			console.log('no dangling requires — every dependency edge resolves');
		}
		const s = await conceptStats();
		console.log(`\nverified: ${s.total} concept(s) in store`);
		console.table(s.byKind);
	}

	process.exit(0);
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });
