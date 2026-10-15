import * as artifactsService from '../../../database/postgres/src/project-data-db/artifacts';
import type { CollectionContext } from './types';

export async function registerArtifactsCollections({ sdk }: CollectionContext): Promise<void> {
	// Create artifact
	sdk.addCollection('artifacts', 'create', async (params: { name: string; createdBy?: string; dsl?: Record<string, any>; status?: string }) => {
		const { name, createdBy, dsl, status } = params;

		if (!name) {
			throw new Error('name is required');
		}

		try {
			console.log('[ARTIFACTS] Creating artifact:', name);
			const result = await artifactsService.createArtifact({ name, createdBy, dsl, status });
			console.log('[ARTIFACTS] Created successfully, ID:', result.data.id);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[ARTIFACTS] Create failed:', errorMsg);
			throw new Error(`Failed to create artifact: ${errorMsg}`);
		}
	});

	// Get all artifacts
	sdk.addCollection('artifacts', 'getAll', async () => {
		try {
			console.log('[ARTIFACTS] Getting all artifacts');
			const result = await artifactsService.getAllArtifacts();
			console.log(`[ARTIFACTS] Retrieved ${result.count} artifacts`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[ARTIFACTS] GetAll failed:', errorMsg);
			throw new Error(`Failed to get artifacts: ${errorMsg}`);
		}
	});

	// Get single artifact
	sdk.addCollection('artifacts', 'getOne', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Artifact ID is required');
		}

		try {
			console.log('[ARTIFACTS] Getting artifact ID:', id);
			const result = await artifactsService.getArtifact({ id: Number(id) });
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[ARTIFACTS] GetOne failed:', errorMsg);
			throw new Error(`Failed to get artifact: ${errorMsg}`);
		}
	});

	// Update artifact
	sdk.addCollection('artifacts', 'update', async (params: { id: number; name?: string; dsl?: Record<string, any>; status?: string; deleted?: boolean }) => {
		const { id, name, dsl, status, deleted } = params;

		if (!id) {
			throw new Error('Artifact ID is required');
		}

		try {
			console.log('[ARTIFACTS] Updating artifact ID:', id);
			const result = await artifactsService.updateArtifact({ id: Number(id), name, dsl, status, deleted });
			console.log('[ARTIFACTS] Updated successfully');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[ARTIFACTS] Update failed:', errorMsg);
			throw new Error(`Failed to update artifact: ${errorMsg}`);
		}
	});

	// Delete artifact (soft delete)
	sdk.addCollection('artifacts', 'delete', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Artifact ID is required');
		}

		try {
			console.log('[ARTIFACTS] Deleting artifact ID:', id);
			const result = await artifactsService.deleteArtifact({ id: Number(id) });
			console.log('[ARTIFACTS] Deleted successfully');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[ARTIFACTS] Delete failed:', errorMsg);
			throw new Error(`Failed to delete artifact: ${errorMsg}`);
		}
	});

	// Query artifacts with filters
	sdk.addCollection('artifacts', 'query', async (params: {
		filters?: {
			createdBy?: string;
			status?: string;
			name?: string;
			deleted?: boolean;
		};
		limit?: number;
		sort?: 'ASC' | 'DESC';
	}) => {
		const { filters, limit, sort } = params || {};

		try {
			console.log('[ARTIFACTS] Querying artifacts with filters:', JSON.stringify(filters));
			const result = await artifactsService.queryArtifacts({
				filters: {
					createdBy: filters?.createdBy || undefined,
					status: filters?.status,
					name: filters?.name,
					deleted: filters?.deleted,
				},
				limit: limit ? Number(limit) : 50,
				sort: sort || 'DESC',
			});
			console.log(`[ARTIFACTS] Query returned ${result.count} artifacts`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[ARTIFACTS] Query failed:', errorMsg);
			throw new Error(`Failed to query artifacts: ${errorMsg}`);
		}
	});

}
