/**
 * Alert Analyzer — produces AI analysis when an alert triggers
 *
 * Uses the existing MainAgent (same as chat queries) to investigate
 * WHY a metric breached its threshold. Only the text output is used —
 * component generation is skipped entirely.
 *
 * This is called ONLY when an alert triggers, not on every check.
 */

import { MainAgent, DEFAULT_AGENT_CONFIG } from '@superatomai/sdk-node';
import type { AgentConfig } from '@superatomai/sdk-node';

export interface AlertAnalysisResult {
	analysis: string | null;
	success: boolean;
}

/**
 * Run AI analysis for a triggered alert using the MainAgent
 *
 * @param alert - The alert record from the database
 * @param currentValue - The metric value that triggered the alert
 * @param reason - Human-readable reason (from evaluateThreshold/evaluateDeviation)
 * @param reportName - Name of the linked report
 * @param sourceTools - The source tools available to the MainAgent
 * @param apiKey - LLM API key
 */
export async function analyzeAlert(
	alert: any,
	currentValue: number,
	reason: string,
	reportName: string,
	sourceTools: any[],
	apiKey?: string,
): Promise<AlertAnalysisResult> {
	try {
		const alertPrompt = buildAlertPrompt(alert, currentValue, reason, reportName);

		const agentConfig: AgentConfig = {
			...DEFAULT_AGENT_CONFIG,
			apiKey: apiKey || undefined,
		};

		// Create MainAgent with the source tools — no stream callback (not streaming to frontend)
		const mainAgent = new MainAgent(sourceTools, agentConfig);
		const agentResponse = await mainAgent.handleQuestion(alertPrompt, apiKey);

		// Take only the text response — skip component generation entirely
		const analysis = agentResponse.text || null;

		if (analysis) {
			console.log(`[ALERT-ANALYZER] Analysis generated for alert "${alert.name}" (${analysis.length} chars)`);
		} else {
			console.warn(`[ALERT-ANALYZER] MainAgent returned empty text for alert "${alert.name}"`);
		}

		return { analysis, success: !!analysis };
	} catch (error: any) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error(`[ALERT-ANALYZER] Analysis failed for alert "${alert.name}":`, errorMsg);

		// Analysis failure should NEVER block the alert email
		return { analysis: null, success: false };
	}
}

/**
 * Build the prompt that the MainAgent will use to investigate the alert
 */
function buildAlertPrompt(
	alert: any,
	currentValue: number,
	reason: string,
	reportName: string,
): string {
	const conditionDesc = alert.conditionType === 'threshold'
		? formatThresholdCondition(alert.config)
		: formatDeviationCondition(alert.config);

	return `Alert "${alert.name}" has triggered on report "${reportName}".

Metric being monitored: "${alert.metricDescription}"
Current value: ${currentValue}
Condition: ${conditionDesc}
Status: ${reason}

Investigate why this metric breached the threshold. Specifically:
- What are the top contributors to this value?
- Are there any outliers or anomalies in the underlying data?
- When did this change start (if there's time-series data)?

Provide a brief analysis (3-5 bullet points) with specific numbers, names, and dates from the data. Focus on actionable insights that would help a business user understand what happened and what to do about it.

IMPORTANT: Keep the response concise (under 300 words). Do NOT generate any dashboard components or visualizations — this analysis is for an email notification, not a UI.`;
}

function formatThresholdCondition(config: any): string {
	switch (config.operator) {
		case 'lt': return `Value must be >= ${config.threshold}`;
		case 'gt': return `Value must be <= ${config.threshold}`;
		case 'lte': return `Value must be > ${config.threshold}`;
		case 'gte': return `Value must be < ${config.threshold}`;
		case 'outside_range': return `Value must be between ${config.min} and ${config.max}`;
		case 'inside_range': return `Value must be outside range [${config.min} — ${config.max}]`;
		default: return `Unknown condition`;
	}
}

function formatDeviationCondition(config: any): string {
	const dirLabel = config.direction === 'above' ? 'above'
		: config.direction === 'below' ? 'below'
		: 'above or below';
	const periodLabels: Record<string, string> = { '1h': 'previous hour', '1d': 'previous day', '1w': 'previous week', '1m': 'previous month', '1y': 'previous year' };
	const periodLabel = periodLabels[config.comparisonPeriod] || config.comparisonPeriod;
	return `Value must not deviate more than ${(config.deviationThreshold * 100).toFixed(0)}% ${dirLabel} the ${periodLabel}'s value`;
}
