import * as userConversationsService from '../../../database/postgres/src/project-data-db/user-conversations';

/**
 * Trace Cleanup Scheduler — periodic timer that caps conversation_traces
 * (the debug trace table shared by chat/dashboard/report — see
 * saveConversationTrace/getConversationTrace) at a fixed row count PER TYPE.
 *
 * A trace is debug data, not an audit record — user_conversations /
 * dashboard_agent_conversations / reports_conversations rows (the actual
 * answers) already survive independently (conversationId is a soft pointer,
 * no FK/cascade), so trimming old traces loses nothing a user would notice.
 * A row-count cap (vs. a day-based TTL) is what you want when question
 * volume is bursty and hard to predict day-to-day — at this table's current
 * average of ~60KB/row, a 1000-row cap holds storage to roughly ~60MB per
 * type, regardless of how many questions land on any given day.
 *
 * Capped per type, not globally across all types together — otherwise a
 * burst in one flow (e.g. a lot of dashboard generation on a given day)
 * could crowd out every other type's traces entirely. Each type always
 * keeps its own most recent TRACE_MAX_ROWS independently.
 *
 * Ticks every TRACE_CLEANUP_INTERVAL_MS (default: 5 min — same cadence as
 * alert/report schedulers). On each tick, trims each type down to
 * TRACE_MAX_ROWS (default: 1000) if over, oldest rows first, in small
 * batches (see enforceConversationTraceRowCap) so a large backlog doesn't
 * hold a long-running lock on the table. A short interval keeps the table
 * close to the cap even during a burst, rather than letting it balloon for
 * up to a day between ticks.
 */

// Same values as chat_analytics.type / sdk-nodejs's AnalyticsEventType —
// see the `type` column's comment in schema.ts. Hardcoded rather than
// discovered from the table's own DISTINCT types, so a type with zero rows
// right now still gets capped the moment it starts writing traces, and a
// typo'd/unexpected type value never silently grows unbounded.
const TRACE_TYPES = ['chat_agent', 'dashboard', 'report'] as const;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

async function tick(): Promise<void> {
	if (isRunning) {
		console.log('[TRACE-CLEANUP] Previous tick still running, skipping this one');
		return;
	}
	isRunning = true;

	try {
		const maxRows = parseInt(process.env.TRACE_MAX_ROWS || '1000', 10);
		console.log(`[TRACE-CLEANUP] Tick — capping conversation_traces at ${maxRows} row(s) per type`);

		for (const type of TRACE_TYPES) {
			const { deleted } = await userConversationsService.enforceConversationTraceRowCap(type, maxRows);
			if (deleted > 0) {
				console.log(`[TRACE-CLEANUP] type=${type}: deleted ${deleted} excess trace row(s)`);
			} else {
				console.log(`[TRACE-CLEANUP] type=${type}: under the cap, nothing to delete`);
			}
		}
	} catch (error: any) {
		console.error('[TRACE-CLEANUP] Tick error:', error.message);
	} finally {
		isRunning = false;
	}
}

/**
 * Start the trace cleanup scheduler
 */
export function start(): void {
	if (schedulerTimer) {
		console.log('[TRACE-CLEANUP] Already running');
		return;
	}

	const enabled = process.env.TRACE_CLEANUP_ENABLED !== 'false';
	if (!enabled) {
		console.log('[TRACE-CLEANUP] Disabled via TRACE_CLEANUP_ENABLED=false');
		return;
	}

	const intervalMs = parseInt(process.env.TRACE_CLEANUP_INTERVAL_MS || '300000', 10); // default: 5 min

	console.log(`[TRACE-CLEANUP] Starting (interval: ${intervalMs}ms)`);
	schedulerTimer = setInterval(tick, intervalMs);

	// Run first tick after a short delay, same convention as alert/report schedulers
	setTimeout(tick, 10000);
}

/**
 * Stop the trace cleanup scheduler
 */
export function stop(): void {
	if (schedulerTimer) {
		clearInterval(schedulerTimer);
		schedulerTimer = null;
		console.log('[TRACE-CLEANUP] Stopped');
	}
}
