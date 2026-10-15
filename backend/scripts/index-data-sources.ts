/**
 * Rebuild data_source_index by hand. Normally unnecessary: the backend rebuilds
 * a source whenever its stored schema or semantic model is written, and builds
 * any unindexed source at startup (reindexSource in data-source-index.ts — the
 * semantic model when the source has one, the raw schema otherwise).
 *
 * A projection, not a live extraction: it reads project_sources, never a
 * customer database.
 *
 *   pnpm tsx scripts/index-data-sources.ts            every active source
 *   pnpm tsx scripts/index-data-sources.ts <sourceId> one source
 *   pnpm tsx scripts/index-data-sources.ts --stats    what is indexed now
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
import { getProjectSources } from '../../database/postgres/src/project-data-db/project-sources';
import { reindexSource, getIndexFreshness, notInModelLine } from '../../database/postgres/src/project-data-db/data-source-index';

dotenv.config({ path: resolve(__dirname, '../.env') });

async function main() {
	const arg = process.argv[2];

	if (arg === '--stats') {
		const rows = await getIndexFreshness();
		if (!rows.length) console.log('nothing indexed yet');
		for (const r of rows) {
			console.log(`${r.sourceName}: ${r.tables} tables, ${r.columns} columns, from ${r.indexedFrom}, indexed ${r.indexedAt}`);
		}
		process.exit(0);
	}

	const projectId = process.env.SUPERATOM_PROJECT_ID;
	if (!projectId) { console.error('SUPERATOM_PROJECT_ID is not set'); process.exit(2); }

	const sources = ((await getProjectSources(projectId)).data as any[])
		.filter(s => !arg || s.id === arg);
	if (!sources.length) { console.error(arg ? `no source ${arg}` : 'no active sources'); process.exit(2); }

	for (const s of sources) {
		const r = await reindexSource(s.id);
		console.log(r
			? `${s.id} (${s.name}): ${r.tables} tables, ${r.columns} columns from ${r.from}`
			: `${s.id} (${s.name}): no schema to index — skipped`);
		if (r?.notInModel.length) console.log(notInModelLine(s.id, r.notInModel));
	}
	process.exit(0);
}

main().catch(e => { console.error(e?.stack ?? e); process.exit(1); });
