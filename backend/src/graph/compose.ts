import * as fs from 'fs';
import * as path from 'path';
import type { ComposedDomain, DomainMember } from '../../../database/postgres/src/project-data-db/graph';

/**
 * A domain becomes a prompt and a folder.
 *
 * This is the whole point of the graph: the agent opens a question already
 * knowing the grain, the joins and the definitions for its area, instead of
 * rediscovering them. Measured, that rediscovery is 16 tool calls and 365k
 * tokens on a question we have answered a hundred times.
 *
 * Composition is pure: same hash, same bytes. The hash is what makes an edit to
 * a shared part re-place every workspace that uses it, and only those.
 */

export interface Composition {
	/** Goes to the agent's system.md, after base.md. */
	prompt: string;
	/** Workspace-relative path -> contents. */
	files: Record<string, string>;
	hash: string;
	domainName: string;
}

const conceptKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Names and aliases of the concepts in one output, for renderConcept's `loaded`. */
export function loadedConcepts(cs: any[]): Set<string> {
	return new Set(cs.flatMap(c => [c.name, ...(c.aliases ?? [])]).filter(Boolean).map(conceptKey));
}

/**
 * A concept as the agent reads it, in the prompt and from `tools/get-concept`
 * alike — identical, or it re-fetches what it already has. Description, aliases
 * and returns.type serve search and routing, so they are left out; a require
 * already in the same output is noise, a missing one becomes a fetch instruction.
 */
export function renderConcept(c: any, loaded: Set<string>, note = ''): string {
	const out = [`=== ${c.name}${note}`, '', String(c.body).trim()];
	const r = c.returns ?? {};
	if (r.unit) out.push(`Unit: ${r.unit}`);
	if (r.grain) out.push(`Grain: ${r.grain}`);
	const caveats = (r.caveats ?? []).filter(Boolean);
	if (caveats.length) out.push('Caveats:', ...caveats.map((x: string) => `- ${x}`));
	const absent = (c.requires ?? []).filter((n: string) => !loaded.has(conceptKey(n)));
	if (absent.length) out.push(`Also needs ${absent.map((n: string) => `"${n}"`).join(', ')}, not loaded: run tools/get-concept for it.`);
	out.push('');
	return out.join('\n');
}

/**
 * The domain's concepts, as one section of the prompt.
 *
 * Pre-loading rather than letting the agent search is the whole mechanism: asked
 * to look things up it made 16 tool calls, and telling it not to did not survive
 * a follow-up turn. Knowledge already in the prompt has nothing to fetch.
 */
function conceptSection(members: DomainMember[], ctx: ComposeContext): string {
	const invariants = ctx.invariants ?? [];
	const invariantNames = new Set(invariants.map(c => conceptKey(c.name)));
	// A domain may list an invariant too; it is already printed above.
	const inlined = members.filter(m => m.role === 'concept' && m.concept && !invariantNames.has(conceptKey(m.concept.name)))
		.sort((a, b) => a.position - b.position).map(m => m.concept);
	const missing = members.filter(m => m.missingConcept).map(m => m.missingConcept);
	const loaded = loadedConcepts([...invariants, ...inlined]);

	const out: string[] = [];
	if (invariants.length) {
		out.push('## Project-wide rules — apply to every question', '',
			...invariants.map(c => renderConcept(c, loaded)));
	}
	if (inlined.length) {
		out.push('## Domain definitions — apply as written; every filter stated is required. Do not look them up again.', '',
			...inlined.map(c => renderConcept(c, loaded)));
	}
	// A domain naming a concept the store does not have is an authoring error;
	// saying so beats answering from a silently smaller definition set.
	if (missing.length) out.push(`Not available: ${missing.map(m => `"${m}"`).join(', ')}. Treat that knowledge as absent; say so if the question needs it.`);
	return out.join('\n');
}

export interface ComposeContext {
	/** Always-on concepts, injected whatever the question. */
	invariants?: any[];
	/**
	 * Parts every domain gets: the answer contract, the traps, the rules. An
	 * authored domain lists only its own knowledge, so these come from the engine
	 * — otherwise a new domain would compose without an answer format at all.
	 */
	shared?: DomainMember[];
}

export function compose(c: ComposedDomain, ctx: ComposeContext = {}): Composition {
	const ordered = (role: string) => c.members
		.filter(m => m.role === role)
		.sort((a, b) => a.position - b.position);

	const files: Record<string, string> = {};
	for (const m of ordered('file')) {
		const p = String(m.node!.meta?.path ?? `${m.node.name}.md`);
		// A path that climbs out of the workspace is an authoring mistake, and a
		// silent one — it would write into the repo.
		if (p.includes('..') || path.isAbsolute(p)) throw new Error(`file node "${m.node!.name}" has an unsafe path: ${p}`);
		files[p] = m.node!.body;
	}

	// One settings.json, the domain's own value winning over a shared one.
	const settings: Record<string, unknown> = {};
	for (const m of ordered('setting')) {
		const key = String(m.node!.meta?.key ?? m.node!.name);
		settings[key] = m.node!.meta?.value;
	}
	if (Object.keys(settings).length) files['settings.json'] = `${JSON.stringify(settings, null, 2)}\n`;

	for (const m of ordered('program')) {
		files[`programs/${m.node!.name}.sql`] = m.node!.body;
	}

	// The prompt names the placed files, so nothing has to go looking: a domain
	// with no files never mentions a folder, and the agent never lists an empty one.
	const paths = Object.keys(files).sort();
	const index = paths.length
		? ['## Domain files', '', ...paths.map(p => `    domain/${p}`), '', 'Read these before querying: they are this domain\'s working knowledge.'].join('\n')
		: '';

	const prompt = [
		// The domain's own body states its scope — including what it does NOT
		// answer, so a near-miss can be declined rather than forced.
		c.domain.body.trim(),
		// Definitions before method: the shared parts below qualify the domain's
		// knowledge, not the other way round.
		conceptSection(c.members, ctx),
		...ordered('prompt').map(m => m.node!.body.trim()),
		// The domain's own parts first: the shared rules qualify its knowledge,
		// not the other way round.
		...(ctx.shared ?? []).filter(m => m.node).sort((a, b) => a.position - b.position).map(m => m.node!.body.trim()),
		index,
	].filter(Boolean).join('\n\n');

	return { prompt, files, hash: c.hash, domainName: c.domain.name };
}

/** The hash of what is currently on disk, so an unchanged domain is not rewritten. */
const STAMP = '.graph-hash';

export function placedHash(workspaceDir: string): string | null {
	try { return fs.readFileSync(path.join(workspaceDir, STAMP), 'utf-8').trim() || null; }
	catch { return null; }
}

/**
 * Write the composition into the workspace, replacing what a previous domain
 * left. Returns false when the hash already matches — the common case, and the
 * reason a second question in a thread costs nothing to set up.
 */
export function place(workspaceDir: string, comp: Composition): boolean {
	if (placedHash(workspaceDir) === comp.hash) return false;

	// Everything the graph owns lives under one directory, so replacing a domain
	// cannot leave another's files behind.
	const root = path.join(workspaceDir, 'domain');
	fs.rmSync(root, { recursive: true, force: true });
	for (const [rel, body] of Object.entries(comp.files)) {
		const dest = path.join(root, rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, body);
	}
	fs.writeFileSync(path.join(workspaceDir, STAMP), `${comp.hash}\n`);
	return true;
}
