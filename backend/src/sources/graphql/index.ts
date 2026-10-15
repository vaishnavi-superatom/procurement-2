/**
 * GraphQL Source Module
 *
 * Connect to GraphQL APIs for data retrieval
 */

import { SourceModule, SourceConfig, ConfigField } from '../core';
import { GraphQLInstance } from './instance';

const configFields: ConfigField[] = [
  {
    name: 'endpoint',
    label: 'GraphQL Endpoint',
    type: 'text',
    required: true,
    placeholder: 'https://api.example.com/graphql',
    description: 'GraphQL API endpoint URL',
  },
  {
    name: 'authType',
    label: 'Authentication Type',
    type: 'select',
    required: true,
    defaultValue: 'none',
    options: [
      { value: 'none', label: 'No Authentication' },
      { value: 'api_key', label: 'API Key' },
      { value: 'bearer', label: 'Bearer Token' },
      { value: 'basic', label: 'Basic Auth' },
    ],
    description: 'Authentication method',
  },
  {
    name: 'authConfig.apiKey',
    label: 'API Key',
    type: 'password',
    required: false,
    description: 'API key (for API Key auth)',
  },
  {
    name: 'authConfig.apiKeyHeader',
    label: 'API Key Header',
    type: 'text',
    required: false,
    defaultValue: 'X-API-Key',
    placeholder: 'X-API-Key',
    description: 'Header name for API key',
  },
  {
    name: 'authConfig.bearerToken',
    label: 'Bearer Token',
    type: 'password',
    required: false,
    description: 'Bearer token (for Bearer auth)',
  },
  {
    name: 'authConfig.username',
    label: 'Username',
    type: 'text',
    required: false,
    description: 'Username (for Basic auth)',
  },
  {
    name: 'authConfig.password',
    label: 'Password',
    type: 'password',
    required: false,
    description: 'Password (for Basic auth)',
  },
  {
    name: 'timeout',
    label: 'Timeout (ms)',
    type: 'number',
    required: false,
    defaultValue: 30000,
    description: 'Request timeout in milliseconds',
  },
  {
    name: 'operations',
    label: 'Operations Configuration',
    type: 'textarea',
    required: true,
    placeholder: JSON.stringify([
      {
        id: 'get-users',
        name: 'Get Users',
        type: 'query',
        query: 'query GetUsers($limit: Int) { users(limit: $limit) { id name email } }',
        variables: { limit: 'Int' },
        responseFields: [
          { name: 'id', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'email', type: 'string' },
        ],
      },
    ], null, 2),
    description: 'JSON array of GraphQL operation configurations',
  },
];

function validateConfig(config: any): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (!config.endpoint || typeof config.endpoint !== 'string') {
    errors.push('endpoint is required');
  } else if (!config.endpoint.startsWith('http')) {
    errors.push('endpoint must start with http:// or https://');
  }

  if (!config.authType) {
    errors.push('authType is required');
  }

  if (config.authType === 'api_key' && !config.authConfig?.apiKey) {
    errors.push('apiKey is required for API Key authentication');
  }

  if (config.authType === 'bearer' && !config.authConfig?.bearerToken) {
    errors.push('bearerToken is required for Bearer authentication');
  }

  if (config.authType === 'basic') {
    if (!config.authConfig?.username) errors.push('username is required for Basic auth');
    if (!config.authConfig?.password) errors.push('password is required for Basic auth');
  }

  if (!config.operations || !Array.isArray(config.operations) || config.operations.length === 0) {
    errors.push('At least one operation is required');
  } else {
    // Validate each operation
    config.operations.forEach((op: any, index: number) => {
      if (!op.id) errors.push(`Operation ${index}: id is required`);
      if (!op.query) errors.push(`Operation ${index}: query is required`);
      if (!op.type || !['query', 'mutation'].includes(op.type)) {
        errors.push(`Operation ${index}: type must be 'query' or 'mutation'`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

const GraphQLModule: SourceModule = {
  type: 'graphql',
  name: 'GraphQL',
  description: 'Connect to GraphQL APIs to query and mutate data',

  capabilities: {
    query: false,
    write: true,
    schema: true,
    realtime: false,
    parameterized: true,
  },

  createInstance: (config: SourceConfig) => new GraphQLInstance(config),
  validateConfig,
  configFields,
};

export default GraphQLModule;
export { GraphQLInstance };
