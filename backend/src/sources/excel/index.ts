/**
 * Excel Source Module
 *
 * Read data from Excel (.xlsx) files using DuckDB SQL engine
 */

import { SourceModule, SourceConfig, ConfigField } from '../core';
import { ExcelInstance } from './instance';

const configFields: ConfigField[] = [
  {
    name: 'filePath',
    label: 'File Path',
    type: 'text',
    required: true,
    placeholder: '/path/to/file.xlsx',
    description: 'Path to Excel file (local path or URL)',
  },
  {
    name: 'sheets',
    label: 'Sheets',
    type: 'textarea',
    required: false,
    placeholder: 'Sheet1, Sheet2',
    description: 'Comma-separated sheet names (leave empty for all sheets)',
  },
  {
    name: 'headerRow',
    label: 'Header Row',
    type: 'number',
    required: false,
    defaultValue: 1,
    description: 'Row number containing headers (1-based)',
    validation: { min: 1 },
  },
  {
    name: 'refreshInterval',
    label: 'Refresh Interval (minutes)',
    type: 'number',
    required: false,
    defaultValue: 1440,
    description: 'Auto-refresh interval in minutes (0 = no auto-refresh, default: 1440 i.e. 1 day)',
    validation: { min: 0 },
  },
];

function validateConfig(config: any): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  // Any one of: filePath (already-on-disk path or URL), fileData+fileName
  // (legacy base64 upload), or r2Key (R2 multipart upload — the create handler
  // resolves it to a local filePath before this validator runs).
  const hasFilePath = config.filePath && typeof config.filePath === 'string';
  const hasFileData = config.fileData && config.fileName;
  const hasR2Key = config.r2Key && typeof config.r2Key === 'string';
  if (!hasFilePath && !hasFileData && !hasR2Key) {
    errors.push('filePath, file upload (fileData + fileName), or r2Key is required');
  }

  if (config.headerRow !== undefined && (typeof config.headerRow !== 'number' || config.headerRow < 1)) {
    errors.push('headerRow must be a positive number');
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

const ExcelModule: SourceModule = {
  type: 'excel',
  name: 'Excel',
  description: 'Query Excel spreadsheets (.xlsx) using DuckDB SQL engine',

  capabilities: {
    query: true,
    write: false,
    schema: true,
    realtime: false,
    parameterized: true,
  },

  createInstance: (config: SourceConfig) => new ExcelInstance(config),
  validateConfig,
  configFields,
};

export default ExcelModule;
export { ExcelInstance };
