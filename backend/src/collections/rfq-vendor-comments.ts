import { queryProcurement } from '../services/procurement-source';
import { requestAuthor } from '../services/request-author';
import type { CollectionContext } from './types';

/**
 * Technical comments on a vendor's bid, written while T-ranking an RFQ. Scoped
 * to one RFQ + vendor: each RFQ keeps its own thread per vendor. Lives next to
 * the RFQs in the procurement database:
 *
 *   CREATE TABLE public.rfq_vendor_comments (
 *     id serial PRIMARY KEY,
 *     rfq_id varchar(50) NOT NULL,
 *     vendor_id varchar(50) NOT NULL,
 *     user_id varchar(255),
 *     user_name varchar(255),
 *     body text NOT NULL,
 *     created_at timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX idx_rfq_vendor_comments_vendor ON public.rfq_vendor_comments (vendor_id, created_at);
 */

const ID = /^[A-Za-z0-9_-]{1,50}$/;
const MAX_BODY_LENGTH = 2000;

// camelCase aliases keep the shape the frontend expects.
const COMMENT_COLUMNS = `id, rfq_id AS "rfqId", vendor_id AS "vendorId", user_id AS "userId", user_name AS "userName", body, created_at AS "createdAt"`;

function requireId(value: unknown, name: string): string {
	if (typeof value !== 'string' || !ID.test(value)) {
		throw new Error(`A valid ${name} is required`);
	}
	return value;
}

/**
 * Register RFQ vendor comment collections with SDK
 */
export async function registerRfqVendorCommentsCollections({ sdk }: CollectionContext): Promise<void> {
	// The comments on one vendor's bid for one RFQ, oldest first
	sdk.addCollection('rfq-vendor-comments', 'list', async (params: any) => {
		const rfqId = requireId(params?.rfqId, 'rfqId');
		const vendorId = requireId(params?.vendorId, 'vendorId');
		const rows = await queryProcurement('rfq-vendor-comments-list',
			`SELECT ${COMMENT_COLUMNS} FROM rfq_vendor_comments WHERE rfq_id = @rfqId AND vendor_id = @vendorId ORDER BY created_at, id`,
			{ rfqId, vendorId });
		return { success: true, data: rows, count: rows.length };
	});

	// Add a technical comment on a vendor's bid for one RFQ
	sdk.addCollection('rfq-vendor-comments', 'create', async (params: any) => {
		const rfqId = requireId(params?.rfqId, 'rfqId');
		const vendorId = requireId(params?.vendorId, 'vendorId');
		const body = typeof params?.body === 'string' ? params.body.trim() : '';
		if (!body) {
			throw new Error('Comment cannot be empty');
		}
		if (body.length > MAX_BODY_LENGTH) {
			throw new Error(`Comment is too long (max ${MAX_BODY_LENGTH} characters)`);
		}

		const { userId, userName } = requestAuthor(params);
		console.log(`[RFQ-VENDOR-COMMENTS] ${rfqId}/${vendorId} comment by ${userName || userId || 'anonymous'}`);
		const rows = await queryProcurement('rfq-vendor-comments-create',
			`INSERT INTO rfq_vendor_comments (rfq_id, vendor_id, user_id, user_name, body)
			 VALUES (@rfqId, @vendorId, @userId, @userName, @body) RETURNING ${COMMENT_COLUMNS}`,
			{ rfqId, vendorId, userId: userId ?? null, userName: userName ?? null, body });
		return { success: true, data: rows[0] ?? null };
	});
}
