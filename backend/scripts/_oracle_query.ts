/**
 * Run SQL straight against a project source, bypassing the agent — the yardstick
 * for grading an agent answer.
 *
 *   npx tsx scripts/_oracle_query.ts "SELECT ..."            first mssql source
 *   npx tsx scripts/_oracle_query.ts --source <id> "SELECT ..."
 *   npx tsx scripts/_oracle_query.ts --file q.sql
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';
dotenv.config({ path: resolve(__dirname, '../.env') });

import sql from 'mssql';
import { getProjectSources } from '../../database/postgres/src/project-data-db/project-sources';

async function main() {
	const args = process.argv.slice(2);
	let sourceId: string | undefined;
	let query = '';
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--source') sourceId = args[++i];
		else if (args[i] === '--file') query = readFileSync(args[++i], 'utf8');
		else query ||= args[i];
	}
	if (!query.trim()) { console.error('no query'); process.exit(2); }

	const sources = (await getProjectSources(process.env.SUPERATOM_PROJECT_ID!)).data as any[];
	const src = sources.find(s => (sourceId ? s.id === sourceId : s.type === 'mssql'));
	if (!src) { console.error('no mssql source'); process.exit(2); }
	const cfg = typeof src.config === 'string' ? JSON.parse(src.config) : src.config;

	const pool = await sql.connect({
		server: cfg.host || cfg.server, port: cfg.port ? Number(cfg.port) : 1433,
		database: cfg.database, user: cfg.user || cfg.username, password: cfg.password,
		options: { encrypt: !!cfg.encrypt, trustServerCertificate: true },
		requestTimeout: 300000,
	});
	const res = await pool.request().query(query);
	console.log(JSON.stringify(res.recordset, null, 2));
	await pool.close();
	process.exit(0);
}
main().catch(e => { console.error(e?.message ?? e); process.exit(1); });
