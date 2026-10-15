import * as reportsService from '../../../database/postgres/src/project-data-db/reports';
import type { DSLRendererProps } from '../../../database/postgres/src/project-data-db/dsl-types';
import type { CollectionContext } from './types';
import { sendScheduledReportEmail } from '../services/email-service';
import { buildReportUrl } from '../services/report-url';

/**
 * Register reports CRUD collections
 */
export async function registerReportsCollections({ sdk }: CollectionContext): Promise<void> {
	// Create report
	sdk.addCollection('reports', 'create', async (params: { reportId: string; projectId: string; name?: string; description?: string; report?: DSLRendererProps; published?: boolean; createdBy?: string }) => {
		const { reportId, projectId, name, description, report, published, createdBy } = params;

		if (!reportId) {
			throw new Error('reportId parameter is required');
		}

		if (!projectId) {
			throw new Error('projectId parameter is required');
		}

		try {
			console.log('[REPORTS] Creating report for project:', projectId);
			const result = await reportsService.createReport({
				reportId,
				projectId,
				name,
				description,
				report,
				published,
				createdBy
			});
			console.log('[REPORTS] Report created successfully, ID:', result.data.id);

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORTS] Create failed:', errorMsg);
			throw new Error(`Failed to create report: ${errorMsg}`);
		}
	});

	// Get all reports
	sdk.addCollection('reports', 'getAll', async () => {
		try {
			console.log('[REPORTS] Getting all reports');
			const result = await reportsService.getAllReports();
			console.log(`[REPORTS] Retrieved ${result.count} reports`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORTS] GetAll failed:', errorMsg);
			throw new Error(`Failed to get reports: ${errorMsg}`);
		}
	});

	// Get single report
	sdk.addCollection('reports', 'getOne', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Report ID is required');
		}

		try {
			console.log('[REPORTS] Getting report ID:', id);
			const result = await reportsService.getReport({ id: Number(id) });
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORTS] GetOne failed:', errorMsg);
			throw new Error(`Failed to get report: ${errorMsg}`);
		}
	});

	// Update report
	sdk.addCollection('reports', 'update', async (params: { id: number; name?: string; description?: string; report?: DSLRendererProps; published?: boolean; updatedBy?: string; scheduleConfig?: any; lastScheduledAt?: string }) => {
		const { id, name, description, report, published, updatedBy, scheduleConfig, lastScheduledAt } = params;

		if (!id) {
			throw new Error('Report ID is required');
		}

		try {
			console.log('[REPORTS] Updating report ID:', id);
			const result = await reportsService.updateReport({
				id: Number(id),
				name,
				description,
				report,
				published,
				updatedBy,
				scheduleConfig,
				lastScheduledAt,
			});
			console.log('[REPORTS] Report updated successfully');

			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORTS] Update failed:', errorMsg);
			throw new Error(`Failed to update report: ${errorMsg}`);
		}
	});

	// Delete report
	sdk.addCollection('reports', 'delete', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Report ID is required');
		}

		try {
			console.log('[REPORTS] Deleting report ID:', id);
			const result = await reportsService.deleteReport({ id: Number(id) });
			console.log('[REPORTS] Report deleted successfully');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORTS] Delete failed:', errorMsg);
			throw new Error(`Failed to delete report: ${errorMsg}`);
		}
	});

	// Send a report immediately ("send now") to the given recipients — no schedule.
	// Accepts either the numeric DB id or the reportId (SA app UUID) to locate the report.
	sdk.addCollection('reports', 'sendNow', async (params: { id?: number; reportId?: string; recipients: string[]; emailSubject?: string; emailBody?: string }) => {
		const { id, reportId, recipients, emailSubject, emailBody } = params;

		if (!id && !reportId) {
			throw new Error('Either id or reportId is required');
		}
		if (!recipients || recipients.length === 0) {
			throw new Error('At least one recipient is required');
		}

		try {
			// Resolve the report record
			let report: any;
			if (id) {
				const result = await reportsService.getReport({ id: Number(id) });
				report = result.data;
			} else {
				const result = await reportsService.queryReports({ filters: { reportId }, limit: 1 });
				report = result.data?.[0];
			}
			if (!report) {
				throw new Error('Report not found');
			}

			const reportUrl = buildReportUrl(report.projectId, report.reportId);

			console.log(`[REPORTS] Sending report "${report.name}" now to ${recipients.length} recipient(s)`);
			const emailResult = await sendScheduledReportEmail({
				recipients,
				reportName: report.name || 'Untitled Report',
				reportUrl,
				immediate: true,
				emailSubject,
				emailBody,
			});

			if (!emailResult.success) {
				throw new Error(emailResult.error || 'Failed to send report email');
			}

			return { success: true, data: { recipients: recipients.length }, message: 'Report sent' };
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORTS] SendNow failed:', errorMsg);
			throw new Error(`Failed to send report: ${errorMsg}`);
		}
	});

	// Query reports with filters
	sdk.addCollection('reports', 'query', async (params: { filters?: { reportId?: string; projectId?: string; createdBy?: string; updatedBy?: string; name?: string; published?: boolean }; limit?: number; sort?: 'ASC' | 'DESC' }) => {
		const { filters = {}, limit = 100, sort = 'DESC' } = params;

		try {
			console.log('[REPORTS] Querying reports with filters:', JSON.stringify(filters));
			const result = await reportsService.queryReports({ filters, limit, sort });
			console.log(`[REPORTS] Query returned ${result.count} reports`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORTS] Query failed:', errorMsg);
			throw new Error(`Failed to query reports: ${errorMsg}`);
		}
	});

}
