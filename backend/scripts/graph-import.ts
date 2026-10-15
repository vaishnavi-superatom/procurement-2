/**
 * Import an authored composition graph: domains, their concept members, and the
 * routing terms.
 *
 * The authored file is authoritative — membership and terms are replaced
 * wholesale, so deleting a line in the file deletes the edge. Concept names are
 * matched EXACTLY against the store: a name that does not resolve fails the
 * import instead of being repaired, because a compose-time correction is silent
 * and permanent.
 *
 *   pnpm tsx scripts/graph-import.ts <domains.md|yaml> [--publish] [--keep-others]
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';
dotenv.config({ path: resolve(__dirname, '../.env') });
import { putNode, setDomainMembers, setDomainTerms, getPublishedDomain, retireDomainsExcept } from '../../database/postgres/src/project-data-db/graph';
import { getAllConcepts } from '../../database/postgres/src/project-data-db/concepts';

const FILE = process.argv[2];
const PUBLISH = process.argv.includes('--publish');
const KEEP_OTHERS = process.argv.includes('--keep-others');
if (!FILE) { console.error('usage: graph-import.ts <file> [--publish] [--keep-others]'); process.exit(1); }

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

interface Parsed {
	domains: Array<{ name: string; body: string; meta: Record<string, any> }>;
	members: Array<{ domain: string; concept: string; position: number }>;
	terms: Array<{ domain: string; term: string; weight: number }>;
}

/** The authored format is a yaml block of nodes / members / terms. */
function parse(md: string): Parsed {
	const domains = [...md.matchAll(/- kind: domain\s*\n\s*name:\s*(\S+)\s*\n\s*body:\s*>\s*\n([\s\S]*?)\n\s*meta:\s*(\{[^}]*\})/g)]
		.map(m => ({
			name: m[1].trim(),
			body: m[2].split('\n').map(l => l.trim()).filter(Boolean).join(' '),
			// The meta is yaml-ish inline; only the keys we act on are read.
			meta: {
				threshold: Number(m[3].match(/threshold:\s*(\d+)/)?.[1] ?? 2),
				fallbackAllowed: /fallbackAllowed:\s*true/.test(m[3]),
			},
		}));
	const members = [...md.matchAll(/\{\s*domain:\s*(\w+),\s*concept:\s*"([^"]+)",\s*role:\s*concept,\s*position:\s*(\d+)\s*\}/g)]
		.map(m => ({ domain: m[1], concept: m[2], position: Number(m[3]) }));
	const terms = [...md.matchAll(/\{\s*domain:\s*(\w+),\s*term:\s*"?([^",}]+?)"?,\s*weight:\s*(\d+)\s*\}/g)]
		.map(m => ({ domain: m[1], term: m[2].trim(), weight: Number(m[3]) }));
	return { domains, members, terms };
}

async function main() {
	const p = parse(readFileSync(FILE, 'utf-8'));
	console.log(`${p.domains.length} domains, ${p.members.length} concept members, ${p.terms.length} terms`);

	// Exact-match gate, before anything is written.
	const known = new Set<string>();
	for (const c of (await getAllConcepts({ verifiedOnly: true })).data as any[]) {
		known.add(key(c.name));
		for (const a of c.aliases ?? []) if (a) known.add(key(a));
	}
	const unresolvable = p.members.filter(m => !known.has(key(m.concept)));
	if (unresolvable.length) {
		console.error(`\n${unresolvable.length} concept name(s) do not exist in the store — nothing was written:`);
		for (const m of unresolvable) console.error(`  ${m.domain}: "${m.concept}"`);
		process.exit(1);
	}

	const status = PUBLISH ? 'published' : 'draft';
	const names: string[] = [];
	for (const d of p.domains) {
		const node = await putNode({
			kind: 'domain', name: d.name, title: d.name.replace(/_/g, ' '),
			body: d.body, meta: d.meta, status, origin: 'import',
		});
		names.push(d.name);
		const mine = p.members.filter(m => m.domain === d.name).sort((a, b) => a.position - b.position);
		await setDomainMembers(node.id, mine.map(m => ({ conceptName: m.concept, role: 'concept' as const, position: m.position })));
		await setDomainTerms(node.id, p.terms.filter(t => t.domain === d.name));
		console.log(`  ${d.name.padEnd(26)} ${String(mine.length).padStart(2)} concepts  ${String(p.terms.filter(t => t.domain === d.name).length).padStart(2)} terms  threshold ${d.meta.threshold}`);
	}

	// A domain the file no longer contains would otherwise keep routing questions
	// to knowledge nobody maintains. The engine-owned two always stay: `generic`
	// is the fallback, `shared` holds the parts every domain composes with.
	const ENGINE_OWNED = ['generic', 'shared'];
	if (!KEEP_OTHERS) {
		const retired = await retireDomainsExcept([...names, ...ENGINE_OWNED]);
		if (retired.length) console.log(`\nretired (not in the file): ${retired.join(', ')}`);
	}

	if (PUBLISH) {
		console.log('');
		for (const n of names) {
			const d = await getPublishedDomain(n);
			const concepts = d?.members.filter(m => m.role === 'concept' && m.concept).length ?? 0;
			console.log(`  ${n.padEnd(26)} hash ${d?.hash.slice(0, 12)}…  ${concepts} resolved${d?.missing.length ? `  MISSING ${d.missing.join(', ')}` : ''}`);
		}
	} else {
		console.log('\ndraft only — re-run with --publish to make it live');
	}
	process.exit(0);
}
main().catch(e => { console.error(e?.stack ?? e); process.exit(1); });
