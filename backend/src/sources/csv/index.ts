/**
 * CSV Source Module
 *
 * Query CSV files using DuckDB SQL engine
 */

import { SourceModule, SourceConfig, ConfigField } from '../core';
import { CSVInstance } from './instance';

const configFields: ConfigField[] = [
  {
    name: 'filePath',
    label: 'File Path',
    type: 'text',
    required: true,
    placeholder: '/path/to/file.csv',
    description: 'Path to CSV file',
  },
  {
    name: 'delimiter',
    label: 'Delimiter',
    type: 'text',
    required: false,
    defaultValue: ',',
    placeholder: ',',
    description: 'Field delimiter character',
  },
  {
    name: 'hasHeader',
    label: 'Has Header Row',
    type: 'boolean',
    required: false,
    defaultValue: true,
    description: 'First row contains column names',
  },
  {
    name: 'encoding',
    label: 'Encoding',
    type: 'select',
    required: false,
    defaultValue: 'utf-8',
    options: [
      { value: 'utf-8', label: 'UTF-8' },
      { value: 'ascii', label: 'ASCII' },
      { value: 'latin1', label: 'Latin-1' },
    ],
    description: 'File encoding',
  },
  {
    name: 'refreshInterval',
    label: 'Refresh Interval (minutes)',
    type: 'number',
    required: false,
    defaultValue: 1440,
    description: 'Auto-refresh interval in minutes (0 = no auto-refresh, default: 1440 i.e. 1 day)',
  },
];

/** Max files in a multi-CSV source's `files[]`. */
export const MAX_FILES_PER_SOURCE = 20;

function validateConfig(config: any): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (Array.isArray(config.files) && config.files.length > 0) {
    if (config.files.length > MAX_FILES_PER_SOURCE) {
      errors.push(`Too many files (${config.files.length}). Maximum is ${MAX_FILES_PER_SOURCE} per source.`);
    }
    for (const f of config.files) {
      if (!f || typeof f.r2Key !== 'string' || !f.r2Key || typeof f.fileName !== 'string' || !f.fileName) {
        errors.push('Each entry in files[] requires r2Key and fileName');
        break;
      }
    }
  } else {
    // Any one of: filePath (already-on-disk path or URL), fileData+fileName
    // (legacy base64 upload), or r2Key (R2 multipart upload — the create handler
    // resolves it to a local filePath before this validator runs).
    const hasFilePath = config.filePath && typeof config.filePath === 'string';
    const hasFileData = config.fileData && config.fileName;
    const hasR2Key = config.r2Key && typeof config.r2Key === 'string';
    if (!hasFilePath && !hasFileData && !hasR2Key) {
      errors.push('filePath, file upload (fileData + fileName), r2Key, or files[] is required');
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

const CSVModule: SourceModule = {
  type: 'csv',
  name: 'CSV',
  description: 'Query CSV files using DuckDB SQL engine',

  capabilities: {
    query: true,
    write: false,
    schema: true,
    realtime: false,
    parameterized: true,
  },

  createInstance: (config: SourceConfig) => new CSVInstance(config),
  validateConfig,
  configFields,
};

export default CSVModule;
export { CSVInstance };
