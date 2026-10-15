/**
 * NetSuite OAuth 2.0 Client Credentials (M2M) authentication.
 *
 * NetSuite issues a short-lived access token in exchange for a JWT "client
 * assertion" signed with the private key matching a certificate uploaded to
 * the NetSuite integration record. The assertion's own lifetime is capped by
 * NetSuite at 3600s (requesting longer is rejected), and the access token it
 * returns is likewise fixed at ~1 hour — neither is configurable client-side.
 * Callers must cache the returned token and re-mint on expiry rather than
 * requesting a longer-lived one.
 */

import jwt from 'jsonwebtoken';

export interface NetSuiteAuthConfig {
  accountId: string;
  clientId: string;
  certificateId: string;
  privateKey: string;
  restWebServices?: boolean;
  suiteAnalytics?: boolean;
}

export interface NetSuiteToken {
  accessToken: string;
  expiresInSeconds: number;
  tokenType: string;
}

export function getApiBaseUrl(accountId: string): string {
  return `https://${accountId}.suitetalk.api.netsuite.com`;
}

export function getTokenUrl(accountId: string): string {
  return `${getApiBaseUrl(accountId)}/services/rest/auth/oauth2/v1/token`;
}

function buildScopes(cfg: NetSuiteAuthConfig): string[] {
  const scopes: string[] = [];
  if (cfg.restWebServices !== false) scopes.push('rest_webservices');
  if (cfg.suiteAnalytics !== false) scopes.push('suite_analytics');
  if (scopes.length === 0) {
    throw new Error(
      'NetSuite source config must enable at least one OAuth scope (REST Web Services and/or SuiteAnalytics).'
    );
  }
  return scopes;
}

function createClientAssertion(cfg: NetSuiteAuthConfig, tokenUrl: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: cfg.clientId,
      scope: buildScopes(cfg),
      aud: tokenUrl,
      iat: now,
      exp: now + 3600,
    },
    cfg.privateKey,
    {
      algorithm: 'PS256',
      header: {
        alg: 'PS256',
        typ: 'JWT',
        kid: cfg.certificateId,
      },
    }
  );
}

/**
 * Exchange a freshly-signed client assertion for a NetSuite access token.
 */
export async function mintAccessToken(cfg: NetSuiteAuthConfig): Promise<NetSuiteToken> {
  const tokenUrl = getTokenUrl(cfg.accountId);
  const clientAssertion = createClientAssertion(cfg, tokenUrl);

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  if (!response.ok) {
    const detail = typeof json === 'string' ? json : JSON.stringify(json);
    throw new Error(
      `NetSuite token request failed (${response.status} ${response.statusText}): ${detail}`
    );
  }

  return {
    accessToken: json.access_token,
    expiresInSeconds: json.expires_in ?? 3600,
    tokenType: json.token_type ?? 'Bearer',
  };
}
