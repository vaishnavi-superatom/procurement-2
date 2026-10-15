import * as reportAlertsService from '../../../database/postgres/src/project-data-db/report-alerts';

/**
 * Alert Engine — evaluates threshold and deviation conditions
 *
 * Called by the scheduler when an alert is due for checking.
 * Executes the cached generatedQuery against the source,
 * evaluates the condition, and returns the result.
 *
 * LLM calls are NOT made here — the AlertAnalyzer handles
 * the AI analysis separately (only when triggered).
 */

export interface AlertEvaluationResult {
	triggered: boolean;
	currentValue: number;
	reason: string;
	details: {
		operator?: string;
		threshold?: number;
		min?: number;
		max?: number;
		baseValue?: number;
		deviationValue?: number;
		deviationThreshold?: number;
		direction?: string;
	};
	checkedAt: string;
}

interface ThresholdConfig {
	type: 'threshold';
	operator: 'lt' | 'gt' | 'lte' | 'gte' | 'outside_range' | 'inside_range';
	threshold?: number;
	min?: number;
	max?: number;
}

interface DeviationConfig {
	type: 'deviation';
	method: 'period_over_period';
	comparisonPeriod: '1h' | '1d' | '1w' | '1m' | '1y';
	currentPeriodQuery: string;
	comparisonQuery: string;
	deviationThreshold: number;
	direction: 'above' | 'below' | 'both';
}

/**
 * Evaluate a threshold condition
 */
export function evaluateThreshold(value: number, config: ThresholdConfig): AlertEvaluationResult {
	const checkedAt = new Date().toISOString();
	const { operator } = config;

	let triggered = false;
	let reason = '';

	switch (operator) {
		case 'lt':
			triggered = value < config.threshold!;
			reason = triggered
				? `${value} is less than ${config.threshold}`
				: `${value} is not less than ${config.threshold}`;
			break;
		case 'gt':
			triggered = value > config.threshold!;
			reason = triggered
				? `${value} is greater than ${config.threshold}`
				: `${value} is not greater than ${config.threshold}`;
			break;
		case 'lte':
			triggered = value <= config.threshold!;
			reason = triggered
				? `${value} is less than or equal to ${config.threshold}`
				: `${value} is greater than ${config.threshold}`;
			break;
		case 'gte':
			triggered = value >= config.threshold!;
			reason = triggered
				? `${value} is greater than or equal to ${config.threshold}`
				: `${value} is less than ${config.threshold}`;
			break;
		case 'outside_range':
			triggered = value < config.min! || value > config.max!;
			if (triggered) {
				reason = value < config.min!
					? `${value} is below minimum (${config.min})`
					: `${value} is above maximum (${config.max})`;
			} else {
				reason = `${value} is within range [${config.min} — ${config.max}]`;
			}
			break;
		case 'inside_range':
			triggered = value >= config.min! && value <= config.max!;
			reason = triggered
				? `${value} is inside range [${config.min} — ${config.max}]`
				: `${value} is outside range [${config.min} — ${config.max}]`;
			break;
		default:
			reason = `Unknown operator: ${operator}`;
	}

	return {
		triggered,
		currentValue: value,
		reason,
		details: {
			operator,
			threshold: config.threshold,
			min: config.min,
			max: config.max,
		},
		checkedAt,
	};
}

const COMPARISON_PERIOD_LABELS: Record<string, string> = {
	'1h': 'previous hour',
	'1d': 'previous day',
	'1w': 'previous week',
	'1m': 'previous month',
	'1y': 'previous year',
};

/**
 * Evaluate a period-over-period deviation condition.
 *
 * Runs the comparison query (scoped to a previous time period) to get
 * the baseline value, then compares it against the current value.
 */
export async function evaluateDeviation(
	currentValue: number,
	config: DeviationConfig,
	sourceExecuteFn: (query: string) => Promise<any[]>,
	resultColumn: string,
): Promise<AlertEvaluationResult> {
	const checkedAt = new Date().toISOString();
	const { comparisonPeriod, comparisonQuery, deviationThreshold, direction } = config;

	if (!comparisonQuery) {
		throw new Error('Deviation alert has no comparison query');
	}

	// Execute the comparison query to get the previous period's value
	const periodLabel = COMPARISON_PERIOD_LABELS[comparisonPeriod] || comparisonPeriod;
	console.log(`[ALERT-ENGINE] Running comparison query for ${periodLabel}:\n${comparisonQuery}`);

	const compRows = await sourceExecuteFn(comparisonQuery);
	console.log(`[ALERT-ENGINE] Comparison query returned ${compRows?.length || 0} rows`);

	if (!compRows || compRows.length === 0) {
		// No data for the comparison period — this is itself an anomaly, trigger the alert
		console.warn(`[ALERT-ENGINE] No data for ${periodLabel} — triggering alert (missing comparison data)`);
		return {
			triggered: true,
			currentValue,
			reason: `No data found for ${periodLabel} — current value is ${currentValue} but there is nothing to compare against`,
			details: { deviationThreshold, direction },
			checkedAt,
		};
	}

	const previousValue = Number(compRows[0][resultColumn]);
	if (isNaN(previousValue)) {
		console.warn(`[ALERT-ENGINE] Comparison query column "${resultColumn}" returned: ${compRows[0][resultColumn]}`);
		return {
			triggered: false,
			currentValue,
			reason: `Comparison query returned non-numeric value for "${resultColumn}" — cannot compare`,
			details: { deviationThreshold, direction },
			checkedAt,
		};
	}

	// Avoid division by zero
	if (previousValue === 0) {
		const reason = currentValue === 0
			? 'Both current and previous values are 0 — no deviation'
			: `Previous period value is 0, current value is ${currentValue} — cannot compute % deviation`;
		return {
			triggered: currentValue !== 0,
			currentValue,
			reason,
			details: { baseValue: previousValue, deviationValue: 0, deviationThreshold, direction },
			checkedAt,
		};
	}

	const deviation = Math.abs(currentValue - previousValue) / Math.abs(previousValue);

	let triggered = false;
	switch (direction) {
		case 'above':
			triggered = currentValue > previousValue && deviation > deviationThreshold;
			break;
		case 'below':
			triggered = currentValue < previousValue && deviation > deviationThreshold;
			break;
		case 'both':
			triggered = deviation > deviationThreshold;
			break;
	}

	const deviationPct = (deviation * 100).toFixed(1);
	const thresholdPct = (deviationThreshold * 100).toFixed(1);
	const reason = triggered
		? `${currentValue} deviates ${deviationPct}% from ${periodLabel} value ${previousValue} (threshold: ${thresholdPct}%)`
		: `${currentValue} is within ${deviationPct}% of ${periodLabel} value ${previousValue} (threshold: ${thresholdPct}%)`;

	return {
		triggered,
		currentValue,
		reason,
		details: {
			baseValue: previousValue,
			deviationValue: deviation,
			deviationThreshold,
			direction,
		},
		checkedAt,
	};
}

/**
 * Evaluate an alert — run the cached query, check the condition
 *
 * @param alert - The alert record from the database
 * @param sourceExecuteFn - Function to execute a query against the source
 * @returns The evaluation result + whether an email should be sent
 */
export async function evaluateAlert(
	alert: any,
	sourceExecuteFn: (query: string) => Promise<any[]>,
): Promise<{ result: AlertEvaluationResult; shouldNotify: boolean }> {
	const { generatedQuery, resultColumn, conditionType, config, cooldownMinutes, lastTriggeredAt } = alert;

	// For deviation alerts, use the time-scoped currentPeriodQuery from config
	// For threshold alerts, use the original generatedQuery
	const currentQuery = conditionType === 'deviation' && (config as DeviationConfig).currentPeriodQuery
		? (config as DeviationConfig).currentPeriodQuery
		: generatedQuery;

	if (!currentQuery) {
		throw new Error('No generated query — alert has not been set up');
	}

	// Execute the current period query
	console.log(`[ALERT-ENGINE] Running current query for ${alert.alertId}:\n${currentQuery}`);
	const rows = await sourceExecuteFn(currentQuery);

	if (!rows || rows.length === 0) {
		// For deviation with time-scoped queries, no rows means no data for current period yet
		if (conditionType === 'deviation') {
			const checkedAt = new Date().toISOString();
			const result: AlertEvaluationResult = {
				triggered: false,
				currentValue: 0,
				reason: 'No data for the current period yet — skipping check',
				details: {},
				checkedAt,
			};
			await reportAlertsService.updateReportAlert({
				id: alert.id,
				lastCheckedAt: checkedAt,
				status: 'ok',
				consecutiveErrors: 0,
			});
			console.log(`[ALERT-ENGINE] ${alert.alertId}: no current period data — skipping`);
			return { result, shouldNotify: false };
		}
		throw new Error('Query returned no rows');
	}

	// Extract the metric value
	const row = rows[0];
	const value = Number(row[resultColumn]);

	if (isNaN(value)) {
		throw new Error(`Column "${resultColumn}" returned non-numeric value: ${row[resultColumn]}`);
	}

	// Evaluate the condition
	let result: AlertEvaluationResult;
	if (conditionType === 'threshold') {
		result = evaluateThreshold(value, config as ThresholdConfig);
	} else if (conditionType === 'deviation') {
		result = await evaluateDeviation(value, config as DeviationConfig, sourceExecuteFn, resultColumn);
	} else {
		throw new Error(`Unknown condition type: ${conditionType}`);
	}

	// Check cooldown
	let shouldNotify = result.triggered;
	if (shouldNotify && lastTriggeredAt && cooldownMinutes) {
		// Postgres 'timestamp without time zone' omits 'Z' — force UTC parsing
		const rawTs = String(lastTriggeredAt);
		const cooldownEnd = new Date(rawTs.endsWith('Z') ? rawTs : rawTs + 'Z').getTime() + cooldownMinutes * 60 * 1000;
		if (Date.now() < cooldownEnd) {
			const remainingMs = cooldownEnd - Date.now();
			const remainingMin = Math.ceil(remainingMs / 60000);
			console.log(`[ALERT-ENGINE] ${alert.alertId}: triggered but in cooldown — ${remainingMin} min remaining (last triggered: ${rawTs})`);
			shouldNotify = false;
		}
	}

	// Update tracking fields
	const updateData: any = {
		id: alert.id,
		lastCheckedAt: result.checkedAt,
		lastValue: result.currentValue,
		status: result.triggered ? 'triggered' : 'ok',
		consecutiveErrors: 0,
	};

	if (shouldNotify) {
		updateData.lastTriggeredAt = result.checkedAt;
	}

	await reportAlertsService.updateReportAlert(updateData);

	return { result, shouldNotify };
}

/**
 * Handle an evaluation error — increment consecutiveErrors, auto-disable if needed
 */
export async function handleEvaluationError(alert: any, error: Error): Promise<void> {
	const consecutiveErrors = (alert.consecutiveErrors || 0) + 1;
	const shouldDisable = consecutiveErrors >= 3;

	await reportAlertsService.updateReportAlert({
		id: alert.id,
		lastCheckedAt: new Date().toISOString(),
		consecutiveErrors,
		status: 'error',
		...(shouldDisable && { enabled: false }),
	});

	if (shouldDisable) {
		console.warn(`[ALERT-ENGINE] Alert "${alert.name}" (${alert.alertId}) auto-disabled after ${consecutiveErrors} consecutive errors. Last error: ${error.message}`);
	}
}
