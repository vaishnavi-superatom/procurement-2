/**
 * Source Fingerprinting & Deterministic ID Generation
 *
 * Generates stable, deterministic source IDs from connection config
 * so that the same source always gets the same ID and tool ID.
 */

import { createHash } from 'crypto';
import type { SourceType } from './types';

/**
 * Extract identifying fields from a source config into a canonical fingerprint string.
 * Excludes credentials — only uses fields that identify the *target* (host, database, etc.)
 */
export function getSourceFingerprint(type: SourceType, config: Record<string, any>): string {
  switch (type) {
    case 'postgres':
      return `${config.host || ''}:${config.port || 5432}:${config.database || ''}`;

    case 'mysql':
      return `${config.host || ''}:${config.port || 3306}:${config.database || ''}`;

    case 'mssql':
      return `${config.server || ''}:${config.port || 1433}:${config.database || ''}`;

    case 'excel':
      return `${config.filePath || ''}`;

    case 'csv':
      return `${config.filePath || ''}`;

    case 'rest_api':
      return `${config.baseUrl || ''}:${config.authType || 'none'}`;

    case 'graphql':
      return `${config.endpoint || ''}:${config.authType || 'none'}`;

    case 'dynamodb':
      // Identify by target (region/endpoint + table allowlist), never credentials,
      // so rotating the access key keeps the same source ID.
      return `${config.region || ''}:${config.endpoint || 'aws'}:${config.tables || 'all'}`;

    case 'redis':
      // Identify by target (host/port/db or URL host), never credentials.
      return `${config.host || ''}:${config.port || 6379}:${config.db ?? 0}`;

    default:
      // Fallback: hash the entire config (minus obvious secret fields)
      const { password, accessToken, apiKey, bearerToken, secret, ...safeConfig } = config;
      return hashValue(JSON.stringify(safeConfig));
  }
}

/**
 * Generate a deterministic source ID from type, config, and projectId.
 *
 * Format: {type}-{first 12 chars of sha256(projectId::fingerprint)}
 * Example: postgres-a1b2c3d4e5f6
 *
 * Same input always produces the same ID.
 * Including projectId allows the same database to exist in different projects.
 */
export function generateSourceId(
  type: SourceType,
  config: Record<string, any>,
  projectId: string,
): string {
  const fingerprint = getSourceFingerprint(type, config);
  const raw = `${projectId}::${type}::${fingerprint}`;
  const hash = createHash('sha256').update(raw).digest('hex').substring(0, 12);
  return `${type}-${hash}`;
}

/**
 * Hash a single value (used for sensitive fields like tokens)
 */
function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').substring(0, 16);
}
