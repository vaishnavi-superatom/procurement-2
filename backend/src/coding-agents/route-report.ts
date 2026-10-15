import type { RouteInfo } from './answer-agent';
import type { RunUsage } from '../services/run-usage';
import { publishedDomainConcepts } from '../../../database/postgres/src/project-data-db/graph';
import { getAllConcepts } from '../../../database/postgres/src/project-data-db/concepts';
import { scoreDomains } from '../graph/router';

/**
 * Why an answer used the domain it did, and what that domain turned out to lack —
 * for the people who author domains and concepts. Everything here is measured
 * from the route and the run's own lookups; nothing is the model's opinion.
 */

const HOW: Record<string, string> = {
	index: 'matched words in the question',
	tie: 'tied with another domain; settled by domain priority',
	llm: 'close call between two domains, settled by the model',
	sticky: 'follow-up question: stayed in the thread\'s domain',
	fallback: 'no domain matched',
};

const nice = (name: string) => { const s = name.replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

/** The Domain step: which domain, and why. */
export function domainStep(info: RouteInfo): { label: string; badge?: string; body: string } {
	const d = info.decision;
	if (d.decidedBy === 'fallback') {
		return {
			label: 'Domain: none matched',
			body: 'No domain\'s words matched this question, so the agent starts from the general instructions and looks up definitions itself.',
		};
	}
	const lines = [`**How it was chosen:** ${HOW[d.decidedBy] ?? d.decidedBy}`];
	if (d.matched.length) lines.push(`**Matched words:** ${d.matched.map(m => `${m.term} (${m.weight})`).join(', ')} — score ${+d.score.toFixed(2)}`);
	if (d.runnerUp) lines.push(`**Runner-up:** ${nice(d.runnerUp.domainName)} (score ${+d.runnerUp.score.toFixed(2)})`);
	const loaded = [...new Set(info.conceptNames)];
	lines.push(`**Definitions loaded (${loaded.length}):** ${loaded.join(', ') || 'none'}`);
	if (info.missing.length) lines.push(`**Listed in this domain but missing from the concepts:** ${info.missing.join(', ')}`);
	return { label: `Domain: ${nice(info.title)}`, badge: d.decidedBy === 'sticky' ? 'follow-up' : `score ${+d.score.toFixed(1)}`, body: lines.join('\n\n') };
}

export interface RouteGaps {
	domain: string;
	unrouted: boolean;
	/** Concepts fetched that the domain does not include, with the domains that do. */
	outsideConcepts: Array<{ name: string; inDomains: string[] }>;
	/** Searches and names that matched no concept at all. */
	noConcept: string[];
	/** Tables looked up or queried that the domain's instructions never mention. */
	tablesNotDescribed: string[];
	/** Concept names the domain lists that do not exist. */
	missingInDomain: string[];
	// Context, gathered only when one of the gaps above is real:
	/** Other domains the question also matched, on words the routed one did not. */
	alsoMatched?: Array<{ domain: string; score: number; terms: string[] }>;
	/** Concepts that already describe an undescribed table, with their domains. */
	describedBy?: Array<{ table: string; concepts: Array<{ name: string; inDomains: string[] }> }>;
	/** Join conditions the agent wrote on undescribed tables: a draft of the missing concept. */
	joins?: string[];
	/** Queries that failed, by their error. */
	failedQueries?: string[];
}

const SQL_KEYWORDS = new Set(['on', 'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'group', 'order', 'with', 'as', 'union', 'having', 'select', 'and', 'or']);

/** Tables a statement reads, and its alias -> table map. */
function tablesOf(sql: string): { tables: string[]; alias: Map<string, string> } {
	const alias = new Map<string, string>();
	const tables: string[] = [];
	// A CTE's name reads like a table in FROM/JOIN but is the statement's own.
	const ctes = new Set([...sql.matchAll(/(?:\bwith|,)\s*([a-z_]\w*)\s+as\s*\(/gi)].map(m => m[1].toLowerCase()));
	for (const m of sql.matchAll(/\b(?:from|join)\s+(?:\[?dbo\]?\.)?\[?([a-z_][\w]*)\]?(?:\s+(?:as\s+)?([a-z_]\w*))?/gi)) {
		const t = m[1].toLowerCase();
		if (SQL_KEYWORDS.has(t) || ctes.has(t)) continue;
		tables.push(t);
		if (m[2] && !SQL_KEYWORDS.has(m[2].toLowerCase())) alias.set(m[2].toLowerCase(), t);
	}
	return { tables: [...new Set(tables)], alias };
}

/** ON conditions that touch one of the given tables, aliases written out as table names. */
function joinsOn(sql: string, wanted: Set<string>): string[] {
	const { alias } = tablesOf(sql);
	const out: string[] = [];
	for (const m of sql.matchAll(/\bon\s+([\s\S]+?)(?=\b(?:left|right|inner|outer|full|cross|join|where|group|order|having|union)\b|\)|;|$)/gi)) {
		for (const cond of m[1].split(/\s+and\s+/i)) {
			const named = cond.trim().replace(/\b([a-z_]\w*)\.(?=\w)/gi, (all, a: string) => `${alias.get(a.toLowerCase()) ?? a.toLowerCase()}.`)
				.replace(/\bdbo\./gi, '').replace(/\s+/g, ' ');
			if ([...wanted].some(t => named.toLowerCase().includes(`${t}.`))) out.push(named);
		}
	}
	return out;
}

export async function findGaps(info: RouteInfo, usage: RunUsage): Promise<RouteGaps | null> {
	const keys = new Set(info.conceptKeys);
	const outside = usage.concepts.filter(n => !keys.has(n.toLowerCase()));
	const ok = usage.queries.filter(q => !q.error);
	const queried = ok.flatMap(q => tablesOf(q.sql).tables);
	const gaps: RouteGaps = {
		domain: info.decision.domainName,
		unrouted: info.decision.decidedBy === 'fallback',
		outsideConcepts: [],
		noConcept: usage.conceptMisses,
		tablesNotDescribed: [...new Set([...usage.tables, ...queried])].filter(t => !info.text.includes(t.toLowerCase())),
		missingInDomain: info.missing,
	};
	const any = gaps.unrouted || outside.length || gaps.noConcept.length
		|| gaps.tablesNotDescribed.length || gaps.missingInDomain.length;
	if (!any) return null;

	// A real gap: now the context that says what to change. Read failures leave it out.
	const domains = await publishedDomainConcepts().catch(() => []);
	const homes = (name: string) => domains
		.filter(d => d.domain !== info.decision.domainName && d.concepts.includes(name.toLowerCase()))
		.map(d => d.domain);
	gaps.outsideConcepts = outside.map(name => ({ name, inDomains: homes(name) }));

	const routed = new Set(info.decision.matched.map(m => m.term.toLowerCase()));
	const scores = await scoreDomains(info.question).catch(() => new Map());
	gaps.alsoMatched = [...scores.values()]
		.filter((d: any) => d.name !== info.decision.domainName && d.score >= 2)
		.map((d: any) => ({ domain: d.name, score: +d.score.toFixed(1), terms: d.matched.map((m: any) => m.term).filter((t: string) => !routed.has(t.toLowerCase())) }))
		.filter(d => d.terms.length)
		.sort((a, b) => b.score - a.score).slice(0, 2);

	if (gaps.tablesNotDescribed.length) {
		const concepts = ((await getAllConcepts({}).catch(() => ({ data: [] }))).data ?? []) as any[];
		// Concepts in a domain the question also matched come first: the likeliest fit.
		const preferred = new Set(gaps.alsoMatched.map(d => d.domain));
		gaps.describedBy = gaps.tablesNotDescribed.map(table => ({
			table,
			concepts: concepts
				.filter(c => new RegExp(`\\b${table}\\b`, 'i').test(String(c.body ?? '')))
				.map(c => ({ name: c.name as string, inDomains: homes(c.name) }))
				.sort((a, b) => Number(b.inDomains.some(d => preferred.has(d))) - Number(a.inDomains.some(d => preferred.has(d))) || b.inDomains.length - a.inDomains.length)
				.slice(0, 3),
		}));
		const wanted = new Set(gaps.tablesNotDescribed);
		gaps.joins = [...new Set(ok.flatMap(q => joinsOn(q.sql, wanted)))].slice(0, 5);
	}
	gaps.failedQueries = [...new Set(usage.queries.filter(q => q.error).map(q => q.error!))].slice(0, 3);
	return gaps;
}

/** The Domain gaps step: what to add or fix, one line per kind. */
export function gapsStep(info: RouteInfo, g: RouteGaps): { label: string; badge: string; body: string } {
	const title = nice(info.title);
	const where = g.unrouted ? 'the general instructions' : title;
	const inD = (ds: string[]) => ds.length ? ` (in ${ds.map(nice).join(', ')})` : '';
	const lines: string[] = [];
	if (g.unrouted) {
		lines.push(`**No domain matched this question.**${g.outsideConcepts.length ? ` Definitions it used: ${g.outsideConcepts.map(c => c.name).join(', ')}.` : ''} Add its words to the domain it belongs to, or create a domain for it.`);
	} else if (g.alsoMatched?.length) {
		lines.push(`**The question also covers ${g.alsoMatched.map(d => `${nice(d.domain)} (${d.terms.map(t => `"${t}"`).join(', ')}, score ${d.score})`).join(' and ')}**, which ${title} does not cover.`);
	}
	if (!g.unrouted && g.outsideConcepts.length) {
		lines.push(`**Needed but not in ${title}:** ${g.outsideConcepts.map(c => `${c.name}${inD(c.inDomains)}`).join('; ')}. Add them to ${title} if questions like this belong there.`);
	}
	if (g.noConcept.length) lines.push(`**No definition exists for:** ${g.noConcept.map(t => `"${t}"`).join(', ')}. A concept for it would help.`);
	if (g.tablesNotDescribed.length) {
		const described = (g.describedBy ?? []).filter(d => d.concepts.length);
		const bare = (g.describedBy ?? []).filter(d => !d.concepts.length).map(d => d.table);
		lines.push(`**Data ${where} does not describe, which the agent worked out itself:** ${g.tablesNotDescribed.join(', ')}.`);
		if (described.length) {
			lines.push(`**Concepts that already describe it:** ${described.map(d => `${d.table} → ${d.concepts.map(c => `**${c.name}**${inD(c.inDomains)}`).join(', ')}`).join('; ')}. Add them to ${g.unrouted ? 'the domain this question belongs to' : title} if questions like this belong there.`);
		}
		if (bare.length) lines.push(`**No concept describes:** ${bare.join(', ')}. Write one.`);
		if (g.joins?.length) lines.push(`**How the agent joined it itself** (check before reusing): ${g.joins.map(j => `\`${j}\``).join(', ')}`);
	}
	if (g.missingInDomain.length) lines.push(`**${title} lists definitions that do not exist:** ${g.missingInDomain.join(', ')}. Fix the names in the domain.`);
	if (g.failedQueries?.length) lines.push(`**Queries that failed:** ${g.failedQueries.join('; ')}`);
	const count = (g.unrouted ? 1 : 0) + g.outsideConcepts.length + g.noConcept.length + g.tablesNotDescribed.length + g.missingInDomain.length;
	return { label: 'Domain gaps', badge: `${count} found`, body: lines.join('\n\n') };
}
