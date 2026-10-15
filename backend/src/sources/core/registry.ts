/**
 * Source Registry - Central registry for source modules
 *
 * Modules register themselves here, and the SourceManager uses
 * this registry to create instances.
 */

import {
  SourceModule,
  SourceType,
  SourceConfig,
  SourceInstance,
  ConfigField,
} from './types';

class SourceRegistry {
  private modules: Map<SourceType, SourceModule> = new Map();

  /**
   * Register a source module
   */
  register(module: SourceModule): void {
    if (this.modules.has(module.type)) {
      console.warn(`[SourceRegistry] Overwriting existing module: ${module.type}`);
    }
    this.modules.set(module.type, module);
    console.log(`[SourceRegistry] Registered module: ${module.name} (${module.type})`);
  }

  /**
   * Get a registered module by type
   */
  getModule(type: SourceType): SourceModule | undefined {
    return this.modules.get(type);
  }

  /**
   * Get all registered modules
   */
  getAllModules(): SourceModule[] {
    return Array.from(this.modules.values());
  }

  /**
   * Get all supported source types
   */
  getSupportedTypes(): SourceType[] {
    return Array.from(this.modules.keys());
  }

  /**
   * Check if a source type is supported
   */
  isSupported(type: string): boolean {
    return this.modules.has(type as SourceType);
  }

  /**
   * Create an instance of a source
   */
  createInstance(config: SourceConfig): SourceInstance {
    const module = this.modules.get(config.type);
    if (!module) {
      throw new Error(`Unsupported source type: ${config.type}. Supported types: ${this.getSupportedTypes().join(', ')}`);
    }
    return module.createInstance(config);
  }

  /**
   * Validate configuration for a source type
   */
  validateConfig(type: SourceType, config: any): { valid: boolean; errors?: string[] } {
    const module = this.modules.get(type);
    if (!module) {
      return { valid: false, errors: [`Unknown source type: ${type}`] };
    }
    return module.validateConfig(config);
  }

  /**
   * Get configuration fields for a source type (for UI)
   */
  getConfigFields(type: SourceType): ConfigField[] {
    const module = this.modules.get(type);
    return module?.configFields || [];
  }

  /**
   * Get module info for all registered modules (for UI)
   */
  getModulesInfo(): Array<{
    type: SourceType;
    name: string;
    description: string;
    capabilities: SourceModule['capabilities'];
    configFields: ConfigField[];
  }> {
    return this.getAllModules().map(m => ({
      type: m.type,
      name: m.name,
      description: m.description,
      capabilities: m.capabilities,
      configFields: m.configFields,
    }));
  }

  /**
   * Get count of registered modules
   */
  getModuleCount(): number {
    return this.modules.size;
  }
}

// Singleton instance
export const sourceRegistry = new SourceRegistry();
