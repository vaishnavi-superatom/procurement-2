import * as reportAlertsService from '../../../database/postgres/src/project-data-db/report-alerts';
import { evaluateAlert, handleEvaluationError } from './alert-engine';

/**
 * Alert Scheduler — periodic timer that checks due alerts
 *
 * Ticks every ALERT_SCHEDULER_INTERVAL_MS (default: 60s).
 * On each tick, loads all enabled alerts, checks which are due
 * (based on checkInterval + lastCheckedAt), and evaluates them.
 */

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Get a source execute function for a given sourceId.
 * This is a placeholder — will be wired to the actual source plugin system.
 */
type SourceExecuteFnProvider = (sourceId: string, projectId: string) => Promise<((query: string) => Promise<any[]>) | null>;

let sourceExecuteFnProvider: SourceExecuteFnProvider | null = null;

/**
 * Register the source execute function provider.
 * Called during backend startup to wire the scheduler to the source plugin system.
 */
export function registerSourceProvider(provider: SourceExecuteFnProvider): void {
	sourceExecuteFnProvider = provider;
	console.log('[ALERT-SCHEDULER] Source provider registered');
}

/**
 * Callback invoked when an alert triggers and should send a notification.
 * Registered during startup — handles analysis + email sending.
 */
type AlertTriggerCallback = (alert: any, result: any) => Promise<void>;

let alertTriggerCallback: AlertTriggerCallback | null = null;

/**
 * Register the callback for when an alert triggers.
 */
export function registerTriggerCallback(callback: AlertTriggerCallback): void {
	alertTriggerCallback = callback;
	console.log('[ALERT-SCHEDULER] Trigger callback registered');
}

/**
 * Run one scheduler tick — check all due alerts
 */
async function tick(): Promise<void> {
	if (isRunning) {
		console.log('[ALERT-SCHEDULER] Previous tick still running, skipping');
		return;
	}

	isRunning = true;

	try {
		// Load only alerts that are due (interval check done in SQL)
		const { data: dueAlerts } = await reportAlertsService.queryDueAlerts(500);

		if (dueAlerts.length === 0) {
			return;
		}

		console.log(`[ALERT-SCHEDULER] Tick: ${dueAlerts.length} alert(s) due`);

		// Evaluate each due alert sequentially
		for (const alert of dueAlerts) {
			try {
				if (!sourceExecuteFnProvider) {
					console.warn('[ALERT-SCHEDULER] No source provider registered, skipping alert:', alert.alertId);
					continue;
				}

				const executeFn = await sourceExecuteFnProvider(alert.sourceId, alert.projectId);
				if (!executeFn) {
					console.warn(`[ALERT-SCHEDULER] No source found for sourceId: ${alert.sourceId}, skipping`);
					await handleEvaluationError(alert, new Error(`Source not found: ${alert.sourceId}`));
					continue;
				}

				const { result, shouldNotify } = await evaluateAlert(alert, executeFn);

				console.log(`[ALERT-SCHEDULER] ${alert.alertId}: value=${result.currentValue}, triggered=${result.triggered}, shouldNotify=${shouldNotify}, reason="${result.reason}"`);

				if (shouldNotify && alertTriggerCallback) {
					console.log(`[ALERT-SCHEDULER] ${alert.alertId}: firing trigger callback (analysis + email)`);
					alertTriggerCallback(alert, result).catch((err) => {
						console.error(`[ALERT-SCHEDULER] Trigger callback failed for ${alert.alertId}:`, err.message);
					});
				}
			} catch (error: any) {
				console.error(`[ALERT-SCHEDULER] Error evaluating alert ${alert.alertId}:`, error.message);
				await handleEvaluationError(alert, error instanceof Error ? error : new Error(String(error)));
			}
		}
	} catch (error: any) {
		console.error('[ALERT-SCHEDULER] Tick error:', error.message);
	} finally {
		isRunning = false;
	}
}

/**
 * Start the alert scheduler
 */
export function start(): void {
	if (schedulerTimer) {
		console.log('[ALERT-SCHEDULER] Already running');
		return;
	}

	const enabled = process.env.ALERT_CHECK_ENABLED !== 'false';
	if (!enabled) {
		console.log('[ALERT-SCHEDULER] Disabled via ALERT_CHECK_ENABLED=false');
		return;
	}

	const intervalMs = parseInt(process.env.ALERT_SCHEDULER_INTERVAL_MS || '300000', 10);

	console.log(`[ALERT-SCHEDULER] Starting (interval: ${intervalMs}ms)`);
	schedulerTimer = setInterval(tick, intervalMs);

	// Run first tick after a short delay to let sources initialize
	setTimeout(tick, 5000);
}

/**
 * Stop the alert scheduler
 */
export function stop(): void {
	if (schedulerTimer) {
		clearInterval(schedulerTimer);
		schedulerTimer = null;
		console.log('[ALERT-SCHEDULER] Stopped');
	}
}
