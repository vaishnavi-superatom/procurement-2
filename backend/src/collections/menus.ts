import * as menusService from '../../../database/postgres/src/project-data-db/menus';
import type { CollectionContext } from './types';

/**
 * Register menus CRUD collections
 * Manages dynamic sidebar menu items
 */
export async function registerMenusCollections({ sdk }: CollectionContext): Promise<void> {
	// Create menu
	sdk.addCollection('menus', 'create', async (params: {
		name: string;
		menuJson?: Record<string, unknown>;
		version?: number;
		isActive?: boolean;
	}) => {
		const { name, menuJson, version, isActive } = params;

		if (!name) {
			throw new Error('name parameter is required');
		}

		try {
			console.log('[MENUS] Creating menu:', name);
			const result = await menusService.createMenu({ name, menuJson, version, isActive });
			console.log('[MENUS] Menu created successfully, ID:', result.data.id);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[MENUS] Create failed:', errorMsg);
			throw new Error(`Failed to create menu: ${errorMsg}`);
		}
	});

	// Get all menus
	sdk.addCollection('menus', 'getAll', async () => {
		try {
			console.log('[MENUS] Getting all menus');
			const result = await menusService.getAllMenus();
			console.log(`[MENUS] Retrieved ${result.count} menus`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[MENUS] GetAll failed:', errorMsg);
			throw new Error(`Failed to get menus: ${errorMsg}`);
		}
	});

	// Get single menu
	sdk.addCollection('menus', 'getOne', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Menu ID is required');
		}

		try {
			console.log('[MENUS] Getting menu ID:', id);
			const result = await menusService.getMenu({ id: Number(id) });
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[MENUS] GetOne failed:', errorMsg);
			throw new Error(`Failed to get menu: ${errorMsg}`);
		}
	});

	// Update menu
	sdk.addCollection('menus', 'update', async (params: {
		id: number;
		name?: string;
		menuJson?: Record<string, unknown>;
		version?: number;
		isActive?: boolean;
	}) => {
		const { id, name, menuJson, version, isActive } = params;

		if (!id) {
			throw new Error('Menu ID is required');
		}

		try {
			console.log('[MENUS] Updating menu ID:', id);
			const result = await menusService.updateMenu({ id: Number(id), name, menuJson, version, isActive });
			console.log('[MENUS] Menu updated successfully:', result.data);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[MENUS] Update failed:', errorMsg);
			throw new Error(`Failed to update menu: ${errorMsg}`);
		}
	});

	// Delete menu
	sdk.addCollection('menus', 'delete', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Menu ID is required');
		}

		try {
			console.log('[MENUS] Deleting menu ID:', id);
			const result = await menusService.deleteMenu({ id: Number(id) });
			console.log('[MENUS] Menu deleted successfully');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[MENUS] Delete failed:', errorMsg);
			throw new Error(`Failed to delete menu: ${errorMsg}`);
		}
	});

	// Query menus with filters
	sdk.addCollection('menus', 'query', async (params: {
		filters?: { isActive?: boolean };
		limit?: number;
		sort?: 'ASC' | 'DESC';
	}) => {
		const { filters = {}, limit = 100, sort = 'ASC' } = params;

		try {
			console.log('[MENUS] Querying menus with filters:', JSON.stringify(filters));
			const result = await menusService.queryMenus({ filters, limit, sort });
			console.log(`[MENUS] Query returned ${result.count} menus`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[MENUS] Query failed:', errorMsg);
			throw new Error(`Failed to query menus: ${errorMsg}`);
		}
	});
}
