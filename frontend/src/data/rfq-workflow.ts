// RFQ changes: the backend's `rfq-workflow` collection.
import { requestCollection } from './collection-request';
import { getSignedInUser } from './signed-in-user';

export interface RfqStatusChange {
  rfqId: string;
  status: string;
  changed: boolean;
}

export interface TRankChange {
  quoteId: string;
  tRank: string;
  rankedBy: string;
  rankedAt: string;
}

export interface SupplierSelection {
  id: number;
  rfqId: string;
  vendorId: string;
  quoteId: string;
  recommendationId: number;
  recommendedVendorId: string;
  isDeviation: boolean;
  comment: string | null;
  selectedBy: string | null;
  createdAt: string;
}

/** "RFQ Received" → "In Negotiation"; a no-op for RFQs already past that. */
export const startNegotiation = (rfqId: string): Promise<RfqStatusChange> =>
  requestCollection<RfqStatusChange>('rfq-workflow', 'start-negotiation', { rfqId });

/** The buyer's T-rank for one quote: T1–T4, or NOT_ACCEPTED to drop it from negotiation. */
export const setTRank = (rfqId: string, quoteId: string, tRank: string): Promise<TRankChange> => {
  const { userId, userName } = getSignedInUser();
  return requestCollection<TRankChange>('rfq-workflow', 'set-t-rank', { rfqId, quoteId, tRank, userId, userName });
};

/** The buyer's chosen supplier. Anyone but the recommended vendor needs a comment (checked by the backend). */
export const selectSupplier = (rfqId: string, vendorId: string, comment?: string): Promise<SupplierSelection> => {
  const { userId, userName } = getSignedInUser();
  return requestCollection<SupplierSelection>('rfq-workflow', 'select-supplier', { rfqId, vendorId, comment, userId, userName });
};
