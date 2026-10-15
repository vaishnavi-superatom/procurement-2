import * as dashboardsService from '../../../database/postgres/src/project-data-db/dashboards';
import type { DSLRendererProps } from '../../../database/postgres/src/project-data-db/dsl-types';
import type { CollectionContext } from './types';

/**
 * Register dashboards CRUD collections
 */
export async function registerDashboardsCollections({ sdk }: CollectionContext): Promise<void> {
	// Create dashboard
	sdk.addCollection('dashboards', 'create', async (params: { dashboardId: string; projectId: string; name?: string; description?: string; dashboard?: DSLRendererProps; published?: boolean; createdBy?: string; allowedUsers?: string[] }) => {
		const { dashboardId, projectId, name, description, dashboard, published, createdBy, allowedUsers } = params;

		if (!dashboardId) {
			throw new Error('dashboardId parameter is required');
		}

		if (!projectId) {
			throw new Error('projectId parameter is required');
		}

		try {
			console.log('[DASHBOARDS] Creating dashboard for project:', projectId);
			const result = await dashboardsService.createDashboard({
				dashboardId,
				projectId,
				name,
				description,
				dashboard,
				published,
				createdBy,
				allowedUsers
			});
			console.log('[DASHBOARDS] Dashboard created successfully, ID:', result.data.id);

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[DASHBOARDS] Create failed:', errorMsg);
			throw new Error(`Failed to create dashboard: ${errorMsg}`);
		}
	});

	// Get all dashboards
	sdk.addCollection('dashboards', 'getAll', async () => {
		try {
			console.log('[DASHBOARDS] Getting all dashboards');
			const result = await dashboardsService.getAllDashboards();
			console.log(`[DASHBOARDS] Retrieved ${result.count} dashboards`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[DASHBOARDS] GetAll failed:', errorMsg);
			throw new Error(`Failed to get dashboards: ${errorMsg}`);
		}
	});

	// Get single dashboard
	sdk.addCollection('dashboards', 'getOne', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Dashboard ID is required');
		}

		try {
			console.log('[DASHBOARDS] Getting dashboard ID:', id);
			const result = await dashboardsService.getDashboard({ id: Number(id) });
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[DASHBOARDS] GetOne failed:', errorMsg);
			throw new Error(`Failed to get dashboard: ${errorMsg}`);
		}
	});

	// Update dashboard
	sdk.addCollection('dashboards', 'update', async (params: { id: number; name?: string; description?: string; dashboard?: DSLRendererProps; published?: boolean; updatedBy?: string; allowedUsers?: string[] }) => {
		const { id, name, description, dashboard, published, updatedBy, allowedUsers } = params;

		if (!id) {
			throw new Error('Dashboard ID is required');
		}

		try {
			console.log('[DASHBOARDS] Updating dashboard ID:', id);
			const result = await dashboardsService.updateDashboard({
				id: Number(id),
				name,
				description,
				dashboard,
				published,
				updatedBy,
				allowedUsers
			});
			console.log('[DASHBOARDS] Dashboard updated successfully',result.data);

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[DASHBOARDS] Update failed:', errorMsg);
			throw new Error(`Failed to update dashboard: ${errorMsg}`);
		}
	});

	// Delete dashboard
	sdk.addCollection('dashboards', 'delete', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Dashboard ID is required');
		}

		try {
			console.log('[DASHBOARDS] Deleting dashboard ID:', id);
			const result = await dashboardsService.deleteDashboard({ id: Number(id) });
			console.log('[DASHBOARDS] Dashboard deleted successfully');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[DASHBOARDS] Delete failed:', errorMsg);
			throw new Error(`Failed to delete dashboard: ${errorMsg}`);
		}
	});

	// Query dashboards with filters
	sdk.addCollection('dashboards', 'query', async (params: { filters?: { dashboardId?: string; projectId?: string; createdBy?: string; updatedBy?: string; name?: string; published?: boolean }; limit?: number; sort?: 'ASC' | 'DESC' }) => {
		const { filters = {}, limit = 100, sort = 'DESC' } = params;

		try {
			console.log('[DASHBOARDS] Querying dashboards with filters:', JSON.stringify(filters));
			const result = await dashboardsService.queryDashboards({ filters, limit, sort });
			console.log(`[DASHBOARDS] Query returned ${result.count} dashboards`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[DASHBOARDS] Query failed:', errorMsg);
			throw new Error(`Failed to query dashboards: ${errorMsg}`);
		}
	});

}
