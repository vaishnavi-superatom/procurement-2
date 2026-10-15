import { getDomainTerms, getPublishedDomain, recordRoute, type ComposedDomain } from '../../../database/postgres/src/project-data-db/graph';

/**
 * Which domain answers this question — deterministically, and on the record.
 *
 * Term frequency over an index the team authors, not an embedding: a misroute
 * has to be explainable ("it matched these three terms") and fixable by adding a
 * synonym, which is how the nightly report is meant to work. A model is asked
 * only to break a tie between two domains that scored within a whisker.
 */

/** Reserved domain composed when nothing matches — today's behaviour, as a domain. */
export const GENERIC_DOMAIN = 'generic';

/** Below this, the question is not this domain's. Overridable per domain. */
const DEFAULT_THRESHOLD = 2;
/** A winner this far clear of the runner-up needs no second opinion. */
const CLEAR_MARGIN = 0.25;

/**
 * Leaving the thread's domain costs the codex session, and with it the
 * conversation. So a challenger must beat the current domain by a whole term's
 * weight, not merely clear its own threshold: one incidental word should not
 * throw away the context of a working conversation.
 */
const SWITCH_MARGIN = 2;

/**
 * A question that cannot stand on its own — "and the same for July?", "which of
 * those are overdue?" — is a continuation whose terms belong to the thread, not
 * to a new topic. It never switches domain, whatever it happens to mention.
 */
// "their" and "it" were tried and removed: they are ordinary in standalone
// questions ("what are their credit days?") and made a new topic look elliptical.
const CONTINUATION = /^(and|also|what about|how about|same|now|then|ok|okay|plus)\b|\b(those|them|these|that one|the same)\b/i;

export function isContinuation(question: string): boolean {
	const q = question.trim();
	return q.split(/\s+/).length <= 14 && CONTINUATION.test(q);
}

const STOPWORDS = new Set([
	'the','a','an','and','or','of','for','in','on','at','to','by','with','from','is','are','was','were','be','been',
	'how','what','which','who','whom','when','where','why','many','much','me','my','our','we','us','you','your',
	'give','show','list','tell','get','find','want','need','please','do','does','did','can','could','would','should',
	'that','this','these','those','it','its','as','all','any','each','per','into','over','under','between','about',
]);

export function normalise(question: string): string {
	return question.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function tokenise(question: string): string[] {
	return normalise(question).split(' ').filter(t => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Plural and verb endings off, on both sides of a match: "trips" meets "trip",
 * "completed" meets "complete". Words of four letters or fewer are left alone,
 * so a code like "tur" or "gcn" is never cut.
 */
export function stem(word: string): string {
	return word.length > 4 ? word.replace(/ies$/, 'y').replace(/(es|ed|ing|s)$/, '') : word;
}

/**
 * Weight of a multi-word term whose words are all in the question but not as
 * that phrase. Measured: "trips for which settlement is not done" scored 0
 * against "trip settlement"; a scattered match is still weaker than the phrase.
 */
const SCATTERED = 0.75;

export interface RouteDecision {
	domainName: string;
	domainId: number | null;
	score: number;
	runnerUp?: { domainId: number; domainName: string; score: number };
	matched: Array<{ term: string; weight: number }>;
	decidedBy: 'index' | 'llm' | 'tie' | 'sticky' | 'fallback';
	/** The graph_routes row, so what the run later found missing is stored beside it. */
	routeId?: number | null;
}

/**
 * Score every domain against the question.
 *
 * A single-word term must match a token; a multi-word term must appear as a
 * phrase, so "freight revenue" is not satisfied by "revenue" on its own — the
 * whole point of the index is that the distinctive phrase carries the weight.
 */
export interface DomainScore {
	name: string;
	score: number;
	priority: number;
	matched: Array<{ term: string; weight: number }>;
}

/**
 * How much evidence one matched term is worth.
 *
 * Authored weights alone collide: every term in the first real graph carries
 * weight 2, so a question matching one term in each of two domains is a dead
 * heat that nothing can resolve. Two multipliers fix that from the graph itself,
 * with no model call and no randomness:
 *
 *   phrase length — "lorry hire" is unambiguous where "booking" is not, so a
 *     two-word match is worth twice a one-word match (longest-match, as in any
 *     retrieval index)
 *   domain rarity — a term several domains claim is weak evidence; one claimed
 *     by a single domain is strong. Normalised so a UNIQUE term keeps its
 *     authored weight exactly, which is what lets `meta.threshold` keep meaning.
 */
function evidence(weight: number, term: string, domainsWithTerm: number, totalDomains: number): number {
	const words = term.split(/\s+/).filter(Boolean).length;
	const rarity = totalDomains > 1 && domainsWithTerm > 1
		? Math.log(totalDomains / domainsWithTerm) / Math.log(totalDomains)
		: 1;
	return weight * words * rarity;
}

export async function scoreDomains(question: string): Promise<Map<number, DomainScore>> {
	const terms = await getDomainTerms();
	const tokens = new Set(tokenise(question).map(stem));
	const phrase = normalise(question);
	const stemmedPhrase = phrase.split(' ').map(stem).join(' ');

	// How many domains claim each term, and how many domains there are at all.
	const claimants = new Map<string, Set<number>>();
	const allDomains = new Set<number>();
	for (const t of terms) {
		allDomains.add(t.domainId);
		if (!claimants.has(t.term)) claimants.set(t.term, new Set());
		claimants.get(t.term)!.add(t.domainId);
	}

	const scores = new Map<number, DomainScore>();
	// One stem is one piece of evidence: "customer" and "customers" both match the
	// word "customers", so per domain only the stronger of them counts.
	const counted = new Map<string, number>();
	for (const t of terms) {
		const words = t.term.split(/\s+/).filter(Boolean).map(stem);
		// Scattered needs two real words: with stopwords dropped, "client list" or
		// "doing business with" is one word, and matched every question naming it.
		const content = words.filter(w => !STOPWORDS.has(w));
		const factor = words.length === 1
			? (tokens.has(words[0]) ? 1 : 0)
			: phrase.includes(t.term) || stemmedPhrase.includes(words.join(' ')) ? 1
			: content.length >= 2 && content.every(w => tokens.has(w)) ? SCATTERED : 0;
		if (!factor) continue;
		const w = factor * evidence(t.weight, t.term, claimants.get(t.term)!.size, allDomains.size);
		const key = `${t.domainId}|${words.join(' ')}`;
		const prev = counted.get(key) ?? 0;
		if (w <= prev) continue;
		counted.set(key, w);
		const cur = scores.get(t.domainId) ?? { name: t.domainName, score: 0, priority: t.priority, matched: [] };
		cur.score += w - prev;
		const stemOf = (m: { term: string }) => m.term.split(/\s+/).filter(Boolean).map(stem).join(' ');
		cur.matched = cur.matched.filter(m => stemOf(m) !== words.join(' '));
		cur.matched.push({ term: t.term, weight: Math.round(w * 100) / 100 });
		scores.set(t.domainId, cur);
	}
	return scores;
}

export interface RouteOptions {
	threadId?: string | null;
	userId?: string | null;
	/**
	 * The domain this thread is already in. A follow-up is elliptical — "and the
	 * same for July?" carries no terms at all — so scoring its text alone drops
	 * the thread out of its domain and, because the composition then changes,
	 * restarts the session that held the conversation. The thread's domain stands
	 * until the question clearly names another one.
	 */
	currentDomain?: string | null;
	/** Given two close domains and the question, name the better one. */
	tieBreak?: (question: string, a: ComposedDomain, b: ComposedDomain) => Promise<string>;
}

/** Route, load the winning domain, and record the decision before anything runs. */
export async function route(question: string, opts: RouteOptions = {}): Promise<{ decision: RouteDecision; composed: ComposedDomain | null }> {
	let scores = [...(await scoreDomains(question)).entries()]
		.map(([domainId, v]) => ({ domainId, ...v }))
		.sort((a, b) => b.score - a.score);

	// A tie the scores could not separate is decided by an AUTHORED rule, never by
	// the order rows came back in: higher `meta.priority`, then the name. The
	// thread's own domain is already preferred by the hysteresis below.
	const TIE_EPSILON = 0.01;
	let tied = false;
	if (scores.length > 1 && Math.abs(scores[0].score - scores[1].score) < TIE_EPSILON) {
		const top = scores.filter(s => Math.abs(s.score - scores[0].score) < TIE_EPSILON)
			.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
		tied = top.length > 1;
		scores = [...top, ...scores.filter(s => !top.includes(s))];
	}

	const [first, second] = scores;

	/**
	 * Nothing scored: stay where the thread already is, and only fall back to
	 * `generic` when there is nowhere to stay. Recorded as 'sticky' so the gap
	 * report does not read a follow-up as an uncovered question.
	 */
	const fallback = async (): Promise<{ decision: RouteDecision; composed: ComposedDomain | null }> => {
		const sticky = opts.currentDomain && opts.currentDomain !== GENERIC_DOMAIN
			? await getPublishedDomain(opts.currentDomain) : null;
		const composed = sticky ?? await getPublishedDomain(GENERIC_DOMAIN);
		const decidedBy: RouteDecision['decidedBy'] = sticky ? 'sticky' : 'fallback';
		const decision: RouteDecision = {
			domainName: composed?.domain.name ?? GENERIC_DOMAIN, domainId: composed?.domain.id ?? null,
			score: first?.score ?? 0, matched: first?.matched ?? [], decidedBy,
		};
		decision.routeId = await recordRoute({ question, domainId: decision.domainId, domainHash: composed?.hash ?? null,
			score: decision.score, matchedTerms: decision.matched, decidedBy,
			threadId: opts.threadId, userId: opts.userId });
		return { decision, composed };
	};

	if (!first) return fallback();

	let winner = first;
	let decidedBy: RouteDecision['decidedBy'] = tied ? 'tie' : 'index';
	let composed = await getPublishedDomain(first.name);
	if (!composed) return fallback();

	const threshold = Number(composed.domain.meta?.threshold ?? DEFAULT_THRESHOLD);
	if (first.score < threshold) return fallback();

	// Hysteresis: the thread stays put unless this question is clearly about
	// something else. `fallback()` keeps it in the current domain.
	const current = opts.currentDomain?.trim().toLowerCase();
	if (current && current !== GENERIC_DOMAIN && current !== winner.name.toLowerCase()) {
		const currentScore = scores.find(s => s.name.toLowerCase() === current)?.score ?? 0;
		if (isContinuation(question) || winner.score < currentScore + SWITCH_MARGIN) return fallback();
	}

	// Close enough that the index is not evidence either way — ask once.
	if (second && opts.tieBreak && (first.score - second.score) / first.score < CLEAR_MARGIN) {
		const other = await getPublishedDomain(second.name);
		if (other) {
			try {
				const picked = (await opts.tieBreak(question, composed, other)).trim().toLowerCase();
				if (picked === second.name.toLowerCase()) { winner = second; composed = other; }
				decidedBy = 'llm';
			} catch { /* the index's answer stands */ }
		}
	}

	// The runner-up is whichever of the top two did not win: the model can pick the second.
	const other = winner === first ? second : first;
	const decision: RouteDecision = {
		domainName: winner.name, domainId: winner.domainId, score: winner.score,
		runnerUp: other ? { domainId: other.domainId, domainName: other.name, score: other.score } : undefined,
		matched: winner.matched, decidedBy,
	};
	decision.routeId = await recordRoute({ question, domainId: decision.domainId, domainHash: composed.hash,
		score: decision.score, runnerUpId: other?.domainId ?? null, runnerUpScore: other?.score ?? null,
		matchedTerms: decision.matched, decidedBy, threadId: opts.threadId, userId: opts.userId });
	return { decision, composed };
}
