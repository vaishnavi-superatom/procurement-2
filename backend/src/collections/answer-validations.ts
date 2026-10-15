import * as validations from '../../../database/postgres/src/project-data-db/answer-validations';
import type { CollectionContext } from './types';

/**
 * Answer validations — what a coding agent found when it re-derived an answer
 * from the source data.
 *
 * Read-only over the websocket: these are evidence produced by an agent run,
 * not something a UI should be able to edit. Correcting a verdict means
 * re-running the validation, which is the point.
 */
export async function registerAnswerValidationsCollections({ sdk }: CollectionContext): Promise<void> {
	/** Recent verdicts, newest first. `verdict` filters to just the mismatches. */
	sdk.addCollection('answer-validations', 'list', async (params: any = {}) =>
		validations.listValidations({
			verdict: params?.verdict,
			limit: Math.min(Number(params?.limit) || 100, 500),
		})
	);

	/** The verdict for one answer. At most one, by constraint — `checks` says how
	 *  many times it was re-derived, and `updatedAt` when it last was. */
	sdk.addCollection('answer-validations', 'forConversation', async (params: any) => {
		const id = Number(params?.conversationId);
		if (!Number.isFinite(id)) return { success: false, error: 'conversationId is required' };
		return validations.getValidationsForConversation(id);
	});

	/** match / mismatch / unverifiable counts plus an accuracy percentage. */
	sdk.addCollection('answer-validations', 'stats', async () => validations.validationStats());

	console.log('✓ answer-validations collections registered');
}
