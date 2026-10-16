import { queryProcurement } from '../services/procurement-source';
import { requestAuthor } from '../services/request-author';
import type { CollectionContext } from './types';

const ID = /^[A-Za-z0-9_-]{1,50}$/;
const MAX_COMMENT_LENGTH = 2000;
// Matches t_rank_definitions; NOT_ACCEPTED (T5) drops the vendor from negotiation.
const T_RANKS = ['T1', 'T2', 'T3', 'T4', 'NOT_ACCEPTED'];

function requireId(value: unknown, name: string): string {
	if (typeof value !== 'string' || !ID.test(value)) {
		throw new Error(`A valid ${name} is required`);
	}
	return value;
}

/**
 * RFQ changes made from the screens: status moves (an RFQ stays "RFQ
 * Received" until the buyer actively starts negotiating), the buyer's T-ranks
 * from technical evaluation, and the supplier the buyer selects. Selections
 * are recorded in the procurement database:
 *
 *   CREATE TABLE public.rfq_supplier_selections (
 *     id serial PRIMARY KEY,
 *     rfq_id varchar(50) NOT NULL,
 *     vendor_id varchar(50) NOT NULL,
 *     quote_id varchar(50),
 *     recommendation_id integer,
 *     recommended_vendor_id varchar(50),
 *     is_deviation boolean NOT NULL,
 *     deviation_comment text,
 *     selected_by varchar(255),
 *     selected_by_id varchar(255),
 *     created_at timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX idx_rfq_supplier_selections_rfq ON public.rfq_supplier_selections (rfq_id, created_at);
 */
export async function registerRfqWorkflowCollections({ sdk }: CollectionContext): Promise<void> {
	sdk.addCollection('rfq-workflow', 'start-negotiation', async (params: any) => {
		const rfqId = requireId(params?.rfqId, 'rfqId');
		const changed = await queryProcurement('rfq-start-negotiation', `
			UPDATE rfq_events
			SET rfq_status = 'In Negotiation', negotiation_rounds = GREATEST(negotiation_rounds, 1)
			WHERE rfq_id = @rfqId AND rfq_status = 'RFQ Received'
			RETURNING rfq_status`, { rfqId });
		if (changed.length) {
			console.log(`[RFQ-WORKFLOW] ${rfqId}: RFQ Received -> In Negotiation`);
			return { success: true, data: { rfqId, status: 'In Negotiation', changed: true } };
		}
		// Already negotiating or awarded: nothing to change, report where it is.
		const [current] = await queryProcurement('rfq-status', `SELECT rfq_status FROM rfq_events WHERE rfq_id = @rfqId`, { rfqId });
		if (!current) throw new Error(`RFQ ${rfqId} not found`);
		return { success: true, data: { rfqId, status: current.rfq_status, changed: false } };
	});

	// The buyer's T-rank for one vendor's quote. Locked once the RFQ is awarded.
	sdk.addCollection('rfq-workflow', 'set-t-rank', async (params: any) => {
		const rfqId = requireId(params?.rfqId, 'rfqId');
		const quoteId = requireId(params?.quoteId, 'quoteId');
		const tRank = params?.tRank;
		if (!T_RANKS.includes(tRank)) {
			throw new Error('tRank must be one of T1, T2, T3, T4 or NOT_ACCEPTED');
		}
		const { userId, userName } = requestAuthor(params);
		const rows = await queryProcurement('rfq-set-t-rank', `
			UPDATE rfq_technical_evaluations
			SET t_rank = @tRank, ranked_by = @rankedBy, ranked_at = now()
			WHERE quote_id = @quoteId AND rfq_id = @rfqId
			  AND EXISTS (SELECT 1 FROM rfq_events r WHERE r.rfq_id = @rfqId AND r.rfq_status <> 'Awarded')
			RETURNING quote_id, t_rank, ranked_by, ranked_at`,
			{ rfqId, quoteId, tRank, rankedBy: userName || userId || 'buyer' });
		if (!rows.length) {
			const [rfq] = await queryProcurement('rfq-status', `SELECT rfq_status FROM rfq_events WHERE rfq_id = @rfqId`, { rfqId });
			if (rfq?.rfq_status === 'Awarded') throw new Error('This RFQ is already awarded, so its T-ranks are locked');
			throw new Error(`Quote ${quoteId} not found on ${rfqId}`);
		}
		console.log(`[RFQ-WORKFLOW] ${rfqId}/${quoteId}: T-rank ${tRank} by ${rows[0].ranked_by}`);
		const r = rows[0];
		return { success: true, data: { quoteId: r.quote_id, tRank: r.t_rank, rankedBy: r.ranked_by, rankedAt: r.ranked_at } };
	});

	// The buyer's chosen supplier. Choosing anyone other than the latest system
	// recommendation is a deviation and needs a comment — decided here, not by
	// the screen.
	sdk.addCollection('rfq-workflow', 'select-supplier', async (params: any) => {
		const rfqId = requireId(params?.rfqId, 'rfqId');
		const vendorId = requireId(params?.vendorId, 'vendorId');
		const comment = typeof params?.comment === 'string' ? params.comment.trim().slice(0, MAX_COMMENT_LENGTH) : '';
		const { userId, userName } = requestAuthor(params);

		const [rfq] = await queryProcurement('rfq-status', `SELECT rfq_status FROM rfq_events WHERE rfq_id = @rfqId`, { rfqId });
		if (!rfq) throw new Error(`RFQ ${rfqId} not found`);
		if (rfq.rfq_status === 'Awarded') throw new Error('This RFQ is already awarded');

		const [quote] = await queryProcurement('rfq-select-quote', `
			SELECT quote_id, eligible_for_negotiation FROM rfq_vendor_ranking WHERE rfq_id = @rfqId AND vendor_id = @vendorId`,
			{ rfqId, vendorId });
		if (!quote) throw new Error(`Vendor ${vendorId} did not quote on ${rfqId}`);
		if (quote.eligible_for_negotiation !== true) throw new Error('This vendor was ranked Not accepted in technical evaluation');

		const [rec] = await queryProcurement('rfq-select-recommendation', `
			SELECT id, recommended_vendor_id FROM rfq_recommendations WHERE rfq_id = @rfqId ORDER BY created_at DESC LIMIT 1`,
			{ rfqId });
		if (!rec) throw new Error('Run the System Recommendation before selecting a supplier');
		const isDeviation = rec.recommended_vendor_id !== vendorId;
		if (isDeviation && !comment) {
			throw new Error('Please add a comment explaining why you are not choosing the recommended supplier');
		}

		const [saved] = await queryProcurement('rfq-select-supplier', `
			INSERT INTO rfq_supplier_selections
				(rfq_id, vendor_id, quote_id, recommendation_id, recommended_vendor_id, is_deviation, deviation_comment, selected_by, selected_by_id)
			VALUES (@rfqId, @vendorId, @quoteId, @recommendationId, @recommendedVendorId, @isDeviation, @comment, @selectedBy, @selectedById)
			RETURNING id, created_at`, {
			rfqId, vendorId, quoteId: quote.quote_id, recommendationId: rec.id, recommendedVendorId: rec.recommended_vendor_id,
			isDeviation, comment: comment || null, selectedBy: userName ?? null, selectedById: userId ?? null,
		});
		console.log(`[RFQ-WORKFLOW] ${rfqId}: supplier ${vendorId} selected by ${userName || userId || 'buyer'}${isDeviation ? ' (deviation)' : ''}`);
		return {
			success: true,
			data: {
				id: saved.id, rfqId, vendorId, quoteId: quote.quote_id, recommendationId: rec.id,
				recommendedVendorId: rec.recommended_vendor_id, isDeviation, comment: comment || null,
				selectedBy: userName || userId || null, createdAt: saved.created_at,
			},
		};
	});
}
