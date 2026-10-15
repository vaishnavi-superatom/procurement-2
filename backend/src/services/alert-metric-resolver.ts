/**
 * Alert Metric Resolver — bridges NL metric descriptions to source queries
 *
 * Uses the existing MainAgent to:
 * 1. Route the metric description to the right source
 * 2. Generate a query via SourceAgent
 * 3. Execute the query and return the result
 *
 * Called ONLY during alert setup (not at runtime).
 */

import { MainAgent, DEFAULT_AGENT_CONFIG, runAsSystem } from '@superatomai/sdk-node';
import type { AgentConfig } from '@superatomai/sdk-node';
import { getSourceManager } from '../sources';
import { getAllTools } from '../tools';

export interface MetricResolutionResult {
	sourceId: string;
	sourceName: string;
	sourceType: string;
	generatedQuery: string;
	resultColumn: string;
	currentValue: number;
	allColumns: string[];
}

/**
 * Resolve a natural language metric description into a source query.
 *
 * Uses MainAgent.handleQuestion() with a specially crafted prompt that
 * instructs the agent to return structured JSON with the query details.
 */
export async function resolveMetric(
	projectId: string,
	metricDescription: string,
	sourceId?: string,
	apiKey?: string,
): Promise<MetricResolutionResult> {
	const sourceManager = getSourceManager();
	if (!sourceManager) {
		throw new Error('Source manager not initialized');
	}

	const sourceTools = getAllTools();
	if (sourceTools.length === 0) {
		throw new Error('No data sources available');
	}

	const agentConfig: AgentConfig = {
		...DEFAULT_AGENT_CONFIG,
		apiKey: apiKey || undefined,
	};

	// Build a prompt that asks the agent to query the metric and return structured info
	const prompt = `I need to set up a metric alert. The metric I want to monitor is: "${metricDescription}"

${sourceId ? `Use specifically the source with ID "${sourceId}".` : 'Find the best data source for this metric.'}

Query the data source to get the current value of this metric. Return a SINGLE numeric value.

IMPORTANT: After getting the result, include this exact JSON block in your response (replace values with actual data):
\`\`\`metric_result
{
  "sourceId": "the_source_id_used",
  "sourceName": "the_source_name",
  "sourceType": "postgres",
  "generatedQuery": "the SQL query you generated",
  "resultColumn": "the_column_name",
  "currentValue": 12345,
  "allColumns": ["col1", "col2"]
}
\`\`\``;

	const mainAgent = new MainAgent(sourceTools, agentConfig);
	const agentResponse = await mainAgent.handleQuestion(prompt, apiKey);

	// Parse the structured result from the agent's response
	const text = agentResponse.text || '';
	const jsonMatch = text.match(/```metric_result\s*\n?([\s\S]*?)\n?```/);

	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[1]);
			return {
				sourceId: stripToolSuffix(parsed.sourceId || ''),
				sourceName: parsed.sourceName || '',
				sourceType: parsed.sourceType || '',
				generatedQuery: parsed.generatedQuery || '',
				resultColumn: parsed.resultColumn || '',
				currentValue: Number(parsed.currentValue) || 0,
				allColumns: parsed.allColumns || [],
			};
		} catch {
			// Fall through to fallback
		}
	}

	// Fallback: try to extract info from tool calls in the agent response
	// If the agent queried a source, we can extract from the executed tools
	const executedTools = (agentResponse as any).executedTools || [];
	if (executedTools.length > 0) {
		const tool = executedTools[0];
		const rawId = tool.sourceId || tool.toolId || '';
		const cleanId = stripToolSuffix(rawId);
		const instance = sourceManager.getInstance(cleanId);

		return {
			sourceId: cleanId,
			sourceName: instance?.getName?.() || tool.toolId || '',
			sourceType: instance?.getType?.() || '',
			generatedQuery: tool.query || tool.input?.query || '',
			resultColumn: 'value',
			currentValue: 0,
			allColumns: [],
		};
	}

	throw new Error('Could not resolve metric. The agent did not return structured results. Try a more specific description.');
}

/**
 * Strip tool ID suffixes (_query, _read) to get the raw source ID.
 * Tool IDs are formatted as "{sourceId}_query" or "{sourceId}_read".
 */
function stripToolSuffix(toolId: string): string {
	return toolId.replace(/_(query|read)$/, '');
}

export interface DeviationQueryPair {
	currentPeriodQuery: string;
	comparisonQuery: string;
}

/**
 * Generate a pair of time-scoped queries for period-over-period deviation alerts.
 *
 * Takes the original (unscoped) metric query and asks the LLM to produce:
 * 1. A "current period" query — same metric but scoped to the current time window
 * 2. A "comparison period" query — same metric scoped to the previous time window
 *
 * For example, if comparison period is "1m" (previous month):
 *   - Current: SELECT SUM(revenue) FROM orders WHERE created_at >= date_trunc('month', NOW())
 *   - Comparison: SELECT SUM(revenue) FROM orders WHERE created_at >= date_trunc('month', NOW()) - INTERVAL '1 month' AND created_at < date_trunc('month', NOW())
 */
export async function generateComparisonQuery(
	projectId: string,
	originalQuery: string,
	metricDescription: string,
	comparisonPeriod: '1h' | '1d' | '1w' | '1m' | '1y',
	sourceId?: string,
	apiKey?: string,
): Promise<DeviationQueryPair> {
	const periodDescriptions: Record<string, { current: string; previous: string }> = {
		'1h': { current: 'the current hour (from the start of this hour to now)', previous: 'the previous hour (the full hour before the current one)' },
		'1d': { current: 'today (from the start of today to now)', previous: 'yesterday (the full previous day)' },
		'1w': { current: 'the current week (from the start of this week to now)', previous: 'the previous week (the full week before the current one)' },
		'1m': { current: 'the current month (from the start of this month to now)', previous: 'the previous month (the full month before the current one)' },
		'1y': { current: 'the current year (from the start of this year to now)', previous: 'the previous year (the full year before the current one)' },
	};

	const desc = periodDescriptions[comparisonPeriod];

	const sourceTools = getAllTools();
	const agentConfig: AgentConfig = {
		...DEFAULT_AGENT_CONFIG,
		apiKey: apiKey || undefined,
	};

	const prompt = `I have a metric query that calculates: "${metricDescription}"

Original query (no time scope — runs across all data):
\`\`\`sql
${originalQuery}
\`\`\`

I need TWO time-scoped versions of this query for period-over-period comparison:

1. **Current period query** — the same metric but scoped to ${desc.current}
2. **Previous period query** — the same metric but scoped to ${desc.previous}

Rules:
- Both queries MUST return the same column names as the original
- Use appropriate date/time WHERE clauses to scope each query to its period
- CRITICAL: Use ONLY relative date functions like NOW(), CURRENT_DATE, date_trunc(), INTERVAL etc. NEVER hardcode specific dates like '2026-03-01'. These queries will run repeatedly on a schedule (daily, weekly, etc.) and must always resolve to the correct period relative to when they execute.
- Use database-appropriate date functions (e.g., date_trunc('month', NOW()), NOW() - INTERVAL '1 month' for PostgreSQL)
- Look at the table schema to identify the correct date/timestamp column to filter on
- If the original query already has date filters, adjust them accordingly for each period
- Both queries should return a single row with the aggregated metric value

${sourceId ? `The data source ID is "${sourceId}".` : ''}

IMPORTANT: Return both queries inside these exact blocks:

\`\`\`current_period_query
SELECT ...
\`\`\`

\`\`\`comparison_query
SELECT ...
\`\`\``;

	const mainAgent = new MainAgent(sourceTools, agentConfig);
	const agentResponse = await mainAgent.handleQuestion(prompt, apiKey);

	const text = agentResponse.text || '';

	const currentMatch = text.match(/```current_period_query\s*\n?([\s\S]*?)\n?```/);
	const compMatch = text.match(/```comparison_query\s*\n?([\s\S]*?)\n?```/);

	if (currentMatch && compMatch) {
		return {
			currentPeriodQuery: currentMatch[1].trim(),
			comparisonQuery: compMatch[1].trim(),
		};
	}

	// Fallback: try to find any two SQL blocks
	const sqlBlocks = [...text.matchAll(/```sql\s*\n?([\s\S]*?)\n?```/g)];
	if (sqlBlocks.length >= 2) {
		return {
			currentPeriodQuery: sqlBlocks[0][1].trim(),
			comparisonQuery: sqlBlocks[1][1].trim(),
		};
	}

	throw new Error('Could not generate query pair. The agent did not return both current and comparison queries. Try a more specific metric description.');
}

/**
 * Test an existing alert's cached query — execute it and evaluate the condition.
 */
export async function testAlertQuery(
	sourceId: string,
	generatedQuery: string,
	resultColumn: string,
): Promise<{ currentValue: number }> {
	const sourceManager = getSourceManager();
	if (!sourceManager) {
		throw new Error('Source manager not initialized');
	}

	const instance = sourceManager.getInstance(sourceId);
	if (!instance) {
		throw new Error(`Source not found: ${sourceId}`);
	}

	const result = await runAsSystem('alert-metric-resolver', () => instance.execute({ sql: generatedQuery }));
	const rows = result.data || [];

	if (rows.length === 0) {
		throw new Error('Query returned no rows');
	}

	const value = Number(rows[0][resultColumn]);
	if (isNaN(value)) {
		throw new Error(`Column "${resultColumn}" returned non-numeric value: ${rows[0][resultColumn]}`);
	}

	return { currentValue: value };
}
