/**
 * MySQL Source Module
 *
 * Self-contained module for MySQL data sources
 */

import { SourceModule, SourceConfig, ConfigField } from '../core';
import { MySQLInstance } from './instance';

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
    required: true,
    defaultValue: 3306,
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
    placeholder: 'root',
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
    name: 'ssl',
    label: 'Use SSL',
    type: 'boolean',
    required: false,
    defaultValue: false,
    description: 'Enable SSL connection',
  },
  {
    name: 'timezone',
    label: 'Timezone',
    type: 'text',
    required: false,
    defaultValue: 'UTC',
    placeholder: 'UTC',
    description: 'Connection timezone (optional)',
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

  if (!config.port || typeof config.port !== 'number') {
    errors.push('port is required and must be a number');
  } else if (config.port < 1 || config.port > 65535) {
    errors.push('port must be between 1 and 65535');
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
 * MySQL Module Definition
 */
const MySQLModule: SourceModule = {
  type: 'mysql',
  name: 'MySQL',
  description: 'Connect to MySQL databases for SQL queries and data analysis',

  capabilities: {
    query: true,
    write: true,
    schema: true,
    realtime: false,
    parameterized: true,
  },

  createInstance: (config: SourceConfig) => new MySQLInstance(config),
  validateConfig,
  configFields,
};

export default MySQLModule;
export { MySQLInstance };
