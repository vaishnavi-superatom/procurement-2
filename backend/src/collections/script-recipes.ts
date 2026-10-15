import * as scriptRecipesService from '../../../database/postgres/src/project-data-db/script-recipes';
import type { CollectionContext } from './types';
import type { ScriptRecipeStore } from '@superatomai/sdk-node';

/**
 * Postgres-backed implementation of the SDK's `ScriptRecipeStore` interface.
 * Used both by the collection handlers below AND by the script-dataset
 * regeneration path in `external-tools.ts` (which constructs a `ScriptStore`
 * around this adapter to load + re-run a recipe). Single source of truth so the
 * two paths can't drift.
 */
export const scriptRecipeStore: ScriptRecipeStore = {
	search: (params) => scriptRecipesService.searchScriptRecipes(params) as any,
	getById: (id) => scriptRecipesService.getScriptRecipe(id) as any,
	count: (params) => scriptRecipesService.countScriptRecipes(params?.projectId),
	upsert: async (row) => { await scriptRecipesService.upsertScriptRecipe(row as any); },
	updateStats: (id, patch) => scriptRecipesService.updateScriptRecipeStats(id, patch),
	promote: (id, patch) => scriptRecipesService.promoteScriptRecipe(id, patch) as any,
	commitEdit: (id, patch) => scriptRecipesService.commitScriptRecipeEdit(id, patch) as any,
	recordDraftError: (id, err) => scriptRecipesService.recordScriptDraftError(id, err as any),
	remove: (id) => scriptRecipesService.deleteScriptRecipe(id),
	fileBaseTaken: (fileBase, excludeId, projectId) =>
		scriptRecipesService.fileBaseTaken(fileBase, projectId ?? null, excludeId),
};

/**
 * Script Recipes collection — Postgres-backed metadata store for the script flow.
 *
 * The SDK's `ScriptStore` consumes these handlers via
 * `collections['script-recipes'][operation](params)` (same mechanism as
 * `collections['conversation-history']['exactMatch']`). Matching is Postgres
 * full-text search (`search`) returning a ranked top-K shortlist; the LLM then
 * picks among them. The executable body stays on disk in the SDK.
 *
 * See backend/docs/SCRIPT-FLOW-SCALING-ISSUES.md (#1, #3, #7).
 */
export async function registerScriptRecipesCollections({ sdk }: CollectionContext): Promise<void> {
	// FTS shortlist — the top-K matching scripts for a user prompt.
	sdk.addCollection('script-recipes', 'search', async (params: any) => {
		const { prompt, projectId, limit } = params || {};
		if (!prompt) return [];
		return scriptRecipesService.searchScriptRecipes({ prompt, projectId, limit });
	});

	// Fetch one recipe by id (any status).
	// NOTE: the SDK's ScriptStore invokes these handlers with POSITIONAL args
	// (matching the ScriptRecipeStore interface — e.g. getById(id), not getById({id})),
	// so they must read positional params, not destructure a single object.
	sdk.addCollection('script-recipes', 'getById', async (id: string) => {
		if (!id) return null;
		return scriptRecipesService.getScriptRecipe(id);
	});

	// Count healthy verified recipes (gates the "any scripts?" path).
	sdk.addCollection('script-recipes', 'count', async (params: any) => {
		return scriptRecipesService.countScriptRecipes(params?.projectId);
	});

	// Insert or update a recipe row.
	sdk.addCollection('script-recipes', 'upsert', async (params: any) => {
		if (!params?.id) throw new Error('script-recipes.upsert: id required');
		await scriptRecipesService.upsertScriptRecipe(params);
		return { success: true };
	});

	// Atomic counter / last-used bump.
	sdk.addCollection('script-recipes', 'updateStats', async (id: string, patch?: any) => {
		if (!id) throw new Error('script-recipes.updateStats: id required');
		await scriptRecipesService.updateScriptRecipeStats(id, patch || {});
		return { success: true };
	});

	// Promote a draft to verified.
	sdk.addCollection('script-recipes', 'promote', async (id: string, patch?: any) => {
		if (!id) throw new Error('script-recipes.promote: id required');
		return scriptRecipesService.promoteScriptRecipe(id, patch || {});
	});

	// Commit a user-directed edit onto an existing recipe (version N+1, same id).
	sdk.addCollection('script-recipes', 'commitEdit', async (id: string, patch?: any) => {
		if (!id) throw new Error('script-recipes.commitEdit: id required');
		return scriptRecipesService.commitScriptRecipeEdit(id, patch || {});
	});

	// Stamp a draft's last execution error.
	sdk.addCollection('script-recipes', 'recordDraftError', async (id: string, err?: any) => {
		if (!id) throw new Error('script-recipes.recordDraftError: id required');
		await scriptRecipesService.recordScriptDraftError(id, err as any);
		return { success: true };
	});

	// Delete a recipe row (the SDK removes the on-disk body separately).
	sdk.addCollection('script-recipes', 'remove', async (id: string) => {
		if (!id) throw new Error('script-recipes.remove: id required');
		await scriptRecipesService.deleteScriptRecipe(id);
		return { success: true };
	});

	// Collision check for on-disk filenames.
	sdk.addCollection('script-recipes', 'fileBaseTaken', async (fileBase: string, excludeId?: string, projectId?: string) => {
		if (!fileBase) return false;
		return scriptRecipesService.fileBaseTaken(fileBase, projectId ?? null, excludeId ?? '');
	});

	console.log('✓ script-recipes collection registered');
}
