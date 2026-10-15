/**
 * Script to delete ALL script recipes from the local PostgreSQL database,
 * AND their executable bodies on disk.
 * - Deletes every row from the `script_recipes` table in the database that
 *   PROJECT_DATABASE_URL (database/postgres/.env) points to.
 * - There is no project-id argument: each local DB holds a single project,
 *   so the .env-configured database IS the project scope (same convention as
 *   delete-user-conversations.ts).
 * - Recipes are Postgres-only (FTS-backed) — there is NO ChromaDB collection
 *   to clean.
 * - For each deleted recipe, also deletes its body file at
 *   backend/scripts-store/<file_base>.ts. Files that don't exist are skipped
 *   silently (nothing to remove). Override the scripts-store location with
 *   SCRIPTS_STORE_DIR if it's not at the default `<repo>/backend/scripts-store`.
 *
 * Usage (run from the postgres folder):
 *   cd database/postgres
 *   tsx scripts/delete-script-recipes.ts            # delete all recipes + files
 *   tsx scripts/delete-script-recipes.ts --dry-run  # preview only, no delete
 */

// Load environment variables FIRST before any other imports
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load env from postgres folder (run script from postgres folder)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Now import modules that depend on env variables
import { db, schema } from '../src/project-data-db/drizzle-db';

const { scriptRecipes } = schema;

const SCRIPTS_STORE_DIR =
	process.env.SCRIPTS_STORE_DIR || path.resolve(__dirname, '../../../backend/scripts-store');

async function deleteScriptRecipes(dryRun = false) {
	console.log(`🗑️  Starting script-recipes cleanup${dryRun ? ' (DRY RUN)' : ''}\n`);

	try {
		// Step 1: Fetch the recipes (so we can show what will go)
		console.log('📊 Fetching script recipes from PostgreSQL...');
		const recipes = await db.select().from(scriptRecipes);

		console.log(`   Found ${recipes.length} recipe(s)\n`);

		if (recipes.length === 0) {
			console.log('ℹ️  No script recipes found. Nothing to delete.\n');
			return { found: 0, deleted: 0 };
		}

		// Step 2: Show what will be deleted
		console.log('📋 Recipes to be deleted:');
		console.log('─'.repeat(60));
		const byStatus: Record<string, number> = {};
		recipes.forEach((r: any, index: number) => {
			byStatus[r.status] = (byStatus[r.status] || 0) + 1;
			console.log(`  ${index + 1}. ${r.name}  [${r.status}]`);
			console.log(`     ID: ${r.id}`);
			console.log(`     Project: ${r.projectId ?? '(global)'}`);
			console.log(`     File base: ${r.fileBase}`);
			console.log(`     Success/Failure: ${r.successCount}/${r.failureCount}`);
			console.log('');
		});
		console.log('─'.repeat(60));
		console.log(`   By status: ${Object.entries(byStatus).map(([s, n]) => `${s}=${n}`).join(', ')}\n`);

		// Step 3: Delete (unless dry run)
		let deletedCount = 0;
		let filesDeleted = 0;
		let filesMissing = 0;
		if (dryRun) {
			console.log('🧪 Dry run — no rows or files were deleted.\n');
		} else {
			console.log('📊 Deleting script recipes from PostgreSQL...');
			const deleted = await db.delete(scriptRecipes).returning();
			deletedCount = deleted.length;
			console.log(`✓ Deleted ${deletedCount} record(s) from PostgreSQL\n`);

			console.log(`🗑️  Deleting script bodies from ${SCRIPTS_STORE_DIR}...`);
			for (const r of deleted as any[]) {
				if (!r.fileBase) continue;
				const filePath = path.join(SCRIPTS_STORE_DIR, `${r.fileBase}.ts`);
				try {
					fs.unlinkSync(filePath);
					filesDeleted++;
				} catch (error: any) {
					if (error.code === 'ENOENT') {
						filesMissing++;
					} else {
						console.warn(`   ⚠️  Could not delete ${filePath}: ${error.message}`);
					}
				}
			}
			console.log(`✓ Deleted ${filesDeleted} file(s)${filesMissing > 0 ? `, ${filesMissing} already missing` : ''}\n`);
		}

		// Summary
		console.log('═'.repeat(60));
		console.log(`✅ ${dryRun ? 'Dry run' : 'Cleanup'} completed successfully!`);
		console.log('═'.repeat(60));
		console.log(`   Recipes found: ${recipes.length}`);
		console.log(`   Recipes deleted: ${dryRun ? '0 (dry run)' : deletedCount}`);
		console.log(`   Script files deleted: ${dryRun ? '0 (dry run)' : filesDeleted}`);
		console.log('═'.repeat(60) + '\n');

		return { found: recipes.length, deleted: deletedCount, filesDeleted };
	} catch (error) {
		console.error('❌ Error during cleanup:', error);
		process.exit(1);
	}
}

// Run the cleanup
if (require.main === module) {
	const dryRun = process.argv.slice(2).includes('--dry-run');

	deleteScriptRecipes(dryRun)
		.then(() => {
			console.log('Done!');
			process.exit(0);
		})
		.catch((error) => {
			console.error('Fatal error:', error);
			process.exit(1);
		});
}

export { deleteScriptRecipes };
