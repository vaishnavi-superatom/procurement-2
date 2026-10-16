// Technical comments on a vendor's bid — the backend's `rfq-vendor-comments`
// collection. One thread per RFQ + vendor.
import { requestCollection } from './collection-request';
import { getSignedInUser } from './signed-in-user';

export interface VendorComment {
  id: number;
  rfqId: string;
  vendorId: string;
  userId: string | null;
  userName: string | null;
  body: string;
  createdAt: string;
}

export const listVendorComments = (rfqId: string, vendorId: string): Promise<VendorComment[]> =>
  requestCollection<VendorComment[]>('rfq-vendor-comments', 'list', { rfqId, vendorId });

export const createVendorComment = (rfqId: string, vendorId: string, body: string): Promise<VendorComment> => {
  const { userId, userName } = getSignedInUser();
  return requestCollection<VendorComment>('rfq-vendor-comments', 'create', { rfqId, vendorId, body, userId, userName });
};
