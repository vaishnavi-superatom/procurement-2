/**
 * Prefetch Report Data Script
 *
 * After reports are seeded into the DB, this script:
 * 1. Reads all reports for the project
 * 2. Finds all components that have SQL queries (via externalTool or query prop)
 * 3. Executes each query against the appropriate source database
 * 4. Embeds the results into config.data so components don't fetch on render
 *
 * Usage:
 *   PROJECT_DATABASE_URL=... SUPERATOM_PROJECT_ID=... pnpm tsx scripts/prefetch-report-data.ts
 */

import pg from 'pg';

const { Client } = pg;

const PROJECT_DATABASE_URL = process.env.PROJECT_DATABASE_URL;
const PROJECT_ID = process.env.SUPERATOM_PROJECT_ID;

if (!PROJECT_DATABASE_URL) {
	console.error('PROJECT_DATABASE_URL is required');
	process.exit(1);
}

if (!PROJECT_ID) {
	console.error('SUPERATOM_PROJECT_ID is required');
	process.exit(1);
}

interface SourceConfig {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	schema?: string;
	ssl?: boolean;
}

interface ComponentDef {
	id: string;
	type: string;
	name?: string;
	props?: {
		query?: string | { sql: string; params?: Record<string, any> } | null;
		externalTool?: {
			toolId: string;
			toolName: string;
			parameters: { sql?: string; params?: Record<string, any> };
		} | null;
		config?: Record<string, any>;
	};
}

/**
 * Extract SQL query from a component definition.
 * Components can have queries via:
 * - externalTool.parameters.sql
 * - props.query (string or { sql, params })
 */
function extractQuery(comp: ComponentDef): string | null {
	const props = comp.props;
	if (!props) return null;

	// externalTool takes priority
	if (props.externalTool?.parameters?.sql) {
		return props.externalTool.parameters.sql;
	}

	// Direct query prop
	if (props.query) {
		if (typeof props.query === 'string') {
			// Could be plain SQL or JSON-encoded
			try {
				const parsed = JSON.parse(props.query);
				if (parsed.sql) return parsed.sql;
			} catch {
				return props.query;
			}
		} else if (typeof props.query === 'object' && 'sql' in props.query) {
			return props.query.sql;
		}
	}

	return null;
}

/**
 * Extract tool ID (source ID) from a component definition.
 * Tool IDs are formatted as "{sourceId}_query".
 */
function extractSourceId(comp: ComponentDef): string | null {
	const toolId = comp.props?.externalTool?.toolId;
	if (!toolId) return null;
	// Strip _query or _read suffix
	return toolId.replace(/_(query|read)$/, '');
}

/**
 * Recursively find all components in a DSL tree.
 */
function findAllComponents(node: any): ComponentDef[] {
	const components: ComponentDef[] = [];

	if (!node) return components;

	// If this node has a type and props, it's a component
	if (node.type && node.props) {
		components.push(node as ComponentDef);
	}

	// Check nested components in config
	if (node.props?.config?.components && Array.isArray(node.props.config.components)) {
		for (const child of node.props.config.components) {
			components.push(...findAllComponents(child));
		}
	}

	// Check children array
	if (node.children && Array.isArray(node.children)) {
		for (const child of node.children) {
			components.push(...findAllComponents(child));
		}
	}

	return components;
}

async function main() {
	console.log('============================================');
	console.log(' Report Data Prefetch');
	console.log('============================================\n');

	const projectClient = new Client({ connectionString: PROJECT_DATABASE_URL });
	await projectClient.connect();
	console.log('Connected to project database\n');

	try {
		// 1. Load all source configs for this project
		const sourcesResult = await projectClient.query(
			`SELECT id, name, type, config FROM project_sources WHERE project_id = $1 AND is_active = true`,
			[PROJECT_ID],
		);

		const sourceConfigs = new Map<string, { name: string; config: SourceConfig }>();
		for (const row of sourcesResult.rows) {
			sourceConfigs.set(row.id, { name: row.name, config: row.config });
		}
		console.log(`Found ${sourceConfigs.size} active source(s)\n`);

		// 2. Create connection pool per source (lazy)
		const sourceClients = new Map<string, pg.Client>();

		const getSourceClient = async (sourceId: string): Promise<pg.Client | null> => {
			if (sourceClients.has(sourceId)) return sourceClients.get(sourceId)!;

			const source = sourceConfigs.get(sourceId);
			if (!source) {
				console.warn(`  ⚠ Source not found: ${sourceId}`);
				return null;
			}

			const cfg = source.config;
			const client = new Client({
				host: cfg.host,
				port: cfg.port,
				database: cfg.database,
				user: cfg.user,
				password: cfg.password,
				ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
			});

			await client.connect();
			sourceClients.set(sourceId, client);
			console.log(`  Connected to source: ${source.name} (${sourceId})`);
			return client;
		};

		// 3. Load all reports for this project
		const reportsResult = await projectClient.query(
			`SELECT id, report_id, name, report FROM reports WHERE project_id = $1`,
			[PROJECT_ID],
		);

		console.log(`\nFound ${reportsResult.rows.length} report(s) to process\n`);

		let totalPrefetched = 0;
		let totalErrors = 0;

		for (const report of reportsResult.rows) {
			const reportDsl = report.report;
			if (!reportDsl?.dsl?.render) {
				console.log(`  Skipping "${report.name}" — no DSL render tree`);
				continue;
			}

			console.log(`Processing: ${report.name}`);

			// Find all components with queries
			const allComponents = findAllComponents(reportDsl.dsl.render);
			const queryComponents = allComponents.filter((c) => extractQuery(c) !== null);

			if (queryComponents.length === 0) {
				console.log(`  No query components found\n`);
				continue;
			}

			console.log(`  Found ${queryComponents.length} component(s) with queries`);

			let modified = false;

			for (const comp of queryComponents) {
				const sql = extractQuery(comp)!;
				const sourceId = extractSourceId(comp);

				if (!sourceId) {
					// Try direct query — use the first available source as fallback
					console.log(`  ⚠ ${comp.id}: no source ID, skipping`);
					totalErrors++;
					continue;
				}

				try {
					const client = await getSourceClient(sourceId);
					if (!client) {
						totalErrors++;
						continue;
					}

					const result = await client.query(sql);
					const data = result.rows;

					// Embed data into config.data
					if (!comp.props!.config) {
						comp.props!.config = {};
					}
					comp.props!.config.data = data;

					console.log(`  ✓ ${comp.id} (${comp.type}): ${data.length} row(s)`);
					modified = true;
					totalPrefetched++;
				} catch (err: any) {
					console.error(`  ✗ ${comp.id}: ${err.message}`);
					totalErrors++;
				}
			}

			// 4. Update report in DB with embedded data
			if (modified) {
				await projectClient.query(
					`UPDATE reports SET report = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
					[JSON.stringify(reportDsl), report.id],
				);
				console.log(`  → Report updated in DB\n`);
			} else {
				console.log(`  → No changes\n`);
			}
		}

		// Cleanup source connections
		for (const [, client] of sourceClients) {
			await client.end();
		}

		console.log('============================================');
		console.log(` Done: ${totalPrefetched} prefetched, ${totalErrors} errors`);
		console.log('============================================');
	} finally {
		await projectClient.end();
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
