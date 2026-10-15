import { db } from './drizzle-db';
import { sql } from 'drizzle-orm';

/**
 * Reads the concept-builder agent works from.
 *
 * Here rather than in the agent definition for two reasons: the backend and
 * this package resolve separate copies of drizzle-orm, so `sql` built on one
 * side is not assignable on the other; and an agent definition should describe
 * a job, not carry queries.
 */

export interface ConversationForConcepts {
	id: number;
	threadId: string | null;
	question: string;
	/** The narrative only — the stored response also holds components and raw rows. */
	answer: string;
}

/**
 * One forward batch of answered questions, oldest first.
 *
 * Oldest-first and watermarked so successive runs walk through history in
 * order, instead of re-reading the newest ten forever. Only 'success' turns:
 * an errored or aborted answer is evidence of nothing.
 */
export async function getConversationBatch(
	sinceId: number,
	limit: number
): Promise<ConversationForConcepts[]> {
	const res: any = await db.execute(sql`
		SELECT id, threadid, userprompt, response
		FROM user_conversations
		WHERE id > ${sinceId} AND status = 'success'
		ORDER BY id ASC
		LIMIT ${limit}
	`);
	return res.rows.map((r: any) => ({
		id: r.id,
		threadId: r.threadid ?? null,
		question: r.userprompt,
		answer:
			typeof r.response?.analysis === 'string' ? r.response.analysis
				: typeof r.response?.response_text === 'string' ? r.response.response_text
					: '',
	}));
}

export interface KbNodeForConcepts {
	id: number;
	title: string;
	content: string;
	updatedAt: string | null;
}

/**
 * The nodes that changed, or the most recently touched ones when none is named.
 *
 * Takes a LIST because a debounced burst is one run over several edits — asking
 * for one id per run was how four nodes out of five went unread. Ids are
 * deduped (a node edited three times in the window is still one node) and a node
 * deleted before the run simply does not come back, which is the intended
 * behaviour: its concepts are deliberately kept.
 */
export async function getKbNodesForConcepts(
	ids?: Array<number | string>,
	limit = 20
): Promise<KbNodeForConcepts[]> {
	const wanted = [...new Set((ids ?? []).filter(id => id !== null && id !== undefined && id !== ''))];
	const res: any = await db.execute(
		wanted.length
			? sql`SELECT id, title, content, updated_at AS "updatedAt" FROM kb_nodes
			      WHERE id IN (${sql.join(wanted.map(i => sql`${i}`), sql`, `)})
			      ORDER BY id ASC`
			: sql`SELECT id, title, content, updated_at AS "updatedAt" FROM kb_nodes ORDER BY updated_at DESC LIMIT ${limit}`
	);
	return res.rows as KbNodeForConcepts[];
}

/**
 * The question text for a set of conversations, for stamping onto validations.
 *
 * Read from the database rather than echoed back by the agent: a mis-echoed
 * question would misattribute a verdict to the wrong ask, which is worse than
 * having no question at all.
 */
export async function getConversationQuestions(ids: number[]): Promise<Map<number, string>> {
	if (!ids.length) return new Map();
	const res: any = await db.execute(sql`
		SELECT id, userprompt FROM user_conversations WHERE id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})
	`);
	return new Map(res.rows.map((r: any) => [Number(r.id), r.userprompt as string]));
}
