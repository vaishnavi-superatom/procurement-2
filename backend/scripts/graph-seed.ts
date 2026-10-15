/**
 * Seed the two engine-owned domains: `shared` (the parts every domain composes
 * with) and `generic` (the fallback). Authored domains come from
 * `graph-import.ts` — this script owns only what the code depends on.
 *
 * `generic` is what an unrouted question composes, so the fallback is a domain
 * like any other and today's behaviour is preserved exactly — the difference is
 * that editing a shared part now improves both paths at once.
 *
 * The parts come from the answer agent's system.md, one per `##` section. A part
 * that already exists is left as it is: once seeded, the admin UI owns its text,
 * and a re-run only adds parts system.md gained since. --reseed overwrites them
 * all from system.md (a deliberate reset).
 *
 *   pnpm tsx scripts/graph-seed.ts [--publish] [--reseed]
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';
dotenv.config({ path: resolve(__dirname, '../.env') });
import { putNode, getNode, setDomainMembers, setDomainStatus, setDomainTerms, getPublishedDomain } from '../../database/postgres/src/project-data-db/graph';

const PUBLISH = process.argv.includes('--publish');
const RESEED = process.argv.includes('--reseed');
const status = PUBLISH ? 'published' : 'draft';

type Member = { nodeId?: number; conceptName?: string; role: 'prompt' | 'concept'; position: number };

/**
 * A seeded domain: created with these members, or, when it exists, kept as edited
 * with only the parts it lacks appended.
 */
async function seedDomain(d: { name: string; title: string; body: string; meta: Record<string, any> }, wanted: Member[]) {
	const existing = await getNode('domain', d.name);
	if (!existing || RESEED) {
		const node = await putNode({ kind: 'domain', ...d, status, origin: 'import' });
		await setDomainMembers(node.id, wanted);
		return { added: wanted.length, kept: 0 };
	}
	const current = (await getPublishedDomain(d.name))?.members ?? [];
	const have = new Set(current.map(m => m.node?.id).filter(Boolean));
	const missing = wanted.filter(m => m.nodeId && !have.has(m.nodeId));
	if (missing.length || !current.length) {
		const kept: Member[] = current.map(m => m.node
			? { nodeId: m.node.id, role: m.role as Member['role'], position: m.position }
			: { conceptName: m.concept?.name ?? m.missingConcept, role: m.role as Member['role'], position: m.position });
		const last = Math.max(-1, ...kept.map(m => m.position));
		await setDomainMembers(existing.id, [...kept, ...missing.map((m, i) => ({ ...m, position: last + 1 + i }))]);
	}
	if (PUBLISH && existing.status !== 'published') await setDomainStatus(existing.id, 'published');
	return { added: missing.length, kept: current.length };
}

/**
 * The workspace layout is the ENVIRONMENT: same for every domain, changes with
 * the code and not with the graph.
 */
const BASE_OWNS = new Set(['your-workspace']);

/**
 * Exploration belongs to `generic` alone. The full tool inventory and the
 * "confirm every column, look up every term" obligations are what a run does
 * when nothing is known — and measured, they kept a routed run at the baseline's
 * 19 tool calls even though its domain already stated the grain and the joins.
 * An authored domain states what is settled; these parts would tell the agent to
 * go and settle it again.
 */
const EXPLORATION = new Set(['your-data-access', 'before-you-write-any-sql']);

/** Split the current prompt on its own headings: one subject, one part. */
function partsFromPrompt(md: string): Array<{ name: string; title: string; body: string }> {
	const out: Array<{ name: string; title: string; body: string }> = [];
	const sections = md.split(/\n(?=## )/);
	for (const s of sections) {
		const m = s.match(/^## (.+)$/m);
		if (!m) continue;                       // the title block: it becomes base.md
		const title = m[1].trim();
		const name = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
		if (BASE_OWNS.has(name)) continue;
		out.push({ name, title, body: s.trim() });
	}
	return out;
}

async function main() {
	const promptFile = resolve(__dirname, '../.prompts/coding-agents/answer-agent/system.md');
	const all = partsFromPrompt(readFileSync(promptFile, 'utf-8'));
	const sharedNodes = [], exploreNodes = [];
	const keptParts: string[] = [];
	for (const p of all) {
		// An existing part is the admin's: its text is never replaced, except by --reseed.
		const existing = RESEED ? null : await getNode('part', p.name);
		if (existing) keptParts.push(p.name);
		const node = existing ?? await putNode({ kind: 'part', name: p.name, title: p.title, body: p.body, status, origin: 'import' });
		(EXPLORATION.has(p.name) ? exploreNodes : sharedNodes).push(node);
	}
	console.log(`parts from system.md: ${sharedNodes.length} shared, ${exploreNodes.length} exploration-only; `
		+ `${all.length - keptParts.length} written, ${keptParts.length} kept as edited${keptParts.length ? ' (--reseed to overwrite)' : ''}`);

	// shared — not routed to; the parts every authored domain composes with. Its
	// own domain node so the viewer can show it and a person can edit it.
	const shared = await seedDomain(
		{ name: 'shared', title: 'Shared (every domain)', body: '', meta: { shared: true, threshold: 9999 } },
		sharedNodes.map((n, i) => ({ nodeId: n.id, role: 'prompt' as const, position: i })));

	// generic — the fallback, composed like any other domain.
	// Exploration first: with no domain knowledge, how to find things IS the method.
	const generic = await seedDomain(
		{ name: 'generic', title: 'Generic (fallback)',
			body: 'Answer the question from the data sources you can reach, working from first principles: no domain covers it yet.',
			meta: { threshold: 0, fallback: true } },
		[...exploreNodes.map((n, i) => ({ nodeId: n.id, role: 'prompt' as const, position: i })),
		 ...sharedNodes.map((n, i) => ({ nodeId: n.id, role: 'prompt' as const, position: 10 + i }))]);

	console.log(`seeded: shared (+${shared.added}, ${shared.kept} kept), generic (+${generic.added}, ${generic.kept} kept), status=${status}`);
	if (PUBLISH) {
		for (const n of ['shared', 'generic']) {
			const d = await getPublishedDomain(n);
			console.log(`  ${n}: ${d ? `${d.members.length} members, hash ${d.hash.slice(0, 12)}…` : 'NOT published'}`);
		}
	} else {
		console.log('draft only — re-run with --publish to make it live');
	}
	process.exit(0);
}
main().catch(e => { console.error(e?.stack ?? e); process.exit(1); });
