import { getRequestContext } from '@superatomai/sdk-node';

const MAX_NAME_LENGTH = 255;

/**
 * Who is acting on this request. The relay-verified login is the user id
 * whenever the request carries one; the id the browser sends only fills in
 * when it doesn't. Names aren't part of the verified identity, so the name is
 * display-only. Call before queryProcurement, which runs as a system flow
 * with its own context.
 */
export function requestAuthor(params: any): { userId?: string; userName?: string } {
	const principal = getRequestContext()?.principal;
	const userId = principal?.kind === 'user'
		? principal.userId
		: (typeof params?.userId === 'string' ? params.userId : undefined);
	const userName = typeof params?.userName === 'string'
		? params.userName.trim().slice(0, MAX_NAME_LENGTH) || undefined
		: undefined;
	return { userId, userName };
}
