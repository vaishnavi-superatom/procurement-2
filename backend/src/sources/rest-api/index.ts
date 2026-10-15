/**
 * REST API Source Module
 *
 * Connect to REST APIs for data retrieval
 */

import { SourceModule, SourceConfig, ConfigField } from '../core';
import { RestApiInstance } from './instance';

const configFields: ConfigField[] = [
  {
    name: 'baseUrl',
    label: 'Base URL',
    type: 'text',
    required: true,
    placeholder: 'https://api.example.com/v1',
    description: 'Base URL for API requests',
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
    name: 'endpoints',
    label: 'Endpoints Configuration',
    type: 'textarea',
    required: true,
    placeholder: JSON.stringify([
      { id: 'get-users', name: 'Get Users', method: 'GET', path: '/users' },
    ], null, 2),
    description: 'JSON array of endpoint configurations',
  },
];

function validateConfig(config: any): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (!config.baseUrl || typeof config.baseUrl !== 'string') {
    errors.push('baseUrl is required');
  } else if (!config.baseUrl.startsWith('http')) {
    errors.push('baseUrl must start with http:// or https://');
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

  if (!config.endpoints || !Array.isArray(config.endpoints) || config.endpoints.length === 0) {
    errors.push('At least one endpoint is required');
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

const RestApiModule: SourceModule = {
  type: 'rest_api',
  name: 'REST API',
  description: 'Connect to REST APIs to fetch and interact with data',

  capabilities: {
    query: false,
    write: true,
    schema: true,
    realtime: false,
    parameterized: true,
  },

  createInstance: (config: SourceConfig) => new RestApiInstance(config),
  validateConfig,
  configFields,
};

export default RestApiModule;
export { RestApiInstance };
