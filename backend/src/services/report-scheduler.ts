import * as reportsService from '../../../database/postgres/src/project-data-db/reports';
import { sendScheduledReportEmail } from './email-service';
import { buildReportUrl } from './report-url';

/**
 * Report Scheduler — periodic timer that checks for due scheduled reports
 *
 * Ticks every REPORT_SCHEDULER_INTERVAL_MS (default: 60s).
 * On each tick, queries all reports with an enabled scheduleConfig,
 * checks if they are due based on frequency/time/day settings,
 * and sends emails with a link to view the report.
 */

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Check if a report is due for sending based on its schedule config
 */
function isDue(report: any): boolean {
	const config = report.scheduleConfig as reportsService.ScheduleConfig;
	if (!config || !config.enabled) return false;
	if (!config.recipients || config.recipients.length === 0) return false;

	// One-time: already sent? skip
	if (config.frequency === 'once' && report.lastScheduledAt) return false;

	const now = new Date();

	// Parse the scheduled time
	const scheduledHour = parseInt(config.time.split(':')[0], 10);
	const scheduledMinute = parseInt(config.time.split(':')[1], 10);

	// Get current time in the configured timezone
	const tzNow = new Date(now.toLocaleString('en-US', { timeZone: config.timezone || 'UTC' }));
	const currentHour = tzNow.getHours();
	const currentMinute = tzNow.getMinutes();

	// Check if we're within the scheduled time window (within 5 minutes)
	const scheduledMinutes = scheduledHour * 60 + scheduledMinute;
	const currentMinutes = currentHour * 60 + currentMinute;
	const diff = currentMinutes - scheduledMinutes;
	if (diff < 0 || diff >= 5) return false;

	// One-time: check if today matches the scheduled date
	if (config.frequency === 'once') {
		if (!config.scheduledDate) return false;
		const todayStr = `${tzNow.getFullYear()}-${String(tzNow.getMonth() + 1).padStart(2, '0')}-${String(tzNow.getDate()).padStart(2, '0')}`;
		if (todayStr !== config.scheduledDate) return false;
	}

	// Check day-of-week for weekly
	if (config.frequency === 'weekly') {
		const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
		const currentDay = days[tzNow.getDay()];
		if (currentDay !== config.dayOfWeek) return false;
	}

	// Helper: check day-of-month match
	const checkDayOfMonth = (): boolean => {
		const currentDate = tzNow.getDate();
		const lastDay = new Date(tzNow.getFullYear(), tzNow.getMonth() + 1, 0).getDate();
		if (config.dayOfMonth === 'last') return currentDate === lastDay;
		return currentDate === parseInt(config.dayOfMonth || '1', 10);
	};

	// Check day-of-month for monthly
	if (config.frequency === 'monthly') {
		if (!checkDayOfMonth()) return false;
	}

	// Check quarterly: which month within each quarter (1st/2nd/3rd) + day-of-month
	// e.g. monthOfQuarter="2" means Feb, May, Aug, Nov
	if (config.frequency === 'quarterly') {
		const currentMonth = tzNow.getMonth() + 1; // 1-12
		const monthInQuarter = ((currentMonth - 1) % 3) + 1; // 1, 2, or 3
		if (String(monthInQuarter) !== (config.monthOfQuarter || '1')) return false;
		if (!checkDayOfMonth()) return false;
	}

	// Check yearly: month + day-of-month
	if (config.frequency === 'yearly') {
		const currentMonth = tzNow.getMonth() + 1; // 1-12
		if (String(currentMonth) !== (config.monthOfYear || '1')) return false;
		if (!checkDayOfMonth()) return false;
	}

	// Check if already sent in this window (prevent duplicate sends)
	if (report.lastScheduledAt) {
		const rawTs = String(report.lastScheduledAt);
		const lastSent = new Date(rawTs.endsWith('Z') ? rawTs : rawTs + 'Z');
		const msSinceLast = now.getTime() - lastSent.getTime();
		// Don't resend if sent within last 30 minutes
		if (msSinceLast < 30 * 60 * 1000) return false;
	}

	return true;
}

/**
 * Run one scheduler tick — check all scheduled reports
 */
async function tick(): Promise<void> {
	if (isRunning) {
		console.log('[REPORT-SCHEDULER] Previous tick still running, skipping');
		return;
	}

	isRunning = true;

	try {
		// Query reports that have a schedule config (lightweight — only fields we need)
		const { data: allReports } = await reportsService.queryReports({
			limit: 500,
			sort: 'ASC',
		});

		// Filter to only scheduled reports
		const scheduledReports = allReports.filter(
			(r: any) => r.scheduleConfig && (r.scheduleConfig as any).enabled
		);

		const now = new Date();
		const tzLabel = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
		console.log(`[REPORT-SCHEDULER] Tick at ${tzLabel} IST — ${allReports.length} total report(s), ${scheduledReports.length} scheduled`);

		if (scheduledReports.length === 0) return;

		for (const r of scheduledReports) {
			const c = r.scheduleConfig as any;
			const due = isDue(r);
			console.log(`[REPORT-SCHEDULER]   "${r.name}" freq=${c.frequency} time=${c.time} date=${c.scheduledDate || '-'} due=${due} lastSent=${r.lastScheduledAt || 'never'}`);
		}

		const dueReports = scheduledReports.filter(isDue);

		if (dueReports.length === 0) {
			console.log('[REPORT-SCHEDULER] No reports due this tick');
			return;
		}

		console.log(`[REPORT-SCHEDULER] ${dueReports.length} report(s) due for sending`);

		for (const report of dueReports) {
			try {
				const config = report.scheduleConfig as reportsService.ScheduleConfig;
				const reportUrl = buildReportUrl(report.projectId, report.reportId);

				await sendScheduledReportEmail({
					recipients: config.recipients,
					reportName: report.name || 'Untitled Report',
					reportUrl,
					frequency: config.frequency,
					time: config.time,
					timezone: config.timezone,
					emailSubject: config.emailSubject,
					emailBody: config.emailBody,
				});

				// Update lastScheduledAt
				await reportsService.updateReport({
					id: report.id,
					lastScheduledAt: new Date().toISOString(),
				});

				console.log(`[REPORT-SCHEDULER] Sent scheduled report "${report.name}" to ${config.recipients.length} recipient(s)`);
			} catch (error: any) {
				console.error(`[REPORT-SCHEDULER] Error sending report "${report.name}":`, error.message);
			}
		}
	} catch (error: any) {
		console.error('[REPORT-SCHEDULER] Tick error:', error.message);
	} finally {
		isRunning = false;
	}
}

/**
 * Start the report scheduler
 */
export function start(): void {
	if (schedulerTimer) {
		console.log('[REPORT-SCHEDULER] Already running');
		return;
	}

	const enabled = process.env.REPORT_SCHEDULE_ENABLED !== 'false';
	if (!enabled) {
		console.log('[REPORT-SCHEDULER] Disabled via REPORT_SCHEDULE_ENABLED=false');
		return;
	}

	const intervalMs = parseInt(process.env.REPORT_SCHEDULER_INTERVAL_MS || '300000', 10);

	console.log(`[REPORT-SCHEDULER] Starting (interval: ${intervalMs}ms)`);
	schedulerTimer = setInterval(tick, intervalMs);

	// Run first tick after a short delay
	setTimeout(tick, 10000);
}

/**
 * Stop the report scheduler
 */
export function stop(): void {
	if (schedulerTimer) {
		clearInterval(schedulerTimer);
		schedulerTimer = null;
		console.log('[REPORT-SCHEDULER] Stopped');
	}
}
