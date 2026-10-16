import { queryProcurement } from '../services/procurement-source';
import { requestAuthor } from '../services/request-author';
import type { CollectionContext } from './types';

/**
 * PR comments live in the procurement database itself (the Neon source), next
 * to the PRs they discuss, so every backend pointed at that database shares one
 * thread per PR. The table was created there once with:
 *
 *   CREATE TABLE public.pr_comments (
 *     id serial PRIMARY KEY,
 *     pr_id varchar(100) NOT NULL,
 *     user_id varchar(255),
 *     user_name varchar(255),
 *     body text NOT NULL,
 *     created_at timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX idx_pr_comments_pr ON public.pr_comments (pr_id, created_at);
 *
 * Writing needs the source's writeMode to be at least 'dml'.
 */

// Same shape the PR screen accepts for ids (see SAFE_ID in modules/PurchaseRequests).
const PR_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_BODY_LENGTH = 2000;

// camelCase aliases keep the shape the frontend expects.
const COMMENT_COLUMNS = `id, pr_id AS "prId", user_id AS "userId", user_name AS "userName", body, created_at AS "createdAt"`;

function requirePrId(prId: unknown): string {
	if (typeof prId !== 'string' || !PR_ID.test(prId)) {
		throw new Error('A valid prId is required');
	}
	return prId;
}

/**
 * Register PR comment collections with SDK
 */
export async function registerPrCommentsCollections({ sdk }: CollectionContext): Promise<void> {
	// List every comment on a PR, oldest first
	sdk.addCollection('pr-comments', 'list', async (params: any) => {
		const prId = requirePrId(params?.prId);
		const rows = await queryProcurement('pr-comments-list',
			`SELECT ${COMMENT_COLUMNS} FROM pr_comments WHERE pr_id = @prId ORDER BY created_at, id`,
			{ prId });
		return { success: true, data: rows, count: rows.length };
	});

	// Add a comment to a PR
	sdk.addCollection('pr-comments', 'create', async (params: any) => {
		const prId = requirePrId(params?.prId);

		const body = typeof params?.body === 'string' ? params.body.trim() : '';
		if (!body) {
			throw new Error('Comment cannot be empty');
		}
		if (body.length > MAX_BODY_LENGTH) {
			throw new Error(`Comment is too long (max ${MAX_BODY_LENGTH} characters)`);
		}

		const { userId, userName } = requestAuthor(params);
		console.log(`[PR-COMMENTS] New comment on ${prId} by ${userName || userId || 'anonymous'}`);
		const rows = await queryProcurement('pr-comments-create',
			`INSERT INTO pr_comments (pr_id, user_id, user_name, body) VALUES (@prId, @userId, @userName, @body) RETURNING ${COMMENT_COLUMNS}`,
			{ prId, userId: userId ?? null, userName: userName ?? null, body });
		return { success: true, data: rows[0] ?? null };
	});
}
