/**
 * PostgreSQL Source Module
 *
 * Self-contained module for PostgreSQL data sources
 */

import { SourceModule, SourceConfig, ConfigField } from '../core';
import { PostgresInstance } from './instance';

/**
 * Configuration fields for UI
 */
const configFields: ConfigField[] = [
  {
    name: 'host',
    label: 'Host',
    type: 'text',
    required: true,
    placeholder: 'localhost',
    description: 'Database server hostname or IP address',
  },
  {
    name: 'port',
    label: 'Port',
    type: 'number',
    required: false,
    defaultValue: 5432,
    description: 'Database server port',
    validation: { min: 1, max: 65535 },
  },
  {
    name: 'database',
    label: 'Database',
    type: 'text',
    required: true,
    placeholder: 'mydb',
    description: 'Database name',
  },
  {
    name: 'user',
    label: 'Username',
    type: 'text',
    required: true,
    placeholder: 'postgres',
    description: 'Database username',
  },
  {
    name: 'password',
    label: 'Password',
    type: 'password',
    required: true,
    description: 'Database password',
  },
  {
    name: 'schema',
    label: 'Schema',
    type: 'text',
    required: false,
    defaultValue: 'public',
    placeholder: 'public',
    description: 'Default schema (optional)',
  },
  {
    name: 'ssl',
    label: 'Use SSL',
    type: 'boolean',
    required: false,
    defaultValue: false,
    description: 'Enable SSL connection',
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

  if (!config.host || typeof config.host !== 'string') {
    errors.push('host is required and must be a string');
  }

  if (config.port !== undefined && config.port !== null) {
    if (typeof config.port !== 'number') {
      errors.push('port must be a number');
    } else if (config.port < 1 || config.port > 65535) {
      errors.push('port must be between 1 and 65535');
    }
  }

  if (!config.database || typeof config.database !== 'string') {
    errors.push('database is required and must be a string');
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
 * PostgreSQL Module Definition
 */
const PostgresModule: SourceModule = {
  type: 'postgres',
  name: 'PostgreSQL',
  description: 'Connect to PostgreSQL databases for SQL queries and data analysis',

  capabilities: {
    query: true,
    write: true,
    schema: true,
    realtime: false,
    parameterized: true,
  },

  createInstance: (config: SourceConfig) => new PostgresInstance(config),
  validateConfig,
  configFields,
};

export default PostgresModule;
export { PostgresInstance };
