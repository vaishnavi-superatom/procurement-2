/**
 * Script to delete on-disk script BODIES from backend/scripts-store/.
 *
 * Companion to database/postgres/scripts/delete-script-recipes.ts:
 *   - delete-script-recipes.ts  → removes the `script_recipes` rows (DB metadata).
 *   - delete-script-bodies.ts   → removes the executable `<fileBase>.ts` bodies
 *     on disk that those rows point to.
 * For a full reset (so re-asking a question regenerates fresh scripts) run BOTH.
 *
 * Only `*.ts` body files are removed. Anything prefixed with `_` (e.g. `_types.ts`)
 * is treated as infrastructure and skipped.
 *
 * Usage (run from the backend folder):
 *   pnpm tsx scripts/delete-script-bodies.ts                         # delete ALL bodies
 *   pnpm tsx scripts/delete-script-bodies.ts --dry-run               # preview only
 *   pnpm tsx scripts/delete-script-bodies.ts day-wise-jsw-vs-benchmark-wsp-rsp
 *                                                                    # delete specific body(ies)
 *   pnpm tsx scripts/delete-script-bodies.ts foo.ts bar --dry-run    # mix & match, with preview
 */

import * as fs from 'fs';
import * as path from 'path';

const STORE_DIR = process.env.SCRIPTS_STORE_DIR
	? path.resolve(process.env.SCRIPTS_STORE_DIR)
	: path.resolve(__dirname, '../scripts-store');

/** A body file is `<fileBase>.ts` and is NOT an `_`-prefixed infra file. */
function isBodyFile(name: string): boolean {
	return name.endsWith('.ts') && !name.startsWith('_');
}

/** Normalize a user-supplied target to a `<fileBase>.ts` filename. */
function toFileName(target: string): string {
	const base = path.basename(target).replace(/\.ts$/, '');
	return `${base}.ts`;
}

function deleteScriptBodies(targets: string[], dryRun = false): { found: number; deleted: number } {
	console.log(`🗑️  Starting script-bodies cleanup${dryRun ? ' (DRY RUN)' : ''}`);
	console.log(`   Store dir: ${STORE_DIR}\n`);

	if (!fs.existsSync(STORE_DIR)) {
		console.log(`ℹ️  Store dir does not exist. Nothing to delete.\n`);
		return { found: 0, deleted: 0 };
	}

	const allBodies = fs.readdirSync(STORE_DIR).filter(isBodyFile).sort();

	// Decide which files to act on: all bodies, or only the requested ones.
	let toDelete: string[];
	if (targets.length === 0) {
		toDelete = allBodies;
	} else {
		const requested = targets.map(toFileName);
		const present = new Set(allBodies);
		toDelete = requested.filter(f => present.has(f));
		const missing = requested.filter(f => !present.has(f));
		if (missing.length > 0) {
			console.log(`⚠️  ${missing.length} requested file(s) not found in store (skipped):`);
			missing.forEach(f => console.log(`     - ${f}`));
			console.log('');
		}
	}

	if (toDelete.length === 0) {
		console.log('ℹ️  No matching script bodies found. Nothing to delete.\n');
		return { found: allBodies.length, deleted: 0 };
	}

	// Show what will be deleted
	console.log(`📋 Bodies to be deleted (${toDelete.length} of ${allBodies.length} in store):`);
	console.log('─'.repeat(60));
	toDelete.forEach((f, i) => {
		const full = path.join(STORE_DIR, f);
		let sizeInfo = '';
		try {
			sizeInfo = ` (${fs.statSync(full).size} bytes)`;
		} catch {
			/* ignore */
		}
		console.log(`  ${i + 1}. ${f}${sizeInfo}`);
	});
	console.log('─'.repeat(60) + '\n');

	// Delete (unless dry run)
	let deletedCount = 0;
	if (dryRun) {
		console.log('🧪 Dry run — no files were deleted.\n');
	} else {
		console.log('📊 Deleting script bodies from disk...');
		for (const f of toDelete) {
			try {
				fs.unlinkSync(path.join(STORE_DIR, f));
				deletedCount++;
			} catch (err) {
				console.error(`   ✗ Failed to delete ${f}: ${err}`);
			}
		}
		console.log(`✓ Deleted ${deletedCount} file(s) from disk\n`);
	}

	// Summary
	console.log('═'.repeat(60));
	console.log(`✅ ${dryRun ? 'Dry run' : 'Cleanup'} completed successfully!`);
	console.log('═'.repeat(60));
	console.log(`   Bodies in store: ${allBodies.length}`);
	console.log(`   Bodies targeted: ${toDelete.length}`);
	console.log(`   Bodies deleted:  ${dryRun ? '0 (dry run)' : deletedCount}`);
	console.log(`   Note: DB recipe rows are NOT touched — run`);
	console.log(`         database/postgres/scripts/delete-script-recipes.ts for those.`);
	console.log('═'.repeat(60) + '\n');

	return { found: allBodies.length, deleted: deletedCount };
}

// Run the cleanup
if (require.main === module) {
	const args = process.argv.slice(2);
	const dryRun = args.includes('--dry-run');
	const targets = args.filter(a => !a.startsWith('--'));

	try {
		deleteScriptBodies(targets, dryRun);
		console.log('Done!');
		process.exit(0);
	} catch (error) {
		console.error('Fatal error:', error);
		process.exit(1);
	}
}

export { deleteScriptBodies };
