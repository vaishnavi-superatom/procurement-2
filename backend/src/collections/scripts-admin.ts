import { transform } from 'esbuild';
import * as scriptRecipesService from '../../../database/postgres/src/project-data-db/script-recipes';
import type { CollectionContext } from './types';
import { ScriptStore, normalizeScriptBody } from '@superatomai/sdk-node';
import { scriptRecipeStore } from './script-recipes';

/**
 * scripts-admin collection — the ADMIN-facing view of the script flow.
 *
 * Distinct from the internal `script-recipes` collection (which is the SDK's
 * persistence contract and is called with positional args by the SDK's own
 * ScriptStore). This one is UI-facing: the admin app calls it via
 * `client.requestData({ collection: 'scripts-admin', operation, params })` with
 * a single named-params object, to LIST / VIEW / EDIT / DELETE the recipes the
 * agent has authored.
 *
 * A script is stored in two places (see ScriptStore): metadata in Postgres
 * (`script_recipes`) and the executable body on disk at
 * `scripts-store/<file_base>.ts`. We route every read/write through a
 * `ScriptStore` so both stay consistent — editing the body rewrites the file
 * AND recomputes `body_hash`; deleting removes the row AND the file.
 *
 * IMPORTANT: edits are LIVE. The matcher re-reads the row (matching) and the
 * runner re-reads the file (execution) on the very next question — there is no
 * cache in between. Only `status = 'verified'` rows under the failure-rate
 * guard are matched, so toggling status to 'draft' effectively disables a
 * script without deleting it.
 */

/**
 * A ScriptStore with NO projectId — so `save()` preserves each row's existing
 * project scope (project-scoped rows keep their id; single-VM project-less rows
 * stay project-less) instead of re-stamping the caller's projectId. Matches the
 * script-dataset regen path in external-tools.ts. The on-disk base dir defaults
 * to `<cwd>/scripts-store`, which is where the running backend authors bodies.
 */
function adminStore(): ScriptStore {
	return new ScriptStore({ store: scriptRecipeStore });
}

/**
 * Attach derived health fields (mirrors the matcher's healthy-verified rule).
 * Used for BOTH `list` rows and the single `get` recipe, so the UI's health
 * badge is consistent whether you're looking at the list or the detail view.
 */
function withHealth<T extends { status?: string; successCount?: number; failureCount?: number }>(o: T) {
	const successCount = o.successCount || 0;
	const failureCount = o.failureCount || 0;
	const runs = successCount + failureCount;
	const failureRate = runs > 0 ? failureCount / runs : 0;
	// The matcher only considers verified rows that are under the failure-rate
	// threshold OR have too few runs to judge (see healthyVerified()).
	const matchable = o.status === 'verified' && (runs < 5 || failureRate <= 0.2);
	return { ...o, runs, failureRate, matchable };
}

/**
 * Compile-check a body before persisting it. A body that throws at compile time
 * would break the live flow, so we reject it. Uses esbuild (already a backend
 * dep, and what tsx uses under the hood) to catch TS/syntax errors, and checks
 * that `getData` is present (normalizeScriptBody guarantees it gets exported).
 */
async function validateBody(scriptBody: string): Promise<{ valid: boolean; error?: string }> {
	if (typeof scriptBody !== 'string' || !scriptBody.trim()) {
		return { valid: false, error: 'Script body is empty.' };
	}
	const normalized = normalizeScriptBody(scriptBody);
	if (!/\bgetData\b/.test(normalized)) {
		return { valid: false, error: 'Script must define a `getData(ctx, params)` function.' };
	}
	try {
		await transform(normalized, { loader: 'ts', format: 'esm' });
		return { valid: true };
	} catch (err: any) {
		const msg = err?.errors?.length
			? err.errors
				.map((e: any) => `${e.text}${e.location ? ` (line ${e.location.line})` : ''}`)
				.join('; ')
			: err?.message || String(err);
		return { valid: false, error: `Compile error: ${msg}` };
	}
}

/**
 * Register the admin-facing scripts collection.
 */
export async function registerScriptsAdminCollections({ sdk }: CollectionContext): Promise<void> {
	// LIST — every recipe in this backend's DB (any status/health), with derived health.
	// The script_recipes table lives in PROJECT_DATABASE_URL — one DB per deployment,
	// i.e. a single project — so there is nothing to scope by. We intentionally ignore
	// any projectId: recipes are stamped with a SOURCE-DERIVED id (from the source tool
	// id, e.g. `postgres-722b94971107_query` → `722b94971107`), which is NOT the platform
	// project UUID the admin UI knows, so scoping by the UI's id would always return empty.
	sdk.addCollection('scripts-admin', 'list', async () => {
		const rows = await scriptRecipesService.listScriptRecipes();
		return { success: true, scripts: rows.map(withHealth) };
	});

	// GET — one recipe with its on-disk body loaded (for the editor).
	sdk.addCollection('scripts-admin', 'get', async (params: any) => {
		const id = params?.id;
		if (!id) throw new Error('scripts-admin.get: id required');
		const recipe = await adminStore().get(id);
		if (!recipe) return { success: false, error: `Script '${id}' not found` };
		return { success: true, recipe: withHealth(recipe) };
	});

	// VALIDATE — compile-check a body WITHOUT saving (editor "Check" button).
	sdk.addCollection('scripts-admin', 'validate', async (params: any) => {
		return validateBody(params?.scriptBody ?? '');
	});

	// UPDATE BODY — compile-check, then rewrite the file + recompute body_hash + upsert.
	sdk.addCollection('scripts-admin', 'updateBody', async (params: any) => {
		const { id, scriptBody } = params || {};
		if (!id) throw new Error('scripts-admin.updateBody: id required');
		const check = await validateBody(scriptBody);
		if (!check.valid) return { success: false, error: check.error };

		const store = adminStore();
		const recipe = await store.get(id);
		if (!recipe) return { success: false, error: `Script '${id}' not found` };

		recipe.scriptBody = scriptBody;
		recipe.bodyHash = undefined; // force save() to normalize, rehash and rewrite the file
		await store.save(recipe);
		const updated = await store.get(id);
		return { success: true, recipe: updated ? withHealth(updated) : updated };
	});

	// UPDATE META — patch matching/presentation metadata. Editing name/intent/tags
	// re-tunes FTS matching; editing parameters changes what the runner binds;
	// toggling status enables/disables matching.
	sdk.addCollection('scripts-admin', 'updateMeta', async (params: any) => {
		const { id, patch } = params || {};
		if (!id) throw new Error('scripts-admin.updateMeta: id required');
		const store = adminStore();
		const recipe = await store.get(id);
		if (!recipe) return { success: false, error: `Script '${id}' not found` };

		if (typeof patch?.name === 'string') recipe.name = patch.name;
		if (typeof patch?.intentDescription === 'string') recipe.intentDescription = patch.intentDescription;
		if (Array.isArray(patch?.tags)) recipe.tags = patch.tags;
		if (Array.isArray(patch?.parameters)) recipe.parameters = patch.parameters;
		if (patch?.status === 'draft' || patch?.status === 'verified') recipe.status = patch.status;

		await store.save(recipe);
		const updated = await store.get(id);
		return { success: true, recipe: updated ? withHealth(updated) : updated };
	});

	// RESET STATS — clear success/failure counters + lastError (re-enable a fixed script).
	sdk.addCollection('scripts-admin', 'resetStats', async (params: any) => {
		const id = params?.id;
		if (!id) throw new Error('scripts-admin.resetStats: id required');
		await scriptRecipesService.resetScriptRecipeStats(id);
		return { success: true };
	});

	// DELETE — remove the row AND the on-disk body.
	sdk.addCollection('scripts-admin', 'remove', async (params: any) => {
		const id = params?.id;
		if (!id) throw new Error('scripts-admin.remove: id required');
		await adminStore().delete(id);
		return { success: true };
	});

	console.log('✓ scripts-admin collection registered');
}
