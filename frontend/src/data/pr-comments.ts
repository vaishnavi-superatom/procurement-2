// Comments on a purchase request — stored by the backend's `pr-comments`
// collection in the procurement database, next to the PRs themselves.
import { requestCollection } from './collection-request';
import { getSignedInUser } from './signed-in-user';

export interface PRComment {
  id: number;
  prId: string;
  userId: string | null;
  userName: string | null;
  body: string;
  createdAt: string;
}

export const listPrComments = (prId: string): Promise<PRComment[]> =>
  requestCollection<PRComment[]>('pr-comments', 'list', { prId });

export const createPrComment = (prId: string, body: string): Promise<PRComment> => {
  const { userId, userName } = getSignedInUser();
  return requestCollection<PRComment>('pr-comments', 'create', { prId, body, userId, userName });
};
