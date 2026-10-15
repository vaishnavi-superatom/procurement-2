/**
 * Core Types for Multi-Source Architecture
 */

// ============================================
// Source Types
// ============================================

export type SourceType =
  | 'postgres'
  | 'mssql'
  | 'mysql'
  | 'excel'
  | 'csv'
  | 'rest_api'
  | 'graphql'
  | 'dynamodb'
  | 'redis'
  | 'netsuite';

/**
 * Schema size tier — determines how much schema detail to send to each agent.
 * Computed from entity count. Main agent detail level is further adjusted by
 * a token budget divided across all sources.
 */
export type SchemaTier = 'small' | 'medium' | 'large' | 'very_large';

// ============================================
// Source Module Interface
// ============================================

/**
 * Each source module must export this interface
 */
export interface SourceModule {
  /** Unique type identifier */
  type: SourceType;

  /** Display name */
  name: string;

  /** Description */
  description: string;

  /** Source capabilities */
  capabilities: SourceCapabilities;

  /** Create an instance of this source */
  createInstance(config: SourceConfig): SourceInstance;

  /** Validate configuration */
  validateConfig(config: any): ConfigValidationResult;

  /** Configuration fields for UI */
  configFields: ConfigField[];
}

export interface SourceCapabilities {
  /** Can execute queries (SQL, SOQL, etc.) */
  query: boolean;

  /** Can write/modify data */
  write: boolean;

  /** Can extract schema */
  schema: boolean;

  /** Supports real-time/streaming */
  realtime: boolean;

  /** Supports parameterized queries */
  parameterized: boolean;
}

// ============================================
// Source Instance Interface
// ============================================

/**
 * A configured instance of a source
 */
export interface SourceInstance {
  /** Get source ID */
  getId(): string;

  /** Get source name */
  getName(): string;

  /** Get source type */
  getType(): SourceType;

  /** Connect to the source */
  connect(): Promise<void>;

  /** Disconnect from the source */
  disconnect(): Promise<void>;

  /** Check connection health */
  healthCheck(): Promise<boolean>;

  /** Check if connected */
  isConnected(): boolean;

  /** Extract schema from the source */
  extractSchema(): Promise<SourceSchema>;

  /**
   * Optional fast (single cheap query) candidate-table count + a ready-to-show
   * status message, so a caller (e.g. project-sources.ts's extractSchema op)
   * can report "found N tables, extracting..." and run the real extractSchema()
   * in the background instead of blocking the request on it. Sources that
   * don't implement this keep the old fully-blocking extractSchema() path —
   * appropriate for dialects (Postgres/MySQL/MSSQL) whose full extraction is
   * already fast via one catalog query, vs. NetSuite's per-table probing.
   */
  estimateExtractionTime?(): Promise<{ candidateCount: number; message: string; estimatedMinutes?: number }>;

  /** Get current schema (cached) */
  getSchema(): SourceSchema | null;

  /**
   * Hot-swap a Claude-authored semantic model onto the live instance so agents
   * use the updated descriptions/summaries without a restart. The caller is
   * responsible for re-embedding the schema index afterwards.
   */
  applySemanticModel(model: SourceSchema): void;

  /**
   * Execute a query/request. `signal` is optional — a source that supports
   * real cancellation can use it to kill the underlying query; one that
   * doesn't can safely ignore the parameter, since the SourceTool.fn wrapper
   * in BaseSource.getTool() races every execute() against the signal
   * regardless, guaranteeing the caller unblocks on abort either way (see
   * base-source.ts's raceWithAbort).
   */
  execute(params: any, signal?: AbortSignal): Promise<QueryResult>;

  /** Set total source count for budget-aware schema formatting */
  setTotalSourceCount(count: number): void;

  /** Get LLM tool definition */
  getTool(): SourceTool;
}

// ============================================
// Configuration
// ============================================

/**
 * Source configuration as stored in database
 */
export interface SourceConfig {
  id: string;
  projectId: string;
  name: string;
  description?: string | null;
  type: SourceType;
  config: Record<string, any>;
  schema?: SourceSchema | null;
  // Claude-authored semantic superset (descriptions, synonyms, joins, embedText, value vocab).
  // When present the runtime prefers this over `schema` (see BaseSource constructor).
  semanticModel?: SourceSchema | null;
  isPrimary: boolean;
  isActive: boolean;
  lastSyncAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Configuration field definition for UI
 */
export interface ConfigField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea' | 'file';
  required: boolean;
  placeholder?: string;
  description?: string;
  defaultValue?: any;
  options?: { value: string; label: string }[];  // For select type
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    message?: string;
  };
}

export interface ConfigValidationResult {
  valid: boolean;
  errors?: string[];
}

// ============================================
// Schema Types
// ============================================

export interface SourceSchema {
  entities: SchemaEntity[];
  relationships?: SchemaRelationship[];
  extractedAt?: string;
  // Present only on a semantic model (the enriched superset)
  schemaFingerprint?: string;
  glossary?: Array<{ term: string; meaning: string; tables?: string[] }>;
}

/** Entity-level semantic enrichment (Claude-authored). All optional & backward-compatible. */
export interface EntitySemantic {
  summary?: string;                 // what the table means (agent reads this)
  synonyms?: string[];              // business terms users type (embedded + agent)
  embedText?: string;               // concise retrieval string (what gets embedded)
  joins?: Array<{ to: string; on: string; via?: string; purpose?: string }>;  // canonical join paths
  notes?: string;                   // data gotchas (agent reads this)
}

/** Field-level semantic enrichment. */
export interface FieldSemantic {
  summary?: string;
  synonyms?: string[];
  valueVocabulary?: string[];       // real distinct values (embedded + agent)
  unit?: string | null;
  notes?: string;
}

export interface SchemaEntity {
  name: string;
  fullName?: string;
  description?: string;
  fields: SchemaField[];
  rowCount?: number;
  primaryKey?: string[];
  semantic?: EntitySemantic;
}

export interface SchemaField {
  name: string;
  type: string;
  nativeType?: string;
  description?: string;
  nullable?: boolean;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  references?: {
    entity: string;
    field: string;
  };
  sampleValues?: any[];
  statistics?: {
    distinct?: number;
    min?: any;
    max?: any;
    avg?: number;
    nonNullCount?: number;
    cardinality?: 'unique' | 'low' | 'medium' | 'high';
    trueCount?: number;
    falseCount?: number;
  };
  semantic?: FieldSemantic;
}

export interface SchemaRelationship {
  from: string;
  to: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-many';
  fromField: string;
  toField: string;
}

// ============================================
// Query & Results
// ============================================

export interface QueryResult {
  data: any[];
  count: number;
  metadata?: {
    executionTime?: number;
    truncated?: boolean;
    totalCount?: number;
    /**
     * Restrictions an authorization policy imposed on this query before it ran,
     * each as one human-readable phrase. Present only when a policy was actually
     * APPLIED (enforce mode).
     *
     * Deliberately just strings, not a typed policy object: the consumer is an
     * LLM that must describe the restriction in its answer, and the set of
     * policy TYPES is open (row filters today; masked columns or restricted
     * tables later). Whatever a policy type can say about itself goes here, and
     * the generic wording wrapped around it lives in the source agent.
     */
    appliedPolicies?: string[];
    [key: string]: any;
  };
}

// ============================================
// Tool Definition (for LLM)
// ============================================

export interface SourceTool {
  id: string;
  name: string;
  description: string;
  /** Tool type: "source" = routed through SourceAgent (LLM generates SQL), "direct" = called directly by MainAgent */
  toolType?: 'source' | 'direct';
  /** Full untruncated schema for the source agent (all columns visible) */
  fullSchema?: string;
  /** Schema size tier for this source */
  schemaTier?: SchemaTier;
  /** Schema search function for very_large tier — searches entities by keyword */
  schemaSearchFn?: (keywords: string[]) => string;
  params: Record<string, string>;
  /** `signal` fires when the user hits Stop mid-query — see base-source.ts's getTool(). */
  fn: (input: any, signal?: AbortSignal) => Promise<QueryResult | any>;
  outputSchema?: {
    description: string;
    fields: Array<{
      name: string;
      type: string;
      description: string;
    }>;
  };
  /**
   * Cache policy for this tool's results in the SDK QueryCache.
   *
   * - `false` → never cache. Use for time-sensitive lookups (a customer's
   *   order list, inventory levels, anything that may have changed since the
   *   last call) and for write operations whose responses shouldn't be
   *   memoized. Mirrors HTTP `Cache-Control: no-store` semantics, declared
   *   server-side by the tool author.
   * - omitted → use the SDK's default TTL (10 min). Appropriate for stable
   *   reference data: catalog items, customer master, branch list.
   *
   * Honored by the SDK's data-request handler — it looks up the tool by id
   * from the registered tool list (`sdk.setTools()`) and skips both cache
   * lookup and result storage when `cache: false` is set.
   */
  cache?: false;
}
