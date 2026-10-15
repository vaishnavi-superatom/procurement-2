import { db } from './drizzle-db';
import { sql } from 'drizzle-orm';

/**
 * What a coding agent found when it re-derived an answer from the source data.
 *
 * The point of recording a 'match' as carefully as a 'mismatch': a verified
 * correct answer is the result users most want to see, and it was previously
 * the one thing a run threw away.
 */

export type Verdict = 'match' | 'mismatch' | 'unverifiable';

export interface AnswerValidation {
	id: number;
	conversationId: number;
	question: string | null;
	verdict: Verdict;
	reportedAnswer: string | null;
	rederivedAnswer: string | null;
	unit: string | null;
	finding: string | null;
	evidence: Record<string, unknown>;
	agentRunId: string | null;
	/** How many times this answer has been re-derived. >1 agreeing is a stronger signal. */
	checks: number;
	/** First checked. */
	createdAt: string | null;
	/** Last checked — equal to createdAt until something re-derives it. */
	updatedAt: string | null;
}

export interface CreateValidationParams {
	conversationId: number;
	question?: string | null;
	verdict: Verdict;
	reportedAnswer?: string | null;
	rederivedAnswer?: string | null;
	unit?: string | null;
	finding?: string | null;
	evidence?: Record<string, unknown>;
	agentRunId?: string | null;
}

/**
 * Record a verdict — one row per conversation, upserted.
 *
 * An answer can legitimately be re-derived: a partially covered batch hands the
 * remainder back next run. That has to update the verdict, not add a second
 * one, because this table is both the review surface and the denominator of the
 * accuracy figure.
 *
 * Two things the naive upsert gets wrong, and why:
 *
 *  - `unverifiable` NEVER overwrites a real verdict. Reachable in practice: when
 *    the data bridge is down the agent is told to report `unverifiable` for
 *    everything, so one outage during a retry would erase good evidence across a
 *    whole batch. Having once managed to check an answer is information; a later
 *    failure to check it is not.
 *  - `question` is COALESCEd, not replaced. It is OUR snapshot from the
 *    conversation row, taken precisely so a verdict outlives that row being
 *    pruned. If it has been pruned by the time of a re-check the lookup returns
 *    nothing, and overwriting would blank the one field that makes the verdict
 *    readable. The AGENT's own fields are replaced wholesale — mixing old and
 *    new evidence is worse than replacing it.
 *
 * `skipped` is returned rather than thrown: the caller wrote nothing, but
 * nothing went wrong either.
 */
export async function recordAnswerValidation(p: CreateValidationParams) {
	if (!Number.isFinite(p.conversationId)) throw new Error('conversationId is required');
	if (!['match', 'mismatch', 'unverifiable'].includes(p.verdict)) {
		throw new Error(`Unknown verdict "${p.verdict}"`);
	}
	const res: any = await db.execute(sql`
		INSERT INTO answer_validations
			(conversation_id, question, verdict, reported_answer, rederived_answer, unit, finding, evidence, agent_run_id)
		VALUES (
			${p.conversationId}, ${p.question ?? null}, ${p.verdict}, ${p.reportedAnswer ?? null}, ${p.rederivedAnswer ?? null},
			${p.unit ?? null}, ${p.finding ?? null}, ${JSON.stringify(p.evidence ?? {})}::jsonb, ${p.agentRunId ?? null}
		)
		ON CONFLICT (conversation_id) DO UPDATE SET
			question         = COALESCE(EXCLUDED.question, answer_validations.question),
			verdict          = EXCLUDED.verdict,
			reported_answer  = EXCLUDED.reported_answer,
			rederived_answer = EXCLUDED.rederived_answer,
			unit             = EXCLUDED.unit,
			finding          = EXCLUDED.finding,
			evidence         = EXCLUDED.evidence,
			agent_run_id     = EXCLUDED.agent_run_id,
			checks           = answer_validations.checks + 1,
			updated_at       = CURRENT_TIMESTAMP
		WHERE NOT (EXCLUDED.verdict = 'unverifiable' AND answer_validations.verdict <> 'unverifiable')
		RETURNING id, conversation_id AS "conversationId", verdict, checks,
		          created_at AS "createdAt", updated_at AS "updatedAt"
	`);
	const row = res.rows[0];
	// No row means the WHERE above declined the update — a real verdict stood.
	return row ? { success: true, data: row, skipped: false } : { success: true, data: null, skipped: true };
}

const SELECT = sql`
	SELECT id, conversation_id AS "conversationId", question, verdict,
	       reported_answer AS "reportedAnswer", rederived_answer AS "rederivedAnswer",
	       unit, finding, evidence, agent_run_id AS "agentRunId", checks,
	       created_at AS "createdAt", updated_at AS "updatedAt"
	FROM answer_validations`;

/**
 * The verdict for one answer. At most one row by construction — `checks` says
 * how many times it was re-derived. Kept returning a list so existing callers
 * are unaffected by the constraint landing.
 */
export async function getValidationsForConversation(conversationId: number) {
	const res: any = await db.execute(sql`${SELECT} WHERE conversation_id = ${conversationId}`);
	return { success: true, data: res.rows as AnswerValidation[], count: res.rows.length };
}

export async function listValidations(opts: { verdict?: Verdict; limit?: number } = {}) {
	const res: any = await db.execute(sql`
		${SELECT}
		${opts.verdict ? sql`WHERE verdict = ${opts.verdict}` : sql``}
		ORDER BY COALESCE(updated_at, created_at) DESC
		LIMIT ${opts.limit ?? 100}
	`);
	return { success: true, data: res.rows as AnswerValidation[], count: res.rows.length };
}

/**
 * Accuracy at a glance. Mismatches are what a reviewer should act on.
 *
 * One row per conversation is what makes this number mean anything: counting
 * rows over a table that allowed duplicates weighted some answers twice.
 */
export async function validationStats() {
	const res: any = await db.execute(sql`
		SELECT verdict, count(*)::int AS n FROM answer_validations GROUP BY verdict
	`);
	const by: Record<string, number> = {};
	for (const r of res.rows) by[r.verdict] = r.n;
	const checked = (by.match ?? 0) + (by.mismatch ?? 0);
	return {
		success: true,
		data: {
			...by,
			total: (by.match ?? 0) + (by.mismatch ?? 0) + (by.unverifiable ?? 0),
			// Share of answers that could be checked AND were right. Excludes
			// unverifiable ones, which say nothing about accuracy either way.
			accuracy: checked ? Math.round(((by.match ?? 0) / checked) * 100) : null,
		},
	};
}
