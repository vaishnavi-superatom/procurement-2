/**
 * DynamoDB Source Module
 *
 * Connect to Amazon DynamoDB. The source agent writes PartiQL (DynamoDB's
 * SQL-compatible dialect); `ExecuteStatement` automatically runs an efficient
 * Query/GetItem when the WHERE clause pins the partition key and only falls back
 * to a bounded Scan otherwise. PartiQL cannot JOIN or aggregate — those are
 * handled downstream in the scripts-flow JS transformations over the returned
 * rows. See docs/dynamodb-integration-client-questions.md for the design notes.
 */

import { SourceModule, SourceConfig, ConfigField } from '../core';
import { DynamoDBInstance } from './instance';

/**
 * Configuration fields for UI
 */
const configFields: ConfigField[] = [
  {
    name: 'region',
    label: 'AWS Region',
    type: 'text',
    required: true,
    placeholder: 'us-east-1',
    description: 'AWS region the DynamoDB tables live in',
  },
  {
    name: 'accessKeyId',
    label: 'Access Key ID',
    type: 'text',
    required: true,
    description: 'AWS access key ID (IAM user/role with read access to the tables)',
  },
  {
    name: 'secretAccessKey',
    label: 'Secret Access Key',
    type: 'password',
    required: true,
    description: 'AWS secret access key',
  },
  {
    name: 'sessionToken',
    label: 'Session Token',
    type: 'password',
    required: false,
    description: 'Optional STS session token (for temporary credentials)',
  },
  {
    name: 'endpoint',
    label: 'Endpoint URL',
    type: 'text',
    required: false,
    placeholder: 'http://localhost:8000',
    description: 'Optional custom endpoint (e.g. DynamoDB Local). Leave blank for AWS.',
  },
  {
    name: 'tables',
    label: 'Tables',
    type: 'textarea',
    required: false,
    placeholder: 'Orders, Customers, Inventory',
    description: 'Comma-separated allowlist of tables to expose. Leave blank to auto-discover all tables in the account/region.',
  },
];

/**
 * Validate configuration
 */
function validateConfig(config: any): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (!config.region || typeof config.region !== 'string') {
    errors.push('region is required and must be a string');
  }
  if (!config.accessKeyId || typeof config.accessKeyId !== 'string') {
    errors.push('accessKeyId is required and must be a string');
  }
  if (!config.secretAccessKey || typeof config.secretAccessKey !== 'string') {
    errors.push('secretAccessKey is required and must be a string');
  }
  if (config.endpoint !== undefined && config.endpoint !== null && typeof config.endpoint !== 'string') {
    errors.push('endpoint must be a string');
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * DynamoDB Module Definition
 */
const DynamoDBModule: SourceModule = {
  type: 'dynamodb',
  name: 'DynamoDB',
  description: 'Connect to Amazon DynamoDB and query it with PartiQL for lookups and bounded analytics',

  capabilities: {
    query: true,
    write: false,
    schema: true,
    realtime: false,
    parameterized: true,
  },

  createInstance: (config: SourceConfig) => new DynamoDBInstance(config),
  validateConfig,
  configFields,
};

export default DynamoDBModule;
export { DynamoDBInstance };
