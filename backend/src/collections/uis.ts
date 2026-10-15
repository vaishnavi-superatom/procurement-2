import * as uisService from '../../../database/postgres/src/project-data-db/uis';
import type { DSLRendererProps } from '../../../database/postgres/src/project-data-db/dsl-types';
import type { CollectionContext } from './types';

/**
 * Register UIs CRUD collections
 */
export async function registerUIsCollections({ sdk }: CollectionContext): Promise<void> {
	// Create UI
	sdk.addCollection('uis', 'create', async (params: { uiId: string; projectId: string; name?: string; description?: string; ui?: DSLRendererProps; createdBy?: string }) => {
		const { uiId, projectId, name, description, ui, createdBy } = params;

		if (!uiId) {
			throw new Error('uiId parameter is required');
		}

		if (!projectId) {
			throw new Error('projectId parameter is required');
		}

		try {
			console.log('[UIS] Creating UI for project:', projectId);
			const result = await uisService.createUI({
				uiId,
				projectId,
				name,
				description,
				ui,
				createdBy
			});
			console.log('[UIS] UI created successfully, ID:', result.data.id);

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[UIS] Create failed:', errorMsg);
			throw new Error(`Failed to create UI: ${errorMsg}`);
		}
	});

	// Get all UIs
	sdk.addCollection('uis', 'getAll', async () => {
		try {
			console.log('[UIS] Getting all UIs');
			const result = await uisService.getAllUIs();
			console.log(`[UIS] Retrieved ${result.count} UIs`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[UIS] GetAll failed:', errorMsg);
			throw new Error(`Failed to get UIs: ${errorMsg}`);
		}
	});

	// Get single UI by ID
	sdk.addCollection('uis', 'getOne', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('UI ID is required');
		}

		try {
			console.log('[UIS] Getting UI ID:', id);
			const result = await uisService.getUI({ id: Number(id) });
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[UIS] GetOne failed:', errorMsg);
			throw new Error(`Failed to get UI: ${errorMsg}`);
		}
	});

	// Update UI
	sdk.addCollection('uis', 'update', async (params: { id: number; name?: string; description?: string; ui?: DSLRendererProps; updatedBy?: string }) => {
		const { id, name, description, ui, updatedBy } = params;

		if (!id) {
			throw new Error('UI ID is required');
		}

		try {
			console.log('[UIS] Updating UI ID:', id);
			const result = await uisService.updateUI({
				id: Number(id),
				name,
				description,
				ui,
				updatedBy
			});
			console.log('[UIS] UI updated successfully');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[UIS] Update failed:', errorMsg);
			throw new Error(`Failed to update UI: ${errorMsg}`);
		}
	});

	// Delete UI
	sdk.addCollection('uis', 'delete', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('UI ID is required');
		}

		try {
			console.log('[UIS] Deleting UI ID:', id);
			const result = await uisService.deleteUI({ id: Number(id) });
			console.log('[UIS] UI deleted successfully');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[UIS] Delete failed:', errorMsg);
			throw new Error(`Failed to delete UI: ${errorMsg}`);
		}
	});

	// Query UIs with filters
	sdk.addCollection('uis', 'query', async (params: { filters?: { uiId?: string; projectId?: string; createdBy?: string; updatedBy?: string; name?: string }; limit?: number; sort?: 'ASC' | 'DESC' }) => {
		const { filters = {}, limit = 100, sort = 'DESC' } = params;

		try {
			console.log('[UIS] Querying UIs with filters:', JSON.stringify(filters));
			const result = await uisService.queryUIs({ filters, limit, sort });
			console.log(`[UIS] Query returned ${result.count} UIs`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[UIS] Query failed:', errorMsg);
			throw new Error(`Failed to query UIs: ${errorMsg}`);
		}
	});

}
