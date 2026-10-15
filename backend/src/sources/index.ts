/**
 * Sources Module - Multi-Source Data Architecture
 *
 * This module provides a plugin-based architecture for data sources.
 * Modules are loaded lazily - only when a source of that type is configured.
 *
 * Supported Sources:
 * - PostgreSQL (postgres)
 * - MySQL (mysql)
 * - Microsoft SQL Server (mssql)
 * - Excel (.xlsx, .xls)
 * - CSV
 * - REST API
 * - GraphQL
 * - DynamoDB (dynamodb)
 * - Redis (redis)
 * - NetSuite (netsuite)
 *
 * Usage:
 *   import { sourceRegistry, initializeSources, getSourceManager } from './sources';
 *
 *   // At startup
 *   await initializeSources(projectId);
 *
 *   // Get tools for LLM
 *   const tools = getSourceManager()?.getSourceTools();
 */

// Core exports
export * from './core';

import { sourceRegistry, SourceModule, SourceType, setModuleLoader } from './core';

/**
 * Module loaders - lazy import functions for each source type
 * Modules are only imported when actually needed
 */
const moduleLoaders: Record<string, () => Promise<SourceModule>> = {
  postgres: async () => (await import('./postgres')).default,
  mysql: async () => (await import('./mysql')).default,
  mssql: async () => (await import('./mssql')).default,
  excel: async () => (await import('./excel')).default,
  csv: async () => (await import('./csv')).default,
  rest_api: async () => (await import('./rest-api')).default,
  graphql: async () => (await import('./graphql')).default,
  dynamodb: async () => (await import('./dynamodb')).default,
  redis: async () => (await import('./redis')).default,
  netsuite: async () => (await import('./netsuite')).default,
};

// Track which modules have been loaded
const loadedModules = new Set<string>();

/**
 * Load and register a module by type (lazy loading)
 */
export async function loadModule(type: string): Promise<SourceModule | null> {
  // Already loaded
  if (loadedModules.has(type)) {
    return sourceRegistry.getModule(type as SourceType);
  }

  const loader = moduleLoaders[type];
  if (!loader) {
    console.warn(`[Sources] Unknown source type: ${type}`);
    return null;
  }

  try {
    const module = await loader();
    sourceRegistry.register(module);
    loadedModules.add(type);
    console.log(`[Sources] Loaded module: ${module.name} (${type})`);
    return module;
  } catch (error) {
    console.error(`[Sources] Failed to load module for type: ${type}`, error);
    return null;
  }
}

/**
 * Load modules for the given source types
 */
export async function loadModulesForTypes(types: string[]): Promise<void> {
  const uniqueTypes = [...new Set(types)];

  for (const type of uniqueTypes) {
    await loadModule(type);
  }

  if (uniqueTypes.length > 0) {
    console.log(`[Sources] Loaded ${loadedModules.size} module(s): ${[...loadedModules].join(', ')}`);
  }
}

/**
 * Get list of available/supported source types
 */
export function getSupportedSourceTypes(): string[] {
  return Object.keys(moduleLoaders);
}

/**
 * Check if a source type is supported
 */
export function isSourceTypeSupported(type: string): boolean {
  return type in moduleLoaders;
}

// Wire up the lazy loader to SourceManager
setModuleLoader(loadModulesForTypes);

console.log(`[Sources] Available source types: ${getSupportedSourceTypes().join(', ')}`);
