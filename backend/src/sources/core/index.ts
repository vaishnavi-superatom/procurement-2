/**
 * Core Module - Shared infrastructure for source modules
 */

export * from './types';
export { BaseSource } from './base-source';
export { inferColumnTypes } from './column-types';
export { streamXlsxToCsvs, ensureXlsxConverted } from './xlsx-to-csv';
export type { ConvertedSheet, XlsxToCsvOptions } from './xlsx-to-csv';
export { sourceRegistry } from './registry';
export {
  SourceManager,
  initializeSources,
  getSourceManager,
  shutdownSources,
  setModuleLoader,
} from './source-manager';
export { FederationInstance } from '../federation';
