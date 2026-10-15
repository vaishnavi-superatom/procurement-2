/**
 * Redis Source Module
 *
 * Connect to Redis as a read-only source. Redis has no query language or schema,
 * so the source agent emits read commands (GET/HGETALL/LRANGE/SCAN/…, plus
 * FT.SEARCH when RediSearch is present); the connector runs them through a
 * read-only command guard. Schema is a profile of the keyspace: SCAN a sample of
 * keys, group by key pattern, and infer each family's type/fields. See the Redis
 * rules in .prompts/database-rules/redis.md.
 */

import { SourceModule, SourceConfig, ConfigField } from '../core';
import { RedisInstance } from './instance';

const configFields: ConfigField[] = [
  {
    name: 'url',
    label: 'Connection URL',
    type: 'text',
    required: false,
    placeholder: 'rediss://user:password@host:6379/0',
    description: 'Full Redis URL (redis:// or rediss:// for TLS). If set, host/port/etc. below are ignored.',
  },
  {
    name: 'host',
    label: 'Host',
    type: 'text',
    required: false,
    placeholder: 'localhost',
    description: 'Redis host (used when no URL is given)',
  },
  {
    name: 'port',
    label: 'Port',
    type: 'number',
    required: false,
    defaultValue: 6379,
    description: 'Redis port',
    validation: { min: 1, max: 65535 },
  },
  {
    name: 'username',
    label: 'Username (ACL)',
    type: 'text',
    required: false,
    placeholder: 'superatom_ro',
    description: 'ACL username (Redis 6+). Prefer a dedicated read-only user scoped to your key patterns.',
  },
  {
    name: 'password',
    label: 'Password',
    type: 'password',
    required: false,
    description: 'Password for the ACL user (or the shared password on older Redis)',
  },
  {
    name: 'db',
    label: 'Database Index',
    type: 'number',
    required: false,
    defaultValue: 0,
    description: 'Redis logical database number',
    validation: { min: 0, max: 255 },
  },
  {
    name: 'tls',
    label: 'Use TLS',
    type: 'boolean',
    required: false,
    defaultValue: false,
    description: 'Enable TLS (or use a rediss:// URL). Required for managed Redis; ElastiCache Serverless enforces it.',
  },
  {
    name: 'cluster',
    label: 'Cluster Mode',
    type: 'boolean',
    required: false,
    defaultValue: false,
    description: 'Use Redis Cluster mode. Auto-enabled for ElastiCache Serverless / cluster (clustercfg) endpoints; set explicitly for other cluster deployments.',
  },
  {
    name: 'scanMatch',
    label: 'Key Pattern Allowlist',
    type: 'text',
    required: false,
    placeholder: 'device:*, chamber:*',
    description: 'Comma-separated key patterns to profile/expose. Leave blank to sample the whole keyspace.',
  },
];

function validateConfig(config: any): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  const hasUrl = typeof config.url === 'string' && config.url.trim().length > 0;
  const hasHost = typeof config.host === 'string' && config.host.trim().length > 0;
  if (!hasUrl && !hasHost) {
    errors.push('Provide either a connection url or a host');
  }
  if (config.port !== undefined && config.port !== null && typeof config.port !== 'number') {
    errors.push('port must be a number');
  }
  if (config.db !== undefined && config.db !== null && typeof config.db !== 'number') {
    errors.push('db must be a number');
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

const RedisModule: SourceModule = {
  type: 'redis',
  name: 'Redis',
  description: 'Connect to Redis (read-only) for key/pattern lookups and, with RediSearch, indexed queries',

  capabilities: {
    query: true,
    write: false,
    schema: true,
    realtime: false,
    parameterized: false,
  },

  createInstance: (config: SourceConfig) => new RedisInstance(config),
  validateConfig,
  configFields,
};

export default RedisModule;
export { RedisInstance };
