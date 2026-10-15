import * as reportAlertsService from '../../../database/postgres/src/project-data-db/report-alerts';
import { resolveMetric, testAlertQuery, generateComparisonQuery } from '../services/alert-metric-resolver';
import { evaluateThreshold, evaluateDeviation } from '../services/alert-engine';
import { getSourceManager } from '../sources';
import type { CollectionContext } from './types';
import { runAsSystem } from '@superatomai/sdk-node';

/**
 * Register report alerts CRUD collections
 */
export async function registerReportAlertsCollections({ sdk }: CollectionContext): Promise<void> {
	// Create report alert
	sdk.addCollection('report-alerts', 'create', async (params: {
		alertId?: string;
		reportId: string;
		projectId: string;
		name?: string;
		enabled?: boolean;
		metricDescription?: string;
		sourceId?: string;
		generatedQuery?: string;
		resultColumn?: string;
		conditionType?: string;
		config?: any;
		checkInterval?: string;
		recipients?: string[];
		emailSubject?: string;
		cooldownMinutes?: number;
		createdBy?: string;
	}) => {
		const { reportId, projectId } = params;

		if (!reportId) {
			throw new Error('reportId parameter is required');
		}

		if (!projectId) {
			throw new Error('projectId parameter is required');
		}

		// Auto-generate alertId if not provided
		const alertId = params.alertId || `alert_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

		try {
			console.log('[REPORT-ALERTS] Creating alert for report:', reportId);
			const result = await reportAlertsService.createReportAlert({ ...params, alertId });
			console.log('[REPORT-ALERTS] Alert created successfully, ID:', result.data.id);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] Create failed:', errorMsg);
			throw new Error(`Failed to create report alert: ${errorMsg}`);
		}
	});

	// Get all report alerts
	sdk.addCollection('report-alerts', 'getAll', async () => {
		try {
			console.log('[REPORT-ALERTS] Getting all report alerts');
			const result = await reportAlertsService.getAllReportAlerts();
			console.log(`[REPORT-ALERTS] Retrieved ${result.count} alerts`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] GetAll failed:', errorMsg);
			throw new Error(`Failed to get report alerts: ${errorMsg}`);
		}
	});

	// Get single report alert
	sdk.addCollection('report-alerts', 'getOne', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Alert ID is required');
		}

		try {
			console.log('[REPORT-ALERTS] Getting alert ID:', id);
			const result = await reportAlertsService.getReportAlert({ id: Number(id) });
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] GetOne failed:', errorMsg);
			throw new Error(`Failed to get report alert: ${errorMsg}`);
		}
	});

	// Update report alert
	sdk.addCollection('report-alerts', 'update', async (params: {
		id: number;
		name?: string;
		enabled?: boolean;
		metricDescription?: string;
		sourceId?: string;
		generatedQuery?: string;
		resultColumn?: string;
		conditionType?: string;
		config?: any;
		checkInterval?: string;
		recipients?: string[];
		emailSubject?: string;
		cooldownMinutes?: number;
		lastCheckedAt?: string;
		lastTriggeredAt?: string;
		lastValue?: number;
		consecutiveErrors?: number;
		status?: string;
	}) => {
		const { id } = params;

		if (!id) {
			throw new Error('Alert ID is required');
		}

		try {
			console.log('[REPORT-ALERTS] Updating alert ID:', id);
			const result = await reportAlertsService.updateReportAlert({
				...params,
				id: Number(id),
			});
			console.log('[REPORT-ALERTS] Alert updated successfully');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] Update failed:', errorMsg);
			throw new Error(`Failed to update report alert: ${errorMsg}`);
		}
	});

	// Delete report alert
	sdk.addCollection('report-alerts', 'delete', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Alert ID is required');
		}

		try {
			console.log('[REPORT-ALERTS] Deleting alert ID:', id);
			const result = await reportAlertsService.deleteReportAlert({ id: Number(id) });
			console.log('[REPORT-ALERTS] Alert deleted successfully');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] Delete failed:', errorMsg);
			throw new Error(`Failed to delete report alert: ${errorMsg}`);
		}
	});

	// Query report alerts with filters
	sdk.addCollection('report-alerts', 'query', async (params: {
		filters?: {
			alertId?: string;
			reportId?: string;
			projectId?: string;
			enabled?: boolean;
			status?: string;
			createdBy?: string;
		};
		limit?: number;
		sort?: 'ASC' | 'DESC';
	}) => {
		const { filters = {}, limit = 100, sort = 'DESC' } = params;

		try {
			console.log('[REPORT-ALERTS] Querying alerts with filters:', JSON.stringify(filters));
			const result = await reportAlertsService.queryReportAlerts({ filters, limit, sort });
			console.log(`[REPORT-ALERTS] Query returned ${result.count} alerts`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] Query failed:', errorMsg);
			throw new Error(`Failed to query report alerts: ${errorMsg}`);
		}
	});

	// Enable an alert
	sdk.addCollection('report-alerts', 'enable', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Alert ID is required');
		}

		try {
			console.log('[REPORT-ALERTS] Enabling alert ID:', id);
			const result = await reportAlertsService.updateReportAlert({
				id: Number(id),
				enabled: true,
				consecutiveErrors: 0,
				status: 'unchecked',
			});
			console.log('[REPORT-ALERTS] Alert enabled');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] Enable failed:', errorMsg);
			throw new Error(`Failed to enable report alert: ${errorMsg}`);
		}
	});

	// Disable an alert
	sdk.addCollection('report-alerts', 'disable', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Alert ID is required');
		}

		try {
			console.log('[REPORT-ALERTS] Disabling alert ID:', id);
			const result = await reportAlertsService.updateReportAlert({
				id: Number(id),
				enabled: false,
			});
			console.log('[REPORT-ALERTS] Alert disabled');
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] Disable failed:', errorMsg);
			throw new Error(`Failed to disable report alert: ${errorMsg}`);
		}
	});

	// Resolve a natural language metric description into a source query
	sdk.addCollection('report-alerts', 'resolveMetric', async (params: {
		projectId: string;
		metricDescription: string;
		sourceId?: string;
	}) => {
		const { projectId, metricDescription, sourceId } = params;

		if (!projectId || !metricDescription) {
			throw new Error('projectId and metricDescription are required');
		}

		try {
			console.log('[REPORT-ALERTS] Resolving metric:', metricDescription);
			const result = await resolveMetric(projectId, metricDescription, sourceId);
			console.log('[REPORT-ALERTS] Metric resolved:', result.sourceId, '=', result.currentValue);
			return { success: true, data: result };
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] ResolveMetric failed:', errorMsg);
			throw new Error(`Failed to resolve metric: ${errorMsg}`);
		}
	});

	// Generate comparison query for deviation alerts
	sdk.addCollection('report-alerts', 'generateComparisonQuery', async (params: {
		projectId: string;
		originalQuery: string;
		metricDescription: string;
		comparisonPeriod: '1h' | '1d' | '1w' | '1m' | '1y';
		sourceId?: string;
	}) => {
		const { projectId, originalQuery, metricDescription, comparisonPeriod, sourceId } = params;

		if (!projectId || !originalQuery || !metricDescription || !comparisonPeriod) {
			throw new Error('projectId, originalQuery, metricDescription, and comparisonPeriod are required');
		}

		try {
			console.log('[REPORT-ALERTS] Generating query pair for period:', comparisonPeriod);
			const queryPair = await generateComparisonQuery(
				projectId, originalQuery, metricDescription, comparisonPeriod, sourceId,
			);
			console.log('[REPORT-ALERTS] Query pair generated successfully');
			return { success: true, data: queryPair };
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] GenerateComparisonQuery failed:', errorMsg);
			throw new Error(`Failed to generate comparison query: ${errorMsg}`);
		}
	});

	// Test an existing alert — run cached query and evaluate condition (no email sent)
	sdk.addCollection('report-alerts', 'testAlert', async (params: { id: number }) => {
		const { id } = params;

		if (!id) {
			throw new Error('Alert ID is required');
		}

		try {
			console.log('[REPORT-ALERTS] Testing alert ID:', id);
			const alertResult = await reportAlertsService.getReportAlert({ id: Number(id) });
			const alert = alertResult.data;

			if (!alert) {
				throw new Error(`Alert not found: ${id}`);
			}

			if (!alert.sourceId || !alert.resultColumn) {
				throw new Error('Alert has no source/column — test the metric first');
			}

			// For deviation, use the time-scoped currentPeriodQuery; for threshold, use generatedQuery
			const config = alert.config as any;
			const queryToRun = alert.conditionType === 'deviation' && config.currentPeriodQuery
				? config.currentPeriodQuery
				: alert.generatedQuery;

			if (!queryToRun) {
				throw new Error('Alert has no generated query — test the metric first');
			}

			// Execute the current period query
			const { currentValue } = await testAlertQuery(alert.sourceId, queryToRun, alert.resultColumn);

			// Evaluate the condition
			let evalResult;
			if (alert.conditionType === 'threshold') {
				evalResult = evaluateThreshold(currentValue, config);
			} else if (alert.conditionType === 'deviation') {
				// Deviation needs sourceExecuteFn to run the comparison query
				const sourceManager = getSourceManager();
				const instance = sourceManager?.getInstance(alert.sourceId);
				if (!instance) {
					throw new Error(`Source not found: ${alert.sourceId}`);
				}
				const sourceExecuteFn = async (query: string) => {
					const result = await runAsSystem('report-alert-deviation', () => instance.execute({ sql: query }));
					return result.data || [];
				};
				evalResult = await evaluateDeviation(currentValue, config, sourceExecuteFn, alert.resultColumn);
			} else {
				throw new Error(`Unknown condition type: ${alert.conditionType}`);
			}

			console.log('[REPORT-ALERTS] Test result:', evalResult.triggered ? 'WOULD TRIGGER' : 'NOT TRIGGERED');
			return { success: true, data: evalResult };
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] TestAlert failed:', errorMsg);
			throw new Error(`Failed to test alert: ${errorMsg}`);
		}
	});

	// Get alert history
	sdk.addCollection('report-alerts', 'getHistory', async (params: { alertId: string; limit?: number }) => {
		const { alertId, limit = 20 } = params;

		if (!alertId) {
			throw new Error('alertId is required');
		}

		try {
			console.log('[REPORT-ALERTS] Getting history for alert:', alertId);
			const result = await reportAlertsService.getAlertHistory({ alertId, limit });
			console.log(`[REPORT-ALERTS] Retrieved ${result.count} history entries`);
			return result;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[REPORT-ALERTS] GetHistory failed:', errorMsg);
			throw new Error(`Failed to get alert history: ${errorMsg}`);
		}
	});
}
