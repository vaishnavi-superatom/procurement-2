import { LLM } from '@superatomai/sdk-node';
import type { ComposedDomain } from '../../../database/postgres/src/project-data-db/graph';

/**
 * The router's second opinion when two domains score within its margin. Words
 * cannot tell what a question asks from who it is about ("which customers are
 * overdue"); a small model can. Any failure leaves the index's pick standing.
 */
const MODEL = process.env.SA_ROUTER_MODEL || 'openrouter/anthropic/claude-haiku-4.5';
const TIMEOUT_MS = 8_000;

const SYSTEM = 'Pick the domain that answers the question: the one about what the question asks for, ' +
	'not merely about who or where it concerns. Reply with the domain name only.';

export async function llmTieBreak(question: string, a: ComposedDomain, b: ComposedDomain): Promise<string> {
	const describe = (d: ComposedDomain) => `${d.domain.name}: ${d.domain.body ?? ''}`.trim();
	const user = `Question: ${question}\n\nDomains:\n- ${describe(a)}\n- ${describe(b)}`;
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('tie-break timeout')), TIMEOUT_MS); });
	try {
		const reply = await Promise.race([LLM.text({ sys: SYSTEM, user }, { model: MODEL, maxTokens: 20, temperature: 0 }), timeout]);
		// Only an exact domain name counts; anything else keeps the index's pick.
		const picked = reply.trim().replace(/[`"'.]/g, '').toLowerCase();
		return [a.domain.name, b.domain.name].find(n => n.toLowerCase() === picked) ?? a.domain.name;
	} finally {
		clearTimeout(timer);
	}
}
