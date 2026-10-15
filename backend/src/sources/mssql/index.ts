/**
 * MSSQL Source Module
 *
 * Self-contained module for Microsoft SQL Server data sources
 */

import { SourceModule, SourceConfig, ConfigField } from '../core';
import { MSSQLInstance } from './instance';

/**
 * Configuration fields for UI
 */
const configFields: ConfigField[] = [
  {
    name: 'server',
    label: 'Server',
    type: 'text',
    required: true,
    placeholder: 'localhost',
    description: 'SQL Server hostname or IP address',
  },
  {
    name: 'port',
    label: 'Port',
    type: 'number',
    required: true,
    defaultValue: 1433,
    description: 'SQL Server port',
    validation: { min: 1, max: 65535 },
  },
  {
    name: 'database',
    label: 'Database',
    type: 'text',
    required: false,
    placeholder: 'master',
    description: 'Database name (optional, defaults to the login user\'s default database)',
  },
  {
    name: 'user',
    label: 'Username',
    type: 'text',
    required: true,
    placeholder: 'sa',
    description: 'SQL Server username',
  },
  {
    name: 'password',
    label: 'Password',
    type: 'password',
    required: true,
    description: 'SQL Server password',
  },
  {
    name: 'schema',
    label: 'Schema',
    type: 'text',
    required: false,
    defaultValue: 'dbo',
    placeholder: 'dbo',
    description: 'Default schema (optional)',
  },
  {
    name: 'encrypt',
    label: 'Encrypt Connection',
    type: 'boolean',
    required: false,
    defaultValue: true,
    description: 'Use encrypted connection',
  },
  {
    name: 'trustServerCertificate',
    label: 'Trust Server Certificate',
    type: 'boolean',
    required: false,
    defaultValue: true,
    description: 'Trust the server certificate (for self-signed certs)',
  },
  {
    name: 'bridge',
    label: 'Connect via Bridge',
    type: 'boolean',
    required: false,
    defaultValue: false,
    description: 'Route queries through the db-bridge over WebSocket. Use when the database is only reachable from a private network and a db-bridge is running there.',
  },
];

/**
 * Validate configuration
 */
function validateConfig(config: any): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (!config.server || typeof config.server !== 'string') {
    errors.push('server is required and must be a string');
  }

  if (!config.port || typeof config.port !== 'number') {
    errors.push('port is required and must be a number');
  } else if (config.port < 1 || config.port > 65535) {
    errors.push('port must be between 1 and 65535');
  }

  if (config.database !== undefined && config.database !== null && typeof config.database !== 'string') {
    errors.push('database must be a string if provided');
  }

  if (!config.user || typeof config.user !== 'string') {
    errors.push('user is required and must be a string');
  }

  if (!config.password || typeof config.password !== 'string') {
    errors.push('password is required and must be a string');
  }

  if (config.bridge !== undefined && typeof config.bridge !== 'boolean') {
    errors.push('bridge must be a boolean');
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * MSSQL Module Definition
 */
const MSSQLModule: SourceModule = {
  type: 'mssql',
  name: 'Microsoft SQL Server',
  description: 'Connect to Microsoft SQL Server databases for T-SQL queries and data analysis',

  capabilities: {
    query: true,
    write: true,
    schema: true,
    realtime: false,
    parameterized: true,
  },

  createInstance: (config: SourceConfig) => new MSSQLInstance(config),
  validateConfig,
  configFields,
};

export default MSSQLModule;
export { MSSQLInstance };
