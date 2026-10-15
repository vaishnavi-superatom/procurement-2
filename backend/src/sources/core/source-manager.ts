/**
 * Source Manager - Manages active source instances for a project
 *
 * Uses the registry to create instances from configurations
 * stored in the database.
 */

import { sourceRegistry } from './registry';
import {
  SourceInstance,
  SourceConfig,
  SourceSchema,
  SourceTool,
} from './types';
import { FederationInstance } from '../federation';
import * as sourceService from '../../../../database/postgres/src/project-data-db/project-sources';
import { ChromaManager, chromaConfig } from '../../../../database/chromadb/src/chroma-manager';
import { upsertTablesForSource, deleteTablesForSource } from '../../collections/schema-embeddings';
import { upsertSourcesForProject } from '../../collections/source-embeddings';

// Import lazy loader from parent module (will be available after module loads)
let loadModulesForTypes: ((types: string[]) => Promise<void>) | null = null;

// Set the loader function (called from index.ts to avoid circular dependency)
export function setModuleLoader(loader: (types: string[]) => Promise<void>): void {
  loadModulesForTypes = loader;
}

// Source types that federation supports
const FEDERATION_SUPPORTED_TYPES = ['postgres', 'mysql', 'excel', 'csv'];

/**
 * Append entities from a freshly extracted schema that aren't already present
 * (by name) in the semantic model, so newly discovered tables don't stay
 * invisible behind a stale model. New entries carry no description/summary —
 * they're the raw schema entity as-is — and existing entities are returned
 * unmodified so curated descriptions are never overwritten.
 */
function reconcileSemanticModel(
  model: SourceSchema,
  freshSchema: SourceSchema
): { model: SourceSchema; added: string[] } {
  const existingNames = new Set(model.entities.map(e => e.name));
  const added: string[] = [];
  const newEntities = freshSchema.entities.filter(e => {
    if (existingNames.has(e.name)) return false;
    added.push(e.name);
    return true;
  });

  if (added.length === 0) return { model, added };
  return {
    model: { ...model, entities: [...model.entities, ...newEntities] },
    added,
  };
}

export class SourceManager {
  private instances: Map<string, SourceInstance> = new Map();
  private projectId: string;
  private initialized: boolean = false;
  private onRefreshCallback: (() => void) | null = null;
  private federation: FederationInstance | null = null;

  // Extractions currently in flight, keyed by source id. refreshSchema()
  // consults this before starting a new extraction so two near-simultaneous
  // calls for the same source (e.g. a user double-clicking "re-extract", or
  // two browser tabs) share one run instead of racing two independent probes
  // against the source. In-memory only — guards duplicate runs within this
  // process, not across multiple backend replicas, since there's no
  // multi-replica deployment of this backend today.
  private schemaExtractionsInFlight: Map<string, Promise<SourceSchema>> = new Map();

  // Dedicated ChromaManagers for schema + source summary embeddings.
  // Same ChromaDB server, separate collections.
  private schemaChromaManager: ChromaManager;
  private sourceSummaryChromaManager: ChromaManager;

  constructor(projectId: string) {
    this.projectId = projectId;
    // MUST match the space used in collections/index.ts for this SAME collection.
    // Two managers pointing at one collection with different metrics wipe each
    // other in a loop: this one embeds the schema on startup, then the reader's
    // rebuildIfSpaceChanged sees the wrong metric and DELETES the whole index
    // mid-question — so every schema pre-resolution returns 0 and the agent
    // falls back to LLM search_schema on every dispatch.
    this.schemaChromaManager = new ChromaManager(undefined, chromaConfig.SCHEMA_TABLES_COLLECTION_NAME, 'cosine');
    this.sourceSummaryChromaManager = new ChromaManager(undefined, chromaConfig.SOURCE_SUMMARIES_COLLECTION_NAME);
  }

  /**
   * Set a callback to be called after a background refresh completes
   * (e.g., to refresh SDK tools)
   */
  setOnRefreshCallback(callback: () => void): void {
    this.onRefreshCallback = callback;
  }

  /**
   * Initialize all sources for the project
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log(`[SourceManager] Already initialized for project: ${this.projectId}`);
      return;
    }

    console.log(`[SourceManager] Initializing sources for project: ${this.projectId}`);

    try {
      // Load source configs from database
      const result = await sourceService.getProjectSources(this.projectId);
      const sources = result.data as SourceConfig[];

      if (sources.length === 0) {
        console.log(`[SourceManager] No sources configured for project: ${this.projectId}`);
        this.initialized = true;
        return;
      }

      console.log(`[SourceManager] Found ${sources.length} source(s) to initialize`);

      // Lazy load only the modules we need
      const sourceTypes = [...new Set(sources.filter(s => s.isActive).map(s => s.type))];
      if (loadModulesForTypes && sourceTypes.length > 0) {
        await loadModulesForTypes(sourceTypes);
      }

      // Initialize each active source
      for (const source of sources) {
        await this.initializeSource(source);
      }

      this.initialized = true;
      console.log(`[SourceManager] ✓ Initialized ${this.instances.size}/${sources.length} sources`);

      // Create federation layer if there are 2+ queryable sources
      await this.initializeFederation();

      // Embed source summaries for the MainAgent pre-filter (non-blocking)
      this.embedAllSourceSummaries().catch(err => {
        console.warn(`[SourceManager] Source summary embedding failed (non-blocking):`, err);
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[SourceManager] Initialization failed: ${errorMsg}`);
      throw new Error(`Failed to initialize sources: ${errorMsg}`);
    }
  }

  /**
   * Initialize a single source with retry logic
   */
  private async initializeSource(config: SourceConfig): Promise<void> {
    if (!config.isActive) {
      console.log(`[SourceManager] Skipping inactive source: ${config.name}`);
      return;
    }

    if (!sourceRegistry.isSupported(config.type)) {
      console.warn(`[SourceManager] Unsupported source type: ${config.type} (${config.name})`);
      return;
    }

    const maxRetries = 3;
    const baseDelay = 2000; // 2s, 4s, 8s

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const instance = sourceRegistry.createInstance(config);
        await instance.connect();
        this.instances.set(config.id, instance);

        // Wire post-refresh callback for file-based sources
        this.wirePostRefresh(config, instance);

        // Extract schema if not already cached
        if (!instance.getSchema()) {
          try {
            const schema = await instance.extractSchema();
            await sourceService.updateSourceSchema(config.id, schema);
            console.log(`[SourceManager]   ✓ ${config.name} (${config.type}) - schema extracted`);
          } catch (schemaError) {
            // Schema extraction failed, but source is still usable
            console.log(`[SourceManager]   ✓ ${config.name} (${config.type}) - schema extraction failed`);
          }
        } else {
          console.log(`[SourceManager]   ✓ ${config.name} (${config.type})`);
        }

        // Embed table metadata for the SourceAgent pre-search (non-blocking)
        this.embedSourceSchema(config, instance).catch(err => {
          console.warn(`[SourceManager] Schema embedding failed for ${config.name}:`, err);
        });

        return; // Success — exit retry loop
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.warn(`[SourceManager]   ✗ ${config.name}: ${errorMsg} (attempt ${attempt}/${maxRetries}, retrying in ${delay / 1000}s...)`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          console.error(`[SourceManager]   ✗ ${config.name}: ${errorMsg} (failed after ${maxRetries} attempts)`);
          // Continue with other sources
        }
      }
    }
  }

  /**
   * Wire post-refresh callback for file-based sources (Excel/CSV)
   * so background refreshes automatically re-extract schema and refresh tools
   */
  private wirePostRefresh(config: SourceConfig, instance: SourceInstance): void {
    if ((config.type === 'excel' || config.type === 'csv') && 'onPostRefresh' in instance) {
      (instance as any).onPostRefresh = async () => {
        try {
          const schema = await instance.extractSchema();
          await sourceService.updateSourceSchema(config.id, schema);
          console.log(`[SourceManager] Schema re-extracted after background refresh: ${config.name}`);
        } catch (err) {
          console.warn(`[SourceManager] Schema re-extraction failed after background refresh for ${config.name}:`, err);
        }

        // Reload file source data in federation
        if (this.federation) {
          try {
            await this.attachSourceToFederation(config.id, config, instance);
            console.log(`[SourceManager] Federation reloaded after refresh: ${config.name}`);
          } catch (err) {
            console.warn(`[SourceManager] Federation reload failed for ${config.name}:`, err);
          }
        }

        if (this.onRefreshCallback) {
          this.onRefreshCallback();
        }
      };
    }
  }

  // ============================================
  // Federation Layer
  // ============================================

  /**
   * Initialize the federation DuckDB instance and attach all compatible sources
   */
  private async initializeFederation(): Promise<void> {
    // Count federation-compatible sources
    const compatibleSources: Array<{ id: string; config: SourceConfig; instance: SourceInstance }> = [];
    for (const [id, instance] of this.instances) {
      const config = (instance as any).config as SourceConfig;
      if (FEDERATION_SUPPORTED_TYPES.includes(config.type)) {
        compatibleSources.push({ id, config, instance });
      }
    }

    if (compatibleSources.length < 2) {
      console.log(`[SourceManager] Federation skipped: need 2+ compatible sources, have ${compatibleSources.length}`);
      return;
    }

    try {
      this.federation = new FederationInstance();
      await this.federation.initialize();

      for (const { id, config, instance } of compatibleSources) {
        await this.attachSourceToFederation(id, config, instance);
      }

      const attached = this.federation.getAttachedSourceCount();
      console.log(`[SourceManager] ✓ Federation ready: ${attached} sources attached`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[SourceManager] Federation initialization failed: ${msg}`);
      this.federation = null;
    }
  }

  /**
   * Attach a single source to the federation layer
   */
  private async attachSourceToFederation(
    sourceId: string,
    config: SourceConfig,
    instance: SourceInstance
  ): Promise<void> {
    if (!this.federation) return;

    switch (config.type) {
      case 'postgres':
        await this.federation.attachPostgres(sourceId, config);
        break;
      case 'mysql':
        await this.federation.attachMySQL(sourceId, config);
        break;
      case 'excel':
        await this.federation.loadExcelTables(sourceId, config, instance);
        break;
      case 'csv':
        await this.federation.loadCSVTables(sourceId, config, instance);
        break;
    }
  }

  /**
   * Get the federation instance (if available)
   */
  getFederation(): FederationInstance | null {
    return this.federation;
  }

  // ============================================
  // Tool Generation
  // ============================================

  /**
   * Get all source tools for LLM.
   * Sets totalSourceCount on each instance so budget-aware schema formatting works.
   */
  getSourceTools(): SourceTool[] {
    const tools: SourceTool[] = [];
    const totalCount = this.instances.size;

    for (const instance of this.instances.values()) {
      try {
        instance.setTotalSourceCount(totalCount);
        tools.push(instance.getTool());
      } catch (error) {
        console.error(`[SourceManager] Failed to get tool for ${instance.getId()}:`, error);
      }
    }

    // Add federation tool if available (enables cross-source JOINs)
    if (this.federation && this.federation.hasAttachedSources()) {
      try {
        tools.push(this.federation.getTool());
      } catch (error) {
        console.error(`[SourceManager] Failed to get federation tool:`, error);
      }
    }

    return tools;
  }

  // ============================================
  // Instance Access
  // ============================================

  /**
   * Get instance by source ID
   */
  getInstance(sourceId: string): SourceInstance | undefined {
    return this.instances.get(sourceId);
  }

  /**
   * Get all instances
   */
  getAllInstances(): SourceInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get primary instance
   */
  getPrimaryInstance(): SourceInstance | undefined {
    // Find primary
    for (const instance of this.instances.values()) {
      const config = (instance as any).config as SourceConfig;
      if (config?.isPrimary) {
        return instance;
      }
    }

    // Return first if no primary
    return this.instances.values().next().value;
  }

  /**
   * Get instance by type (first matching)
   */
  getInstanceByType(type: string): SourceInstance | undefined {
    for (const instance of this.instances.values()) {
      if (instance.getType() === type) {
        return instance;
      }
    }
    return undefined;
  }

  // ============================================
  // Health & Maintenance
  // ============================================

  /**
   * Health check all instances
   */
  async healthCheckAll(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();

    for (const [id, instance] of this.instances) {
      try {
        results.set(id, await instance.healthCheck());
      } catch {
        results.set(id, false);
      }
    }

    return results;
  }

  /** Whether a schema extraction for this source is currently running — the authoritative status a caller (e.g. a UI) can check, since schemaExtractionsInFlight is otherwise private. */
  isSchemaExtractionInFlight(sourceId: string): boolean {
    return this.schemaExtractionsInFlight.has(sourceId);
  }

  /**
   * Refresh schema for a source. If an extraction for this source is already
   * running, returns that same in-flight promise instead of starting a
   * second one (see schemaExtractionsInFlight above).
   */
  async refreshSchema(sourceId: string): Promise<SourceSchema> {
    const instance = this.instances.get(sourceId);
    if (!instance) {
      throw new Error(`Source not found: ${sourceId}`);
    }

    const inFlight = this.schemaExtractionsInFlight.get(sourceId);
    if (inFlight) {
      console.log(`[SourceManager] Schema extraction already in progress for ${sourceId} — waiting on it instead of starting another`);
      return inFlight;
    }

    const extraction = this.runSchemaRefresh(sourceId, instance).finally(() => {
      this.schemaExtractionsInFlight.delete(sourceId);
    });
    this.schemaExtractionsInFlight.set(sourceId, extraction);
    return extraction;
  }

  /** Does the actual extraction + persistence work; refreshSchema() wraps this with in-flight dedup. */
  private async runSchemaRefresh(sourceId: string, instance: SourceInstance): Promise<SourceSchema> {
    const schema = await instance.extractSchema();
    await sourceService.updateSourceSchema(sourceId, schema);

    // getSchema() prefers the semantic model over the raw schema whenever one
    // is present (see base-source.ts), so a table newly discovered here would
    // otherwise stay invisible to the Data Viewer / schema search / embeddings
    // until someone manually regenerates the whole semantic model. Reconcile
    // additively instead: append bare (undescribed) entries for genuinely new
    // tables, and leave existing curated entities untouched. Tables that
    // disappeared from this extraction are NOT removed — that's left for a
    // deliberate semantic-model regeneration, since a transient probe failure
    // shouldn't silently delete a curated entity.
    const config = (instance as any).config as SourceConfig;
    if (config?.semanticModel?.entities?.length) {
      const { model: reconciled, added } = reconcileSemanticModel(config.semanticModel, schema);
      if (added.length > 0) {
        await sourceService.updateSourceSemanticModel(sourceId, reconciled);
        instance.applySemanticModel(reconciled);
        console.log(`[SourceManager] Semantic model reconciled for ${config.name}: +${added.length} new table(s) added (${added.join(', ')})`);
      }
    }

    // Re-embed tables for the updated schema (non-blocking)
    if (config) {
      this.embedSourceSchema(config, instance).catch(err => {
        console.warn(`[SourceManager] Schema re-embed failed for ${config.name}:`, err);
      });
    }

    return schema;
  }

  /**
   * Refresh all schemas
   */
  async refreshAllSchemas(): Promise<Map<string, SourceSchema>> {
    const results = new Map<string, SourceSchema>();

    for (const [id, instance] of this.instances) {
      try {
        results.set(id, await this.refreshSchema(id));
        console.log(`[SourceManager] Refreshed schema: ${instance.getName()}`);
      } catch (error) {
        console.error(`[SourceManager] Failed to refresh schema for ${id}:`, error);
      }
    }

    // Re-embed source summaries so tableCount reflects the fresh schemas (non-blocking)
    this.embedAllSourceSummaries().catch(err => {
      console.warn(`[SourceManager] Source summary re-embed failed after refreshAllSchemas:`, err);
    });

    return results;
  }

  // ============================================
  // Dynamic Management
  // ============================================

  /**
   * Add a source at runtime
   */
  async addSource(config: SourceConfig, instance?: SourceInstance): Promise<SourceInstance> {
    if (this.instances.has(config.id)) {
      throw new Error(`Source already exists: ${config.id}`);
    }

    // Adopt a pre-connected instance when the caller already built one (e.g. the
    // create handler's connection test) to skip a second connect() — for
    // Excel/CSV that would otherwise load the whole file into DuckDB twice.
    if (!instance) {
      instance = sourceRegistry.createInstance(config);
      await instance.connect();
    }
    this.instances.set(config.id, instance);

    // Wire post-refresh callback for file-based sources
    this.wirePostRefresh(config, instance);

    // Attach to federation if compatible
    if (this.federation && FEDERATION_SUPPORTED_TYPES.includes(config.type)) {
      await this.attachSourceToFederation(config.id, config, instance);
    } else if (!this.federation && this.instances.size >= 2) {
      // First time we have 2+ sources — initialize federation
      await this.initializeFederation();
    }

    console.log(`[SourceManager] Added source: ${config.name}`);

    // Embed table metadata for the new source + refresh source summaries (non-blocking)
    this.embedSourceSchema(config, instance).catch(err => {
      console.warn(`[SourceManager] Schema embedding failed for ${config.name}:`, err);
    });
    this.embedAllSourceSummaries().catch(err => {
      console.warn(`[SourceManager] Source summary re-embed failed:`, err);
    });

    return instance;
  }

  /**
   * Remove a source at runtime
   */
  async removeSource(sourceId: string): Promise<void> {
    const instance = this.instances.get(sourceId);
    if (!instance) return;

    // Detach from federation first
    if (this.federation) {
      await this.federation.detachSource(sourceId);
    }

    await instance.disconnect();
    this.instances.delete(sourceId);

    // Remove schema embeddings (stored under config.id = sourceId) and refresh
    // source summaries — both non-blocking.
    deleteTablesForSource(this.schemaChromaManager, sourceId).catch(err => {
      console.warn(`[SourceManager] Delete schema embeddings failed for ${sourceId}:`, err);
    });
    this.embedAllSourceSummaries().catch(err => {
      console.warn(`[SourceManager] Source summary re-embed failed:`, err);
    });

    console.log(`[SourceManager] Removed source: ${sourceId}`);
  }

  /**
   * Reload a source (disconnect and reconnect)
   */
  async reloadSource(sourceId: string): Promise<void> {
    const instance = this.instances.get(sourceId);
    if (!instance) {
      throw new Error(`Source not found: ${sourceId}`);
    }

    await instance.disconnect();
    await instance.connect();

    console.log(`[SourceManager] Reloaded source: ${instance.getName()}`);
  }

  // ============================================
  // Embedding Hooks (Schema + Source Summary)
  // ============================================

  /**
   * Build per-table embeddings for a source so the MainAgent can pre-resolve
   * relevant tables via vector search (skipping SourceAgent's search_schema iterations).
   * Non-blocking — failures are logged and don't affect the source.
   */
  private async embedSourceSchema(config: SourceConfig, instance: SourceInstance, force = false): Promise<void> {
    const schema = instance.getSchema();
    if (!schema || !schema.entities || schema.entities.length === 0) return;

    // Exclude non-queryable junk from the pre-resolution index so it can't crowd out
    // the real tables: dated backup snapshots (_2024_09_11 / _20240814), report caches
    // (rpt_*), audit/activity logs (*_log, *_log1), demo/email scratch, replication.
    const JUNK_RX = /(_\d{4}[_-]?\d{2}[_-]?\d{2})$|(_\d{8})$|^rpt_|^demo_|^email_|(_log\d*$)|reportgen|user_activity|msreplication|msmerge|sysmerge|(_bkp|_backup|_old|_tmp|_temp|_copy)$/i;

    const tables = schema.entities.filter(e => !JUNK_RX.test(e.name)).map(e => ({
      fullName: e.fullName || e.name,
      rowCount: e.rowCount,
      description: e.description,
      // Carry entity-level semantics so the embedder can use embedText/synonyms.
      // notes travels separately as metadata (not embedded) — see buildTableDescription.
      semantic: e.semantic ? { summary: e.semantic.summary, synonyms: e.semantic.synonyms, embedText: e.semantic.embedText, notes: e.semantic.notes } : undefined,
      // Columns with a curated description (from a vetted kb-node/entity_map/concepts
      // rule) go first, before the 40-column cap — so a documented column past position
      // 40 in the raw field order (e.g. job.custentity9 on a 264-column table) still
      // reaches the embedder instead of being silently cut. Stable sort otherwise.
      columns: [...e.fields]
        .sort((a, b) => (b.description ? 1 : 0) - (a.description ? 1 : 0))
        .slice(0, 40)
        .map(f => ({
          name: f.name,
          type: f.type,
          isPrimaryKey: f.isPrimaryKey,
          isForeignKey: f.isForeignKey,
          sampleValues: f.sampleValues,
          valueVocabulary: f.semantic?.valueVocabulary,
          description: f.description,
        })),
    }));

    // Use the real source ID (config.id) — not the tool ID.
    // Tool ID = `${config.id}_query` but sourceId is semantically the source itself.
    // MainAgent strips the _query suffix before calling schema-embeddings.search.
    await upsertTablesForSource(this.schemaChromaManager, {
      projectId: this.projectId,
      sourceId: config.id,
      sourceType: config.type,
      sourceName: config.name,
      tables,
      force,
    });
  }

  /**
   * Re-embed a source's schema from its CURRENT in-memory schema (which prefers the
   * semantic model), forcing past the fingerprint freshness guard. Called by
   * applySemanticModel after the semantic model is ingested + hot-swapped onto the instance.
   */
  async reembedSource(sourceId: string): Promise<void> {
    const instance = this.instances.get(sourceId);
    if (!instance) throw new Error(`Source '${sourceId}' not registered`);
    const config = (instance as any).config as SourceConfig;
    await this.embedSourceSchema(config, instance, true);
  }

  /**
   * Build one embedding per source (summary + entity names + columns) so the
   * agent flow can narrow the MainAgent's prompt to top-K relevant sources.
   * Non-blocking.
   */
  private async embedAllSourceSummaries(): Promise<void> {
    const sources = Array.from(this.instances.values()).map(instance => {
      const tool = instance.getTool();
      const schema = instance.getSchema();
      const tableCount = schema?.entities.length || 0;
      const description = (tool.description || '').trim();
      // Pack: "Name (Type) — description. Contains entity names from schema."
      // Keep ~300 tokens so MiniLM embedding is dense and cheap.
      const topEntities = (schema?.entities || []).slice(0, 30).map(e => {
        const cols = e.fields.slice(0, 6).map(f => f.name).join(', ');
        return `${e.fullName || e.name}${cols ? ` [${cols}]` : ''}`;
      }).join('; ');
      const summaryText = [
        `${instance.getName()} (${instance.getType()})`,
        description.slice(0, 800),
        topEntities ? `Contains: ${topEntities}` : '',
      ].filter(Boolean).join(' — ');

      return {
        sourceId: tool.id, // use tool.id so it matches agentTools[].id on the SDK side
        sourceType: instance.getType(),
        sourceName: instance.getName(),
        toolType: (tool as any).toolType || 'source',
        tableCount,
        summaryText,
      };
    });

    await upsertSourcesForProject(this.sourceSummaryChromaManager, {
      projectId: this.projectId,
      sources,
    });
  }

  // ============================================
  // Lifecycle
  // ============================================

  /**
   * Shutdown all sources
   */
  async shutdown(): Promise<void> {
    console.log(`[SourceManager] Shutting down ${this.instances.size} sources...`);

    // Shutdown federation first
    if (this.federation) {
      try {
        await this.federation.shutdown();
      } catch (error) {
        console.error(`[SourceManager] Error shutting down federation:`, error);
      }
      this.federation = null;
    }

    for (const [id, instance] of this.instances) {
      try {
        await instance.disconnect();
      } catch (error) {
        console.error(`[SourceManager] Error disconnecting ${id}:`, error);
      }
    }

    this.instances.clear();
    this.initialized = false;
    console.log(`[SourceManager] Shutdown complete`);
  }

  // ============================================
  // Status
  // ============================================

  getSourceCount(): number {
    return this.instances.size;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getProjectId(): string {
    return this.projectId;
  }

  /**
   * Get status summary
   */
  getStatus(): {
    projectId: string;
    initialized: boolean;
    sourceCount: number;
    sources: Array<{ id: string; name: string; type: string; connected: boolean }>;
  } {
    return {
      projectId: this.projectId,
      initialized: this.initialized,
      sourceCount: this.instances.size,
      sources: Array.from(this.instances.values()).map(i => ({
        id: i.getId(),
        name: i.getName(),
        type: i.getType(),
        connected: i.isConnected(),
      })),
    };
  }
}

// ============================================
// Global Instance Management
// ============================================

let currentManager: SourceManager | null = null;

/**
 * Initialize sources for a project
 */
export async function initializeSources(projectId: string): Promise<SourceManager> {
  if (currentManager && currentManager.getProjectId() !== projectId) {
    await currentManager.shutdown();
    currentManager = null;
  }

  if (!currentManager) {
    currentManager = new SourceManager(projectId);
    await currentManager.initialize();
  }

  return currentManager;
}

/**
 * Get the current source manager
 */
export function getSourceManager(): SourceManager | null {
  return currentManager;
}

/**
 * Shutdown current manager
 */
export async function shutdownSources(): Promise<void> {
  if (currentManager) {
    await currentManager.shutdown();
    currentManager = null;
  }
}
