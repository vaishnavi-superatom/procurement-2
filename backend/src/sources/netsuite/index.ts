/**
 * NetSuite Source Module
 *
 * Connect to a NetSuite ERP account and query it via SuiteQL (read-only).
 * Auth is OAuth 2.0 Client Credentials (M2M) with a JWT-bearer client
 * assertion — see ./auth.ts. This is not the legacy Token-Based Auth (HMAC)
 * scheme; it requires an Integration record + certificate uploaded in
 * NetSuite, not a consumer key/secret pair.
 */

import { SourceModule, SourceConfig, ConfigField } from '../core';
import { NetSuiteInstance } from './instance';

const configFields: ConfigField[] = [
  {
    name: 'accountId',
    label: 'Account ID',
    type: 'text',
    required: true,
    placeholder: '1234567-sb1',
    description: 'NetSuite account ID, lowercase with a hyphen (e.g. sandbox "1234567-sb1"). Used as the API hostname.',
  },
  {
    name: 'clientId',
    label: 'Client ID (Consumer Key)',
    type: 'text',
    required: true,
    description: 'Consumer Key from the NetSuite Integration record',
  },
  {
    name: 'certificateId',
    label: 'Certificate ID',
    type: 'text',
    required: true,
    description: 'Certificate ID (JWT "kid") issued when the public key/certificate was uploaded to the Integration record',
  },
  {
    name: 'privateKey',
    label: 'Private Key (PEM)',
    type: 'textarea',
    required: true,
    placeholder: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
    description: 'PEM-encoded private key matching the uploaded certificate. Treat as a secret.',
  },
  {
    name: 'restWebServices',
    label: 'Enable REST Web Services scope',
    type: 'boolean',
    required: false,
    defaultValue: true,
    description: 'Grants rest_webservices scope (REST Record API access)',
  },
  {
    name: 'suiteAnalytics',
    label: 'Enable SuiteAnalytics scope',
    type: 'boolean',
    required: false,
    defaultValue: true,
    description: 'Grants suite_analytics scope — required for SuiteQL query execution',
  },
  {
    name: 'timeout',
    label: 'Timeout (ms)',
    type: 'number',
    required: false,
    defaultValue: 30000,
    description: 'Request timeout in milliseconds',
  },
];

function validateConfig(config: any): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (!config.accountId || typeof config.accountId !== 'string') {
    errors.push('accountId is required and must be a string');
  }
  if (!config.clientId || typeof config.clientId !== 'string') {
    errors.push('clientId is required and must be a string');
  }
  if (!config.certificateId || typeof config.certificateId !== 'string') {
    errors.push('certificateId is required and must be a string');
  }
  if (!config.privateKey || typeof config.privateKey !== 'string') {
    errors.push('privateKey is required and must be a string');
  } else if (!config.privateKey.includes('BEGIN')) {
    errors.push('privateKey does not look like a PEM-encoded key');
  }
  if (config.restWebServices === false && config.suiteAnalytics === false) {
    errors.push('At least one of restWebServices or suiteAnalytics must be enabled');
  }
  if (config.suiteAnalytics === false) {
    errors.push('suiteAnalytics scope is required for SuiteQL query execution');
  }
  if (config.restWebServices === false) {
    errors.push('restWebServices scope is required for schema extraction (reads the REST metadata catalog to discover queryable tables)');
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

const NetSuiteModule: SourceModule = {
  type: 'netsuite',
  name: 'NetSuite',
  description: 'Connect to a NetSuite ERP account and query it via SuiteQL',

  capabilities: {
    query: true,
    write: false,
    schema: true,
    realtime: false,
    parameterized: false,
  },

  createInstance: (config: SourceConfig) => new NetSuiteInstance(config),
  validateConfig,
  configFields,
};

export default NetSuiteModule;
export { NetSuiteInstance };
