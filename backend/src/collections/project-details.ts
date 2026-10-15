import * as projectDetailsService from '../../../database/postgres/src/project-data-db/project-details';
import type { CollectionContext } from './types';

export async function registerProjectDetailsCollections({ sdk }: CollectionContext): Promise<void> {
	// Create project details
	sdk.addCollection('project-details', 'create', async (params: {
		id: string;
		name: string;
		icon?: string;
		description?: string;
		databaseType?: string;
		databaseName?: string;
		primaryColor?: string;
	}) => {
		const { id, name, icon, description, databaseType, databaseName, primaryColor } = params;

		if (!id) {
			throw new Error('id is required');
		}

		if (!name) {
			throw new Error('name is required');
		}

		try {
			console.log('[PROJECT-DETAILS] Creating project:', id, name);
			const result = await projectDetailsService.createProjectDetails({
				id,
				name,
				icon,
				description,
				databaseType,
				databaseName,
				primaryColor,
			});
			console.log('[PROJECT-DETAILS] Created successfully, ID:', result.data.id);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[PROJECT-DETAILS] Create failed:', errorMsg);
			throw new Error(`Failed to create project details: ${errorMsg}`);
		}
	});

	// Get all project details
	sdk.addCollection('project-details', 'getAll', async (params?: { limit?: number }) => {
		const { limit } = params || {};

		try {
			console.log('[PROJECT-DETAILS] Getting all project details');
			const result = await projectDetailsService.getAllProjectDetails(limit ? Number(limit) : 50);
			console.log(`[PROJECT-DETAILS] Retrieved ${result.count} projects`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[PROJECT-DETAILS] GetAll failed:', errorMsg);
			throw new Error(`Failed to get project details: ${errorMsg}`);
		}
	});

	// Get single project details
	sdk.addCollection('project-details', 'getOne', async (params: { id: string }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Project ID is required');
		}

		try {
			console.log('[PROJECT-DETAILS] Getting project ID:', id);
			const result = await projectDetailsService.getProjectDetails({ id });
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[PROJECT-DETAILS] GetOne failed:', errorMsg);
			throw new Error(`Failed to get project details: ${errorMsg}`);
		}
	});

	// Update project details
	sdk.addCollection('project-details', 'update', async (params: {
		id: string;
		name?: string;
		icon?: string;
		description?: string;
		databaseType?: string;
		databaseName?: string;
		primaryColor?: string;
	}) => {
		const { id, name, icon, description, databaseType, databaseName, primaryColor } = params;

		if (!id) {
			throw new Error('Project ID is required');
		}

		try {
			console.log('[PROJECT-DETAILS] Updating project ID:', id);
			const result = await projectDetailsService.updateProjectDetails({
				id,
				name,
				icon,
				description,
				databaseType,
				databaseName,
				primaryColor,
			});
			console.log('[PROJECT-DETAILS] Updated successfully');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[PROJECT-DETAILS] Update failed:', errorMsg);
			throw new Error(`Failed to update project details: ${errorMsg}`);
		}
	});

	// Delete project details
	sdk.addCollection('project-details', 'delete', async (params: { id: string }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Project ID is required');
		}

		try {
			console.log('[PROJECT-DETAILS] Deleting project ID:', id);
			const result = await projectDetailsService.deleteProjectDetails({ id });
			console.log('[PROJECT-DETAILS] Deleted successfully');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[PROJECT-DETAILS] Delete failed:', errorMsg);
			throw new Error(`Failed to delete project details: ${errorMsg}`);
		}
	});

	// Query project details with filters
	sdk.addCollection('project-details', 'query', async (params: {
		filters?: {
			id?: string;
			name?: string;
			databaseType?: string;
			databaseName?: string;
		};
		limit?: number;
		sort?: 'ASC' | 'DESC';
	}) => {
		const { filters, limit, sort } = params || {};

		try {
			console.log('[PROJECT-DETAILS] Querying projects with filters:', JSON.stringify(filters));
			const result = await projectDetailsService.queryProjectDetails({
				filters: {
					id: filters?.id,
					name: filters?.name,
					databaseType: filters?.databaseType,
					databaseName: filters?.databaseName,
				},
				limit: limit ? Number(limit) : 50,
				sort: sort || 'DESC',
			});
			console.log(`[PROJECT-DETAILS] Query returned ${result.count} projects`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[PROJECT-DETAILS] Query failed:', errorMsg);
			throw new Error(`Failed to query project details: ${errorMsg}`);
		}
	});

}
