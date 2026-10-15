/**
 * Builds the public URLs that recipients click in report / alert emails.
 *
 * Goal: link to the organization's own subdomain (`https://{slug}.superatom.ai`)
 * so a logged-in user lands directly in their org and is NOT asked for the org
 * slug at the SSO login screen.
 *
 * This backend is single-org per deployment, so the slug is a constant. It is
 * baked into `.env` as SA_ORG_SLUG by setup.sh (resolved from SA-API `/auth/me`
 * at setup time) — no runtime SA-API lookup is needed. When the slug is not
 * configured we fall back to CHAT_AGENT_BASE_URL so emails never break.
 *
 * The base domain defaults to `superatom.ai`; override with SA_APP_BASE_DOMAIN
 * for non-prod hosts.
 */

const APP_BASE_DOMAIN = process.env.SA_APP_BASE_DOMAIN || 'superatom.ai';

function legacyBaseUrl(): string {
	return process.env.CHAT_AGENT_BASE_URL || 'https://dev.live.superatom.ai';
}

/**
 * Public base URL for the org's app, e.g. `https://acme.superatom.ai`.
 * Falls back to CHAT_AGENT_BASE_URL when SA_ORG_SLUG is not set.
 */
export function getAppBaseUrl(): string {
	const slug = process.env.SA_ORG_SLUG;
	return slug ? `https://${slug}.${APP_BASE_DOMAIN}` : legacyBaseUrl();
}

/** Public URL of a specific report — used in email "View Report" buttons. */
export function buildReportUrl(projectId: string, reportId: string): string {
	return `${getAppBaseUrl()}/apps/${projectId}/report/${reportId}`;
}
