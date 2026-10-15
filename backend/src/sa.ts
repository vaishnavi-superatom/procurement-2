import dotenv from 'dotenv';

// Load environment variables FIRST — before importing @superatomai/sdk-node below.
// The SDK has eager singletons that read process.env at import time, not per-call — e.g.
// SCRIPT_TIMEOUT_MS in sdk-nodejs/src/userResponse/scripts/script-runner.ts is a top-level
// `const` computed once via an IIFE. If dotenv.config() runs after that import (as it used
// to here), process.env.SCRIPT_TIMEOUT_MS is still unset when the IIFE reads it, so it
// silently locks in the 60s default for the life of the process — confirmed live: scripts
// kept timing out at 60000ms despite SCRIPT_TIMEOUT_MS=180000 in .env. Same failure shape
// the LLM_USAGE_LOG_PATH comment below already knew about; this import just hadn't been
// reordered to avoid it.
dotenv.config({ quiet: true });

import { SuperatomSDK, runAsSystem } from '@superatomai/sdk-node';
import path from 'path';
import { getAllTools, STATIC_TOOLS } from './tools';
import { registerAllCollections } from './collections';
import { initializeSources, getSourceManager } from './sources';
import * as alertScheduler from './services/alert-scheduler';
import * as reportScheduler from './services/report-scheduler';
import * as traceCleanupScheduler from './services/trace-cleanup-scheduler';
import { analyzeAlert } from './services/alert-analyzer';
import { sendAlertEmail } from './services/email-service';
import { getAppBaseUrl } from './services/report-url';
import * as reportAlertsService from '../../database/postgres/src/project-data-db/report-alerts';
import { backfillDataSourceIndex } from '../../database/postgres/src/project-data-db/data-source-index';
import { startScriptBridge } from './services/script-bridge';
import { initCodingAgents } from './coding-agents';
import { codingAgentAnswerProvider } from './coding-agents/answer-provider';
import { startSourceProxy, reregisterSourceProxy } from './services/source-proxy';
import { startGraphReplica } from './services/graph-replica';

// Configure log paths - set before any SDK operations.
// NOTE: LLM usage logging is owned by the SDK's eager `llmUsageLogger` singleton. Now that
// dotenv.config() runs above, before the SDK import, LLM_USAGE_LOG_PATH (if set in .env)
// WILL be seen by it — this comment previously said otherwise, back when the SDK import sat
// above dotenv.config(). Not currently set in .env, so no behavior change today; otherwise
// defaults to `<cwd>/llm-usage-logs.log`.
const ERROR_LOG_PATH = process.env.USER_PROMPT_ERROR_LOG_PATH || path.join(__dirname, '..', 'user-prompt-req-errors');
process.env.USER_PROMPT_ERROR_LOG_PATH = ERROR_LOG_PATH;

// Configuration with validation
const config = {
	SUPERATOM_API_KEY: process.env.SUPERATOM_API_KEY,
	SUPERATOM_PROJECT_ID: process.env.SUPERATOM_PROJECT_ID,
	BUNDLE_DIR: process.env.BUNDLE_DIR || '../frontend/dist/assets',
	DATABASE_TYPE: (process.env.DATABASE_TYPE || 'postgresql') as 'postgresql' | 'mssql',
	// Drives `fmt` in generated analyses: number grouping, currency symbol and
	// the scale vocabulary (Cr/L vs M/B). Defaults keep existing India clients
	// unchanged; set both for a deployment anywhere else.
	SA_LOCALE: process.env.SA_LOCALE || 'en-IN',
	SA_CURRENCY: process.env.SA_CURRENCY || 'INR',
	ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
	GROQ_API_KEY: process.env.GROQ_API_KEY,
	GEMINI_API_KEY: process.env.GEMINI_API_KEY,
	OPENAI_API_KEY: process.env.OPENAI_API_KEY,
	// OpenRouter: OpenAI-compatible gateway. When set (and ANTHROPIC_API_KEY is not),
	// the SDK routes all Claude calls through OpenRouter — see _parseModel in the SDK's llm.ts.
	OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
	// Which sa-websocket deployment this data-agent registers with. The SDK
	// itself already falls back to this same env var when `url` is omitted
	// (sdk-nodejs/src/index.ts), so this is just for visibility alongside the
	// rest of the config — unset means prod (wss://ws.superatom.ai/websocket).
	SA_WEBSOCKET_URL: process.env.SA_WEBSOCKET_URL,
};

// Validate required configuration
function validateConfig(): void {
	const missing: string[] = [];

	if (!config.SUPERATOM_PROJECT_ID) missing.push('SUPERATOM_PROJECT_ID');

	if (missing.length > 0) {
		console.error('✗ Missing required environment variables:', missing.join(', '));
		console.error('  Please copy .env.example to .env and configure your settings.');
		process.exit(1);
	}

	// Warn about optional keys
	if (!config.SUPERATOM_API_KEY) {
		console.warn('⚠ SUPERATOM_API_KEY not configured (optional)');
	}

	if (!config.ANTHROPIC_API_KEY && !config.GROQ_API_KEY && !config.GEMINI_API_KEY && !config.OPENAI_API_KEY && !config.OPENROUTER_API_KEY) {
		console.warn('⚠ No LLM API keys configured (ANTHROPIC_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY)');
	}

	// Only required by source types with secret config fields (currently just
	// NetSuite's privateKey — see database/postgres/.../project-sources.ts
	// SECRET_CONFIG_FIELDS). Not required for deployments without one configured,
	// so this warns rather than fails startup.
	if (!process.env.SOURCE_SECRET_ENCRYPTION_KEY) {
		console.warn('⚠ SOURCE_SECRET_ENCRYPTION_KEY not configured — creating/loading a source with encrypted config fields (e.g. NetSuite) will fail until it is set.');
	}

	if (config.OPENROUTER_API_KEY && !config.ANTHROPIC_API_KEY) {
		console.log('ℹ Using OpenRouter for Claude models (OPENROUTER_API_KEY set, ANTHROPIC_API_KEY not set)');
	}

	// A `sk-prox-…` key is a per-client LLM-proxy key, valid ONLY at our proxy.
	// Without SUPERATOM_LLM_PROXY_URL the SDK sends it straight to openrouter.ai,
	// which rejects it with "401 Missing Authentication header" on every request.
	// Fail fast at startup instead of letting every user prompt 401 at runtime.
	if (config.OPENROUTER_API_KEY?.startsWith('sk-prox-') && !process.env.SUPERATOM_LLM_PROXY_URL) {
		console.error('✗ OPENROUTER_API_KEY is a proxy key (sk-prox-…) but SUPERATOM_LLM_PROXY_URL is not set.');
		console.error('  The proxy key would be sent directly to openrouter.ai, which 401s ("Missing Authentication header").');
		console.error('  Set SUPERATOM_LLM_PROXY_URL (e.g. https://ai.superatom.ai) in backend/.env, then restart.');
		process.exit(1);
	}
}

validateConfig();

// Initialize SuperAtom SDK
const sdk = new SuperatomSDK({
	apiKey: config.SUPERATOM_API_KEY,
	projectId: config.SUPERATOM_PROJECT_ID!,
	bundleDir: config.BUNDLE_DIR,
	type: 'data-agent',
	...(config.SA_WEBSOCKET_URL && { url: config.SA_WEBSOCKET_URL }),
	databaseType: config.DATABASE_TYPE,
	locale: config.SA_LOCALE,
	currency: config.SA_CURRENCY,
	ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY || '',
	GROQ_API_KEY: config.GROQ_API_KEY || '',
	GEMINI_API_KEY: config.GEMINI_API_KEY || '',
	OPENAI_API_KEY: config.OPENAI_API_KEY || '',
	LLM_PROVIDERS: [
		// Keep 'anthropic' selected when an OpenRouter key is present (and no Anthropic key):
		// the SDK reuses the Claude flow and redirects it to OpenRouter at the LLM layer.
		...((config.ANTHROPIC_API_KEY || config.OPENROUTER_API_KEY) ? ['anthropic' as const] : []),
		...(config.GEMINI_API_KEY ? ['gemini' as const] : []),
		...(config.OPENAI_API_KEY ? ['openai' as const] : []),
		...(config.GROQ_API_KEY ? ['groq' as const] : [])
	],
	modelStrategy: 'fast',
	// Env overrides let us A/B a different model (e.g. openrouter/deepseek/deepseek-v4-pro)
	// without a code edit — any `provider/model` string the SDK's _parseModel understands.
	mainAgentModel: process.env.MAIN_AGENT_MODEL || 'openrouter/anthropic/claude-haiku-4.5',
	sourceAgentModel: process.env.SOURCE_AGENT_MODEL || 'openrouter/anthropic/claude-haiku-4.5',

	// WHICH FLOW ANSWERS A QUESTION — SA_ANSWER_FLOW:
	//   unset | 'coding-agent'  the answer-agent coding agent (default)
	//   'agents'                MainAgent + SourceAgent
	// The provider is registered either way, so flipping the env var and
	// restarting is the whole switch — no redeploy, and no code path that only
	// exists in one mode. Only the exact string 'agents' opts out, so a new
	// install needs no env var to get the coding agent.
	answerFlow: process.env.SA_ANSWER_FLOW === 'agents' ? 'agents' : 'custom',
	answerProvider: codingAgentAnswerProvider,
	dashCompModels: {
		model: process.env.DASH_COMP_MODEL || 'openrouter/anthropic/claude-sonnet-4.5',
	},
	conversationSimilarityThreshold: 0.95, // 95% similarity required for conversation matching
});

export async function SASDK() {
	console.log('Initializing SuperAtom SDK...\n');
	console.log(`Database type: ${config.DATABASE_TYPE}\n`);
	console.log(`Locale: ${config.SA_LOCALE} | Currency: ${config.SA_CURRENCY}\n`);
	console.log(`LLM usage logs: ${path.join(process.cwd(), 'llm-usage-logs.log')}`);
	console.log(`Error logs: ${ERROR_LOG_PATH}\n`);
	try {
		// Connect to SuperAtom
		await sdk.connect();
		console.log('✓ Successfully connected to SuperAtom!\n');

		// Initialize data sources (multi-source architecture)
		// This loads configured sources from project_sources table
		// and creates connectors for each (postgres, mssql, excel, salesforce, etc.)
		try {
			await initializeSources(config.SUPERATOM_PROJECT_ID!);
			const sourceManager = getSourceManager();
			if (sourceManager && sourceManager.getSourceCount() > 0) {
				console.log(`✓ Initialized ${sourceManager.getSourceCount()} data source(s)\n`);

				// Wire background refresh callback — when a file source auto-refreshes,
				// update SDK tools so the LLM sees the latest schema
				sourceManager.setOnRefreshCallback(() => {
					const updatedTools = getAllTools();
					sdk.setTools(updatedTools);
					console.log(`[BackgroundRefresh] SDK tools refreshed (${updatedTools.length} total)`);
					// Owned-source set may have changed — re-announce to the DO registry.
					reregisterSourceProxy();
				});
			} else {
				console.log('ℹ No additional data sources configured\n');
			}
		} catch (sourceError) {
			// Don't fail if sources can't be initialized - allow fallback to static tools
			console.warn('⚠ Could not initialize data sources:', sourceError);
		}

		// Store tools in SDK (dynamic source tools + static tools)
		// getAllTools() returns source-generated tools + STATIC_TOOLS
		const allTools = getAllTools();
		sdk.setTools(allTools);
		console.log(`✓ Tools stored in SDK (${allTools.length} total)\n`);

		// Start script bridge HTTP server — exposes /query and /run-tool for the
		// sandboxed "scripts flow" child process, which can't reach
		// sdk.getTools()/sdk.callCollection() in-process the way the dashboard
		// agent now does (native tools — see sdk-nodejs/src/dashboardAgent/tools.ts).
		// Sets SCRIPT_BRIDGE_URL in process.env so that child process inherits it
		// automatically.
		await startScriptBridge();

		// Start the source-proxy WebSocket — registers this deployment's sources
		// in the project's Durable Object registry and lets scripts reach sources
		// that live on other machines. See docs/cross-machine-source-proxy.md.
		await startSourceProxy(config.SUPERATOM_PROJECT_ID!);

		// Register all collections
		await registerAllCollections(sdk);

		// Keep this engine's copy of the platform's semantic graph current.
		// No-op unless SA_GRAPH_REPLICATION=on (services/graph-replica.ts).
		startGraphReplica(sdk);

		// Wire alert scheduler
		alertScheduler.registerSourceProvider(async (sourceId: string, _projectId: string) => {
			const sourceManager = getSourceManager();
			if (!sourceManager) return null;
			const instance = sourceManager.getInstance(sourceId);
			if (!instance) return null;
			return async (query: string) => {
				// No user behind a scheduled alert — declare the trust explicitly
				// so the data seam can tell "trusted job" from "identity lost".
				const result = await runAsSystem('alert-scheduler', () => instance.execute({ sql: query }));
				return result.data || [];
			};
		});

		alertScheduler.registerTriggerCallback(async (alert: any, result: any) => {
			// Get report name for email context
			let reportName = 'Unknown Report';
			try {
				const reports = await import('../../database/postgres/src/project-data-db/reports');
				const { data } = await reports.queryReports({ filters: { reportId: alert.reportId }, limit: 1 });
				if (data.length > 0) reportName = data[0].name || reportName;
			} catch {}

			// Build report URL for email link (org subdomain when resolvable)
			const appBaseUrl = getAppBaseUrl();
			const reportUrl = `${appBaseUrl}/apps/${alert.projectId}/report/${alert.reportId}`;

			// Build chat agent URL for deep-dive
			const chatUrl = `${appBaseUrl}/${alert.projectId}/ui`;

			// Run AI analysis (best-effort)
			const sourceTools = getAllTools();
			const analysisResult = await analyzeAlert(
				alert, result.currentValue, result.reason, reportName,
				sourceTools, config.ANTHROPIC_API_KEY,
			);

			// Record in alert_history
			await reportAlertsService.createAlertHistory({
				alertId: alert.alertId,
				value: result.currentValue,
				reason: result.reason,
				analysis: analysisResult.analysis,
			});

			// Send email
			if (alert.recipients && alert.recipients.length > 0) {
				await sendAlertEmail({
					recipients: alert.recipients,
					alertName: alert.name,
					reportName,
					reportUrl,
					chatUrl,
					metricDescription: alert.metricDescription,
					currentValue: result.currentValue,
					reason: result.reason,
					analysis: analysisResult.analysis,
					checkedAt: result.checkedAt,
					emailSubject: alert.emailSubject,
				});
			}
		});

		alertScheduler.start();
		console.log('✓ Alert scheduler initialized\n');

		reportScheduler.start();
		console.log('✓ Report scheduler initialized\n');

		traceCleanupScheduler.start();
		console.log('✓ Trace cleanup scheduler initialized\n');

		// Registers this deployment's coding agents and arms their triggers.
		// Each agent declares its own trigger, so nothing schedules them here.
		initCodingAgents();
		console.log('✓ Coding agents initialized\n');

		// The schema index the agent's find-schema/get-schema read. Kept current on
		// every schema or semantic-model write; this builds any source that has
		// none yet. Queued, so startup does not wait for it.
		backfillDataSourceIndex(config.SUPERATOM_PROJECT_ID!)
			.then(n => console.log(n ? `✓ Data source index: building ${n} source(s) with no index\n` : '✓ Data source index: every source indexed\n'))
			.catch(err => console.warn('✗ Data source index backfill failed:', err?.message ?? err));

		console.log('🚀 SuperAtom SDK is ready!\n');

	} catch (error) {
		console.error('✗ Failed to initialize SuperAtom SDK:', error);
		process.exit(1);
	}
}
