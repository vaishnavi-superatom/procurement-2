/**
 * Base Source - Abstract base class for source instances
 *
 * Provides common functionality that source modules can extend.
 * Implements tiered schema strategy for multi-agent system:
 * - Entity importance scoring (FK connections + row count)
 * - Budget-aware schema formatting for main agent
 * - Tier-aware full schema for source agent
 * - Schema search for large sources (200+ tables)
 *
 * Key principle: NEVER hide information from the LLM without telling it.
 * Every truncation point explicitly states what's shown vs what's available.
 */

import {
  SourceInstance,
  SourceConfig,
  SourceSchema,
  SourceType,
  QueryResult,
  SourceTool,
  SchemaEntity,
  SchemaTier,
} from './types';
import { WriteMode, assertSqlAllowed } from './sql-guard';
import { AsyncLocalStorage } from 'async_hooks';
import { rewriteSql } from './sql-rewrite';
import { resolvePolicies, describeScope } from './policy-gate';

/**
 * Carries the restrictions an authorization policy actually imposed on a query
 * back out to the tool wrapper, so the agent can be TOLD its result is limited.
 *
 * Without this the enforcement is invisible to the model: it wrote a query with
 * no branch filter, got a branch-scoped count back, and labelled the answer
 * "across all branches". Confirmed live — the number was right and every label
 * on it was wrong. It also wasted a turn trying to remove a restriction it
 * cannot remove.
 *
 * Per tool.fn call rather than per instance: source instances are long-lived
 * singletons shared across concurrent requests, so anything stored on `this`
 * would leak one user's scope into another's result.
 */
const queryScopeStore = new AsyncLocalStorage<{ applied?: string[] }>();

/**
 * Race a query promise against an abort signal — the uniform abort
 * guarantee every source's tool.fn wraps its execute() call in (see
 * BaseSource.getTool() below and FederationInstance.getTool(), the two
 * places SourceTool.fn is built).
 *
 * Without this, hitting Stop while a query is mid-flight only tears down
 * the LLM/agent session; the source's execute() promise (e.g. a 5-minute
 * db-bridge WebSocket round-trip) is awaited to completion regardless, so
 * the caller (chat's SourceAgent, dashboard-agent's query tool) — and
 * anything waiting on it, including the frontend's "running" state — stays
 * stuck until that orphaned query finishes on its own.
 *
 * `run(signal)` still receives the signal so a source that CAN cancel for
 * real (e.g. MSSQL via node-mssql's Request.cancel()) may use it — this
 * wrapper is the guaranteed floor, not a replacement for real cancellation.
 * Today no source does real cancellation yet; this only guarantees the
 * caller stops waiting, not that the query stops running server-side.
 */
export async function raceWithAbort<T>(run: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return run();
  if (signal.aborted) {
    throw new Error('Query aborted by user before it started');
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new Error('Query aborted by user'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    run(signal).then(
      (result) => {
        if (settled) return; // already rejected on abort — drop the late result
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

// Stop words excluded from keyword index extraction
const TABLE_NAME_STOP_WORDS = [
  'tbl', 'table', 'info', 'data', 'list', 'tmp', 'temp', 'bak', 'backup',
  'old', 'new', 'test', 'dbo', 'main', 'detail', 'details', 'master',
];

// Total token budget for all source summaries in the main agent prompt
const MAIN_AGENT_TOTAL_SCHEMA_BUDGET = 15000;

// How many top-scored tables to show in detail (with all columns + stats)
const SOURCE_AGENT_DETAILED_TABLES = 10;
// medium tier now also gets search_schema (see hasSearchSchema in getTool()),
// so it doesn't need as large an upfront dump — cap it lower than large/very_large.
const SOURCE_AGENT_DETAILED_TABLES_MEDIUM = 20;
const MAIN_AGENT_MAX_DETAILED_TABLES = 20;

// Max characters for a single rendered sample/vocab value. Long values (JSON blobs
// like wifi/cell arrays) show their SHAPE, not full content — a big cost win, since
// the schema is re-sent on every source-agent iteration. Short values (enums, ids)
// are unaffected.
const MAX_SAMPLE_VALUE_CHARS = 80;

/**
 * Merges a fresh raw schema with the semantic model's per-entity/per-field
 * description/semantic fields, matched by name. Existence — which entities
 * and fields exist at all — always comes from `schema` (the current
 * extraction); the semantic model only contributes description/semantic
 * data where a name match is found. An entity/field no longer in `schema`
 * is simply not merged in — nothing is deleted from the persisted semantic
 * model itself, it's just not part of this instance's live view, so a
 * dropped/renamed table can't keep surfacing in prompts or search forever.
 */
function mergeSchemaWithSemanticOverlay(schema: SourceSchema, semanticModel: SourceSchema | null): SourceSchema {
  if (!semanticModel?.entities?.length) return schema;

  const overlayByEntityName = new Map(semanticModel.entities.map(e => [e.name, e]));

  const entities = schema.entities.map(entity => {
    const overlay = overlayByEntityName.get(entity.name);
    if (!overlay) return entity;

    const overlayByFieldName = new Map((overlay.fields || []).map(f => [f.name, f]));
    const fields = entity.fields.map(field => {
      const fieldOverlay = overlayByFieldName.get(field.name);
      if (!fieldOverlay) return field;
      return {
        ...field,
        description: fieldOverlay.description ?? field.description,
        semantic: fieldOverlay.semantic ?? field.semantic,
      };
    });

    return {
      ...entity,
      fields,
      description: overlay.description ?? entity.description,
      semantic: overlay.semantic ?? entity.semantic,
    };
  });

  return {
    ...schema,
    entities,
    relationships: semanticModel.relationships ?? schema.relationships,
    schemaFingerprint: semanticModel.schemaFingerprint,
    glossary: semanticModel.glossary,
  };
}

export abstract class BaseSource implements SourceInstance {
  protected config: SourceConfig;
  protected schema: SourceSchema | null = null;
  // Last genuinely-raw extracted schema (existence source of truth) — separate from `schema`, which
  // is always the computed raw+semantic-overlay merge. See recomputeSchema().
  private rawSchema: SourceSchema | null = null;
  protected connected: boolean = false;

  // Cache sorted entities to avoid recomputing per request
  private _sortedEntities: SchemaEntity[] | null = null;
  private _schemaTier: SchemaTier | null = null;
  private _totalSourceCount: number = 1;

  constructor(config: SourceConfig) {
    this.config = config;
    this.rawSchema = config.schema || null;
    this.recomputeSchema();
  }

  // ============================================
  // Getters
  // ============================================

  getId(): string {
    return this.config.id;
  }

  getName(): string {
    return this.config.name;
  }

  getType(): SourceType {
    return this.config.type;
  }

  /**
   * Write policy for this source, read ONLY from the trusted server-side
   * connection config jsonb (`config.config.writeMode`). Defaults to 'read'.
   * Consumed by the SQL guard so the LLM agent flow stays read-only while a
   * separate trusted flow can be granted 'dml' (row CRUD) or 'full' (incl. DDL)
   * per project/source. Never derive this from anything in the request payload.
   */
  getWriteMode(): WriteMode {
    const mode = (this.config.config as Record<string, any> | undefined)?.writeMode;
    return mode === 'dml' || mode === 'full' ? mode : 'read';
  }

  /**
   * The authorization seam: everything a source is about to execute passes
   * through here.
   *
   * Two layers, in order. The regex guard (`assertSqlAllowed`) is the cheap
   * in-process check and stays as the degraded mode. The AST rewriter then
   * parses the statement, gates it structurally, injects the caller's access
   * policies as predicates, and re-renders it — so what runs is our output,
   * not the agent's input. See backend/docs/SQL-AUTHORIZATION-DESIGN.md.
   *
   * Placed on `execute()`'s path rather than on the tool wrapper deliberately:
   * `execute()` is called directly from reports, alerts, the source proxy and
   * project-sources sampling, none of which go through `getTool().fn`.
   *
   * Policies come from the request context — see policy-gate.ts for what a
   * MISSING context means (it is not the same as "no restrictions"). They are
   * empty for everyone until Phase 2 populates them from a verified identity,
   * so today this still changes nothing about which rows come back.
   */
  protected async prepareSql(
    sql: string,
    opts?: { maxRows?: number; forceReadOnly?: boolean },
  ): Promise<string> {
    const mode: WriteMode = opts?.forceReadOnly ? 'read' : this.getWriteMode();
    assertSqlAllowed(sql, mode, this.getName());

    // Throws when enforcement is on and nobody established a context — better
    // a loud failure than a query nobody can attribute. Scoped by source id, not
    // name: a filter for one database must never reach another's SQL.
    const { policies, readableTables } = resolvePolicies(this.getId(), this.getName());

    const outcome = await rewriteSql(sql, {
      sourceType: this.getType(),
      sourceName: this.getName(),
      maxRows: opts?.maxRows,
      allowWrites: mode !== 'read',
      policies,
      readableTables,
    });

    // Tell the caller what was injected. `applied` is only populated when the
    // rewrite is actually EXECUTED (enforce) — in shadow nothing is applied, so
    // there is correctly nothing to report.
    if (outcome.applied?.length) {
      const frame = queryScopeStore.getStore();
      if (frame) frame.applied = describeScope(policies, outcome.applied);
    }

    return outcome.sql;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSchema(): SourceSchema | null {
    return this.schema;
  }

  /**
   * Hot-swap a Claude-authored semantic model onto this live instance so the
   * agent uses the updated descriptions/summaries/synonyms without a restart,
   * merged onto the current raw schema (see recomputeSchema()) rather than
   * replacing it outright. Callers should re-embed the schema index
   * afterwards (SourceManager.reembedSource).
   */
  applySemanticModel(model: SourceSchema): void {
    this.config.semanticModel = model;
    this.recomputeSchema();
  }

  getConfig(): SourceConfig {
    return this.config;
  }

  /**
   * Set total source count (called by SourceManager before getTool()).
   * Used by formatSchemaForMainAgent() to compute per-source token budget.
   */
  setTotalSourceCount(count: number): void {
    this._totalSourceCount = count;
  }

  // ============================================
  // Abstract methods (must implement)
  // ============================================

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract healthCheck(): Promise<boolean>;
  abstract extractSchema(): Promise<SourceSchema>;
  abstract execute(params: any, signal?: AbortSignal): Promise<QueryResult>;

  // ============================================
  // Tool generation (can override)
  // ============================================

  /**
   * Generate LLM tool definition.
   * large and very_large tiers get search_schema tool.
   */
  getTool(): SourceTool {
    const tier = this.determineSchemaTier();
    // medium is included here too: a "medium" table *count* (51-200) can still
    // be wide/dense enough (many columns, long descriptions) that the top-N
    // detailed dump doesn't cover everything — search_schema lets the agent
    // look up anything not shown in detail instead of guessing/failing.
    const hasSearchSchema = tier === 'medium' || tier === 'large' || tier === 'very_large';
    return {
      id: this.getToolId(),
      name: this.getToolName(),
      description: this.buildToolDescription(),
      toolType: 'source',
      fullSchema: this.buildFullSchemaDescription(),
      schemaTier: tier,
      schemaSearchFn: hasSearchSchema
        ? (keywords: string[]) => this.searchSchema(keywords)
        : undefined,
      params: this.getToolParams(),
      fn: async (input: any, signal?: AbortSignal) => {
        const scope: { applied?: string[] } = {};
        const result = await queryScopeStore.run(scope, () =>
          raceWithAbort((s) => this.execute(input, s), signal));
        if (scope.applied?.length) {
          result.metadata = { ...result.metadata, appliedPolicies: scope.applied };
        }
        // Post-execution safety net: truncate results if LLM didn't include row limit in SQL
        const maxRows = input.limit != null ? input.limit : 500; // Default safety cap
        if (result.data && result.data.length > maxRows) {
          const totalCount = result.data.length;
          result.data = result.data.slice(0, maxRows);
          result.count = result.data.length;
          result.metadata = {
            ...result.metadata,
            truncated: true,
            totalCount,
          };
        }
        return result;
      },
      outputSchema: this.getToolOutputSchema(),
    };
  }

  /**
   * Tool ID (override if needed)
   */
  protected getToolId(): string {
    return `${this.config.id}_query`;
  }

  /**
   * Tool name (override if needed)
   */
  protected getToolName(): string {
    return `Query ${this.config.name}`;
  }

  /**
   * Build tool description for LLM (main agent sees this for routing).
   * Uses formatSchemaForMainAgent() for the schema section.
   */
  protected abstract buildToolDescription(): string;

  /**
   * Build full schema description for the source agent.
   * Uses buildToolDescriptionWithSchema() to avoid fragile string replacement.
   */
  protected buildFullSchemaDescription(): string {
    return this.buildToolDescriptionWithSchema(this.formatFullSchemaForLLM());
  }

  /**
   * Build tool description with a specific schema string.
   * Subclasses override buildToolDescription() which calls formatSchemaForMainAgent().
   * This method allows substituting a different schema (for source agent).
   * Default implementation does string replacement; subclasses can override for safety.
   */
  protected buildToolDescriptionWithSchema(schema: string): string {
    const mainSchema = this.formatSchemaForMainAgent();
    const description = this.buildToolDescription();
    // String.replace with string argument treats it as literal (no regex issues).
    // If mainSchema is not found (edge case), fall back to appending.
    if (description.includes(mainSchema)) {
      return description.replace(mainSchema, schema);
    }
    // Fallback: append source schema after the description
    return `${description}\n\n${schema}`;
  }

  /**
   * Get tool parameters
   */
  protected abstract getToolParams(): Record<string, string>;

  /**
   * Get tool output schema
   */
  protected abstract getToolOutputSchema(): SourceTool['outputSchema'];

  // ============================================
  // Schema Tiering
  // ============================================

  /**
   * Determine schema tier based on entity count.
   */
  protected determineSchemaTier(): SchemaTier {
    if (this._schemaTier) return this._schemaTier;

    const count = this.schema?.entities.length || 0;
    let tier: SchemaTier;
    if (count <= 50) tier = 'small';
    else if (count <= 200) tier = 'medium';
    else if (count <= 500) tier = 'large';
    else tier = 'very_large';

    this._schemaTier = tier;
    return tier;
  }

  // ============================================
  // Entity Importance Scoring
  // ============================================

  /**
   * Compute importance score for an entity.
   * Higher score = more central/important table.
   *
   * Score = (inbound FK refs × 3) + (outbound FKs × 1) + log10(rows+1) + min(cols/10, 3)
   */
  protected computeEntityScore(entity: SchemaEntity): number {
    let score = 0;

    // Inbound FK references (how many other tables point to this one)
    const inboundFKs = this.schema?.relationships?.filter(
      r => r.to === entity.name || r.to === entity.fullName
    ).length || 0;
    score += inboundFKs * 3;

    // Outbound FK references (this table joins to others)
    const outboundFKs = entity.fields.filter(f => f.isForeignKey).length;
    score += outboundFKs * 1;

    // Row count (log scale, clamped to non-negative)
    const rowCount = Math.max(0, entity.rowCount || 0);
    score += Math.log10(rowCount + 1);

    // Column count (wider tables = more data, capped)
    score += Math.min(entity.fields.length / 10, 3);

    return score;
  }

  /**
   * Get all entities sorted by importance score (descending).
   * Cached after first call — invalidated when schema changes.
   */
  protected getSortedEntities(): SchemaEntity[] {
    if (this._sortedEntities) return this._sortedEntities;
    if (!this.schema || !this.schema.entities.length) return [];

    this._sortedEntities = [...this.schema.entities].sort(
      (a, b) => this.computeEntityScore(b) - this.computeEntityScore(a)
    );
    return this._sortedEntities;
  }

  // ============================================
  // Schema Format: Full Detail
  // ============================================

  /**
   * Schema formatter — full detail with stats, samples, cardinality.
   * Used directly by small-tier sources and as building block for other formats.
   */
  protected formatSchemaForLLM(maxEntities = 20, maxFieldsPerEntity = 15): string {
    if (!this.schema || !this.schema.entities.length) {
      return 'Schema not available. Run schema extraction first.';
    }

    // Use scored sorting instead of arbitrary order
    const sorted = this.getSortedEntities();
    const entities = sorted.slice(0, maxEntities);
    const total = this.schema.entities.length;
    const lines: string[] = [];

    for (const entity of entities) {
      lines.push(this.formatEntityForLLM(entity, maxFieldsPerEntity, true));
    }

    if (total > maxEntities) {
      lines.push(`[Showing ${entities.length} of ${total} tables in detail above. Remaining ${total - entities.length} tables listed in the catalog below.]`);
    }

    return lines.join('\n');
  }

  /**
   * Format a single entity for LLM consumption.
   * @param entity - The entity to format
   * @param maxFields - Max fields to show (Infinity for all)
   * @param includeStats - Whether to include statistics, samples, cardinality
   */

  /**
   * Detect date/datetime format from sample values of TEXT columns.
   * Returns a strptime format string if a consistent pattern is found, null otherwise.
   */
  private detectDateFormat(sampleValues: any[]): { strptime: string; display: string } | null {
    if (!sampleValues || sampleValues.length === 0) return null;

    // Patterns ordered from most specific (datetime) to least specific (date-only).
    // More specific patterns are checked first so "DD-MM-YYYY HH:MM:SS" matches
    // before "DD-MM-YYYY". Case-insensitive month abbreviations handled via [A-Za-z].
    const patterns: { regex: RegExp; strptime: string; display: string }[] = [
      // Datetime formats (check before date-only to avoid partial matches)
      { regex: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}$/, strptime: '%Y-%m-%d %H:%M:%S', display: 'YYYY-MM-DD HH:MM:SS' },
      { regex: /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/, strptime: '%d-%m-%Y %H:%M:%S', display: 'DD-MM-YYYY HH:MM:SS' },
      { regex: /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/, strptime: '%d/%m/%Y %H:%M:%S', display: 'DD/MM/YYYY HH:MM:SS' },
      { regex: /^\d{1,2}\/\d{1,2}\/\d{4} \d{2}:\d{2}:\d{2}$/, strptime: '%d/%m/%Y %H:%M:%S', display: 'D/M/YYYY HH:MM:SS' },
      { regex: /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/, strptime: '%d.%m.%Y %H:%M:%S', display: 'DD.MM.YYYY HH:MM:SS' },

      // Date with month name
      { regex: /^\d{1,2} [A-Za-z]{3} \d{4}$/, strptime: '%d %b %Y', display: 'DD Mon YYYY' },
      { regex: /^\d{1,2}-[A-Za-z]{3}-\d{4}$/, strptime: '%d-%b-%Y', display: 'DD-Mon-YYYY' },
      { regex: /^[A-Za-z]{3} \d{1,2}, \d{4}$/, strptime: '%b %d, %Y', display: 'Mon DD, YYYY' },

      // Date-only (strict 2-digit day/month first, then flexible)
      { regex: /^\d{2}-\d{2}-\d{4}$/, strptime: '%d-%m-%Y', display: 'DD-MM-YYYY' },
      { regex: /^\d{2}\/\d{2}\/\d{4}$/, strptime: '%d/%m/%Y', display: 'DD/MM/YYYY' },
      { regex: /^\d{2}\.\d{2}\.\d{4}$/, strptime: '%d.%m.%Y', display: 'DD.MM.YYYY' },
      { regex: /^\d{1,2}\/\d{1,2}\/\d{4}$/, strptime: '%d/%m/%Y', display: 'D/M/YYYY' },
      { regex: /^\d{4}-\d{2}-\d{2}$/, strptime: '%Y-%m-%d', display: 'YYYY-MM-DD' },
      { regex: /^\d{4}\/\d{2}\/\d{2}$/, strptime: '%Y/%m/%d', display: 'YYYY/MM/DD' },

      // Time-only
      { regex: /^\d{2}:\d{2}$/, strptime: '%H:%M', display: 'HH:MM' },
      { regex: /^\d{2}:\d{2}:\d{2}$/, strptime: '%H:%M:%S', display: 'HH:MM:SS' },
    ];

    const nonEmpty = sampleValues.filter(v => v != null && String(v).trim() !== '');
    if (nonEmpty.length === 0) return null;

    for (const pattern of patterns) {
      const matchCount = nonEmpty.filter(v => pattern.regex.test(String(v).trim())).length;
      // At least 80% match to account for minor data quality issues
      if (matchCount >= nonEmpty.length * 0.8) {
        return { strptime: pattern.strptime, display: pattern.display };
      }
    }
    return null;
  }

  protected formatEntityForLLM(entity: SchemaEntity, maxFields: number, includeStats: boolean): string {
    // Double-underscore-prefixed columns are internal bookkeeping (e.g. __source,
    // an audit reference back to which upload a row came from) — never surfaced
    // to the LLM, so it never tries to select/filter on them.
    const visibleFields = entity.fields.filter(f => !f.name.startsWith('__'));
    // Columns with a curated description (written from a vetted kb-node/entity_map/
    // concepts rule — see semantic-model.json) go first, so a documented column never
    // gets cut by maxFields just because of where it happens to sit in the raw column
    // order. Stable sort — undescribed columns keep their original relative order.
    const prioritized = [...visibleFields].sort((a, b) => (b.description ? 1 : 0) - (a.description ? 1 : 0));
    const fieldDetails = prioritized
      .slice(0, maxFields)
      .map(f => {
        let fieldStr = f.name;

        // Add type — for TEXT columns with date-like sample values, annotate with detected format
        let detectedDateFormat: { strptime: string; display: string } | null = null;
        if (f.type === 'TEXT' && f.sampleValues && f.sampleValues.length > 0) {
          detectedDateFormat = this.detectDateFormat(f.sampleValues);
        }
        if (detectedDateFormat) {
          fieldStr += `(TEXT, date format: '${detectedDateFormat.strptime}')`;
        } else {
          fieldStr += `(${f.type})`;
        }

        // Mark primary/foreign keys
        if (f.isPrimaryKey) {
          fieldStr += '[PK]';
        } else if (f.isForeignKey && f.references) {
          fieldStr += `[FK→${f.references.entity}]`;
        }

        if (includeStats) {
          const cardinality = (f as any).cardinality || f.statistics?.cardinality;
          const distinctCount = f.statistics?.distinct;

          // Sample values — show up to 5 values to keep search results compact.
          // Each search result is added to streamWithTools conversation history and
          // re-sent on every subsequent iteration, so compactness matters for cost.
          if (f.sampleValues && f.sampleValues.length > 0) {
            // Cardinality-aware sample count: a low-cardinality (enum-like) column
            // shows its (almost) full value set — the agent needs the valid filter
            // values; a unique/high-cardinality column (ids, measures) shows just a
            // couple as a format hint. Falls back to 5 when cardinality is unknown
            // (e.g. NoSQL sources that don't profile distinct counts).
            let maxDisplay = 5;
            if (cardinality === 'low') maxDisplay = 12;
            else if (cardinality === 'unique' || cardinality === 'high') maxDisplay = 2;
            const displayed = f.sampleValues.slice(0, maxDisplay);
            const samples = displayed.map(v => this.capSampleValue(v)).join('|');

            if (distinctCount) {
              if (displayed.length < f.sampleValues.length || f.sampleValues.length < distinctCount) {
                // Showing subset: "showing 20 of 77 distinct values"
                fieldStr += `[showing ${displayed.length} of ${distinctCount} distinct values]{${samples}}`;
              } else {
                // Showing all: "all 5 values"
                fieldStr += `[all ${distinctCount} values]{${samples}}`;
              }
            } else {
              fieldStr += `{${samples}}`;
            }
          }
          // No sample values but we know cardinality — tell LLM what we know
          else if (distinctCount && (cardinality === 'low' || cardinality === 'medium')) {
            fieldStr += `[${distinctCount} distinct values, samples not available — use SELECT DISTINCT to discover]`;
          }
          // Min/max for numeric/date fields
          else if (f.statistics && (f.statistics.min !== undefined || f.statistics.max !== undefined)) {
            const min = f.statistics.min !== undefined ? f.statistics.min : '?';
            const max = f.statistics.max !== undefined ? f.statistics.max : '?';
            fieldStr += `[${min}..${max}]`;
          }
        }

        // Curated real value vocabulary (from the semantic model / live-data profile) —
        // surfaced when the raw schema had no sample values for this column.
        const _vocab = f.semantic?.valueVocabulary;
        if (_vocab && _vocab.length && !(f.sampleValues && f.sampleValues.length)) {
          fieldStr += `{${_vocab.slice(0, 8).map(v => this.capSampleValue(v)).join('|')}}`;
        }

        // Prefer the platform-editable field description; semantic.summary (only
        // settable at entity level today, not per-field) is a fallback for sources
        // that were auto-generated without a hand-written description. Unit/notes
        // always come from the semantic model regardless of which summary won.
        const fsem = f.semantic;
        const ann: string[] = [];
        if (f.description) ann.push(f.description);
        else if (fsem?.summary) ann.push(fsem.summary);
        if (fsem?.unit) ann.push(`unit: ${fsem.unit}`);
        if (fsem?.notes) ann.push(`note: ${fsem.notes}`);
        if (ann.length) fieldStr += ` — ${ann.join('; ')}`;

        return fieldStr;
      })
      .join(',\n    ');

    const moreFields = visibleFields.length > maxFields
      ? ` (showing ${maxFields} of ${visibleFields.length} columns)`
      : '';

    const rowInfo = entity.rowCount
      ? ` [~${this.formatNumber(entity.rowCount)} rows]`
      : '';

    // Prefer the semantic summary; append synonyms, canonical join paths, and gotchas.
    const sem = entity.semantic;
    const desc = sem?.summary ? ` — ${sem.summary}` : (entity.description ? ` - ${entity.description}` : '');
    const extra = [
      sem?.synonyms?.length ? `aka: ${sem.synonyms.slice(0, 12).join(', ')}` : '',
      sem?.joins?.length ? `joins: ${sem.joins.map(j => `${j.via || j.on}→${j.to}`).join(', ')}` : '',
      sem?.notes ? `note: ${sem.notes}` : '',
    ].filter(Boolean).map(s => `\n  ${s}`).join('');
    return `• ${entity.fullName || entity.name}${rowInfo}${desc}:\n    ${fieldDetails}${moreFields}${extra}`;
  }

  // ============================================
  // Schema Format: Table Catalog (names + row counts)
  // ============================================

  /**
   * Compact listing of ALL table names with abbreviated row counts.
   * Sorted by importance score. No columns, no types.
   * Always tells LLM what's missing.
   * Token cost: ~3-5 tokens per table.
   */
  protected formatTableCatalog(excludeNames?: Set<string>): string {
    if (!this.schema || !this.schema.entities.length) {
      return 'No tables available.';
    }

    const sorted = this.getSortedEntities();
    const filtered = excludeNames
      ? sorted.filter(e => !excludeNames.has(e.fullName || e.name))
      : sorted;

    if (filtered.length === 0) return '';

    const entries = filtered.map(e => {
      const name = e.fullName || e.name;
      const rows = e.rowCount ? `(${this.abbreviateNumber(e.rowCount)} rows)` : '';
      return `${name}${rows}`;
    });

    const hasSearch = this.determineSchemaTier() === 'large' || this.determineSchemaTier() === 'very_large';
    const discoveryHint = hasSearch
      ? 'use search_schema tool to look up column details for any table'
      : 'include the table name in your intent and the source agent will discover its columns';

    const label = excludeNames && excludeNames.size > 0
      ? `Remaining ${filtered.length} tables`
      : `All ${filtered.length} tables`;
    return `${label} (names and row counts only — ${discoveryHint}):\n${entries.join(', ')}`;
  }

  // ============================================
  // Schema Format: Keyword Index
  // ============================================

  /**
   * Extract domain keywords from ALL table names, sorted by frequency.
   * Used by main agent when per-source budget is tight (5+ sources).
   * Token cost: ~50-80 tokens total.
   */
  protected formatKeywordIndex(): string {
    if (!this.schema || !this.schema.entities.length) {
      return '';
    }

    const wordFrequency = new Map<string, number>();

    for (const entity of this.schema.entities) {
      const words = this.splitTableNameToWords(entity.name);
      for (const word of words) {
        if (word.length > 2 && !TABLE_NAME_STOP_WORDS.includes(word)) {
          wordFrequency.set(word, (wordFrequency.get(word) || 0) + 1);
        }
      }
    }

    const topKeywords = [...wordFrequency.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([word]) => word);

    if (topKeywords.length === 0) return '';
    return `Data domains: ${topKeywords.join(', ')}`;
  }

  // ============================================
  // Budget-Aware Schema for Main Agent
  // ============================================

  /**
   * Format schema for the main agent based on available token budget.
   * Budget is computed from _totalSourceCount (set by SourceManager).
   *
   * Always includes: context notes about what's shown vs available,
   * and a full catalog of all table names with row counts.
   */
  protected formatSchemaForMainAgent(): string {
    const totalSourceCount = this._totalSourceCount;
    if (!this.schema || !this.schema.entities.length) {
      return 'Schema not available. Run schema extraction first.';
    }

    const tier = this.determineSchemaTier();
    const total = this.schema.entities.length;

    // Small sources always get full detail regardless of budget
    if (tier === 'small') {
      return this.formatSchemaForLLM(Infinity, Infinity);
    }

    // Compute per-source budget
    const perSourceBudget = Math.floor(MAIN_AGENT_TOTAL_SCHEMA_BUDGET / Math.max(totalSourceCount, 1));

    // Determine how many detailed tables based on budget
    let detailedCount: number;
    let fieldsPerEntity: number;

    if (perSourceBudget >= 10000) {
      detailedCount = Math.min(MAIN_AGENT_MAX_DETAILED_TABLES, total);
      fieldsPerEntity = 15;
    } else if (perSourceBudget >= 4000) {
      detailedCount = Math.min(10, total);
      fieldsPerEntity = 15;
    } else if (perSourceBudget >= 2000) {
      detailedCount = Math.min(5, total);
      fieldsPerEntity = 10;
    } else {
      detailedCount = Math.min(3, total);
      fieldsPerEntity = 8;
    }

    const sorted = this.getSortedEntities();
    const detailedEntities = sorted.slice(0, detailedCount);
    const lines: string[] = [];

    // Context header
    const hasSearch = tier === 'medium' || tier === 'large' || tier === 'very_large';
    const searchNote = hasSearch
      ? ' The source agent has a search_schema tool and can look up any table\'s columns.'
      : ' Include table names from the catalog in your intent — the source agent can discover their columns.';
    lines.push(`[This source has ${total} tables total. Showing ${detailedCount} most important tables in detail below with column names, types, and sample values. All ${total} table names listed in the catalog.${searchNote}]`);

    // Detailed tables
    for (const entity of detailedEntities) {
      lines.push(this.formatEntityForLLM(entity, fieldsPerEntity, true));
    }

    // Catalog of remaining tables (always include, always with row counts)
    const detailedNames = new Set(detailedEntities.map(e => e.fullName || e.name));
    const catalog = this.formatTableCatalog(detailedNames);
    if (catalog) {
      lines.push('');
      lines.push(catalog);
    }

    return lines.join('\n');
  }

  // ============================================
  // Tier-Aware Full Schema for Source Agent
  // ============================================

  /**
   * Full schema for the source agent — tier-aware.
   * small: all tables with full stats
   * medium: top 50 detailed + catalog (search_schema not needed)
   * large: top 50 detailed + catalog + search_schema available
   * very_large: catalog only + search_schema required
   *
   * Always includes full context notes.
   */
  protected formatFullSchemaForLLM(): string {
    const tier = this.determineSchemaTier();
    const total = this.schema?.entities.length || 0;

    switch (tier) {
      case 'small':
        // All tables, all columns, all stats
        return this.formatSchemaForLLM(Infinity, Infinity);

      case 'medium':
      case 'large': {
        // Top N detailed tables + catalog of rest. medium gets a lower cap
        // than large — it now has search_schema too (see hasSearchSchema in
        // getTool()), so it doesn't need as large an upfront dump.
        const maxDetailed = tier === 'medium' ? SOURCE_AGENT_DETAILED_TABLES_MEDIUM : SOURCE_AGENT_DETAILED_TABLES;
        const sorted = this.getSortedEntities();
        const detailedCount = Math.min(maxDetailed, total);
        const detailedEntities = sorted.slice(0, detailedCount);
        const lines: string[] = [];

        // Context header — both tiers have search_schema now.
        const hasSearch = tier === 'medium' || tier === 'large';
        if (detailedCount < total) {
          const discoveryNote = hasSearch
            ? 'Use the search_schema tool to look up column details for tables not shown in detail.'
            : 'If you need data from a table not shown in detail, use SELECT DISTINCT on its columns to discover valid values.';
          lines.push(`[This source has ${total} tables. Showing ${detailedCount} most important tables in detail with all columns, types, and sample values. ${discoveryNote}]`);
        }

        // Detailed tables with full stats
        for (const entity of detailedEntities) {
          lines.push(this.formatEntityForLLM(entity, Infinity, true));
        }

        // Catalog of remaining
        if (detailedCount < total) {
          const detailedNames = new Set(detailedEntities.map(e => e.fullName || e.name));
          const catalog = this.formatTableCatalog(detailedNames);
          if (catalog) {
            lines.push('');
            lines.push(catalog);
          }
        }

        return lines.join('\n');
      }

      case 'very_large': {
        // Catalog only — source agent MUST use search_schema tool
        const lines: string[] = [];
        lines.push(`[This source has ${total} tables. Only table names and row counts are shown below. You MUST use the search_schema tool to look up column details before writing any query.]`);
        lines.push('');
        // Use formatTableCatalog for consistent format (no excludeNames = all tables)
        lines.push(this.formatTableCatalog());

        return lines.join('\n');
      }
    }
  }

  // ============================================
  // Schema Search (for large + very_large tiers)
  // ============================================

  /**
   * Search schema entities by keywords. Matches against table names and column names.
   * Returns full detailed schema (with stats/samples) for matched tables.
   * Used by the source agent's search_schema tool.
   */
  public searchSchema(keywords: string[]): string {
    if (!this.schema || !this.schema.entities.length) {
      return 'No schema available.';
    }

    if (!keywords || keywords.length === 0) {
      return 'No keywords provided. Provide keywords to search table and column names.';
    }

    const lowerKeywords = keywords.map(k => k.toLowerCase());

    // Score each entity by how well it matches the keywords (not just binary match)
    const scored: { entity: SchemaEntity; matchScore: number }[] = [];

    for (const entity of this.schema.entities) {
      let matchScore = 0;
      const entityName = entity.name.toLowerCase();
      const fullName = (entity.fullName || '').toLowerCase();

      for (const kw of lowerKeywords) {
        // Table name matches (weighted higher — more intentional)
        if (entityName === kw || fullName === kw) {
          matchScore += 10; // Exact table name match
        } else if (entityName.includes(kw) || fullName.includes(kw)) {
          matchScore += 5;  // Partial table name match
        }

        // Column name matches (skip internal __-prefixed bookkeeping columns)
        for (const f of entity.fields) {
          if (f.name.startsWith('__')) continue;
          const colName = f.name.toLowerCase();
          if (colName === kw) {
            matchScore += 3; // Exact column match
          } else if (colName.includes(kw)) {
            matchScore += 1; // Partial column match
          }
        }
      }

      if (matchScore > 0) {
        scored.push({ entity, matchScore });
      }
    }

    if (scored.length === 0) {
      return `No tables matched keywords: ${keywords.join(', ')}. Try different or broader keywords.`;
    }

    // Sort by match relevance first, then by importance score as tiebreaker
    const sorted = scored.sort((a, b) => {
      const scoreDiff = b.matchScore - a.matchScore;
      if (scoreDiff !== 0) return scoreDiff;
      return this.computeEntityScore(b.entity) - this.computeEntityScore(a.entity);
    });

    // Cap results to keep context focused and reduce conversation history bloat.
    // Each search result adds to the streamWithTools conversation, and every subsequent
    // iteration re-sends it. Keeping results compact (8 tables, 25 cols) reduces
    // per-iteration token growth from ~20K to ~5K, cutting source agent costs by ~60%.
    const maxResults = 8;
    const maxColumnsPerTable = 25;
    const capped = sorted.slice(0, maxResults).map(s => s.entity);
    const lines = capped.map(entity =>
      this.formatEntityForLLM(entity, maxColumnsPerTable, true)
    );

    const totalMatched = scored.length;
    const contextNote = totalMatched > maxResults
      ? `\n\n[Showing top ${maxResults} of ${totalMatched} matches (ranked by relevance). Use more specific keywords to narrow results.]`
      : '';

    return `Found ${totalMatched} matching tables (showing ${capped.length}):\n\n${lines.join('\n\n')}${contextNote}`;
  }

  // ============================================
  // Existing Helper Methods
  // ============================================

  /**
   * Format relationships for LLM description
   */
  protected formatRelationshipsForLLM(): string {
    if (!this.schema?.relationships || this.schema.relationships.length === 0) {
      return '';
    }

    const maxShown = 20;
    const total = this.schema.relationships.length;
    const relationshipLines = this.schema.relationships
      .slice(0, maxShown)
      .map(r => `  ${r.from}.${r.fromField} → ${r.to}.${r.toField}`)
      .join('\n');

    const more = total > maxShown
      ? `\n  (showing ${maxShown} of ${total} relationships)`
      : '';

    return `\n\nTable Relationships (for JOINs):\n${relationshipLines}${more}`;
  }

  /**
   * Get source description with business context
   */
  protected getSourceContext(): string {
    const desc = this.config.description;
    if (desc) {
      return `\n\nData Context: ${desc}`;
    }
    return '';
  }

  /**
   * Generate data domain hints from schema
   */
  protected getDataDomainHints(): string {
    if (!this.schema || !this.schema.entities.length) {
      return '';
    }

    // Extract key concepts from ALL table names
    const concepts = new Set<string>();
    for (const entity of this.schema.entities) {
      const words = this.splitTableNameToWords(entity.name);
      for (const word of words) {
        if (word.length > 3 && !['info', 'data', 'table', 'list'].includes(word)) {
          concepts.add(word);
        }
      }
    }

    if (concepts.size > 0) {
      const conceptList = Array.from(concepts).slice(0, 10).join(', ');
      return `\n\nUse this source for questions about: ${conceptList}`;
    }
    return '';
  }

  /**
   * Format entity with full details (verbose multi-line format)
   */
  protected formatEntityDetailed(entity: SchemaEntity): string {
    const lines: string[] = [];
    lines.push(`${entity.fullName || entity.name}:`);

    for (const field of entity.fields) {
      let line = `  • ${field.name}: ${field.type}`;

      const annotations: string[] = [];
      if (field.isPrimaryKey) annotations.push('PK');
      if (field.isForeignKey) annotations.push(`FK → ${field.references?.entity}`);
      if (!field.nullable) annotations.push('NOT NULL');

      if (annotations.length) {
        line += ` (${annotations.join(', ')})`;
      }

      if (field.description) {
        line += ` - ${field.description}`;
      }

      lines.push(line);
    }

    return lines.join('\n');
  }

  /**
   * Normalize database type to common type
   */
  protected normalizeType(nativeType: string): string {
    const type = nativeType.toLowerCase();

    if (['varchar', 'char', 'text', 'nvarchar', 'nchar', 'ntext', 'string', 'character varying'].some(t => type.includes(t))) return 'TEXT';
    if (['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'double', 'number', 'money', 'serial'].some(t => type.includes(t))) return 'NUMBER';
    if (['bool', 'bit'].some(t => type.includes(t))) return 'BOOLEAN';
    if (type === 'date') return 'DATE';
    if (['datetime', 'timestamp', 'time'].some(t => type.includes(t))) return 'TIMESTAMP';
    if (['json', 'jsonb'].some(t => type.includes(t))) return 'JSON';
    if (['binary', 'varbinary', 'blob', 'image', 'bytea'].some(t => type.includes(t))) return 'BINARY';
    if (type.includes('uuid')) return 'UUID';
    if (type.includes('array') || type.includes('[]')) return 'ARRAY';

    return 'TEXT';
  }

  /**
   * Cap a single sample/vocab value to MAX_SAMPLE_VALUE_CHARS for prompt rendering.
   * A long JSON blob (e.g. a wifi/cell array) is truncated to show its shape, not
   * its full content — this is the main lever against schema token bloat.
   */
  protected capSampleValue(v: any): string {
    const s = typeof v === 'string' ? v : String(v);
    return s.length > MAX_SAMPLE_VALUE_CHARS ? s.slice(0, MAX_SAMPLE_VALUE_CHARS) + '…' : s;
  }

  /**
   * Format number with commas
   */
  protected formatNumber(num: number): string {
    return num.toLocaleString();
  }

  /**
   * Abbreviate large numbers: 1200 → "1.2K", 1500000 → "1.5M"
   */
  protected abbreviateNumber(num: number): string {
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return String(num);
  }

  /**
   * Split a table name into meaningful words.
   * Handles: camelCase, PascalCase, snake_case, prefixed names (tblDocMain → doc, main)
   */
  protected splitTableNameToWords(name: string): string[] {
    return name
      // Insert separator before uppercase letters (camelCase/PascalCase)
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      // Insert separator between uppercase runs and lowercase (e.g., "HTMLParser" → "HTML_Parser")
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase()
      .split(/[_\-\s.]+/)
      .filter(w => w.length > 0);
  }

  /**
   * Mark as connected
   */
  protected setConnected(value: boolean): void {
    this.connected = value;
  }

  /**
   * Whether to drop backup/temp/archived entities from the extracted schema.
   *
   * True for database sources, whose auto-discovered table list routinely
   * includes snapshot/backup tables that would only add noise. File sources
   * (Excel/CSV) override this to false: every entity is a sheet the user
   * explicitly chose to upload, so a sheet named e.g. "TEMP_Q1" or
   * "Backup_2025" must NOT be silently stripped (it would leave the data
   * viewer empty even though the upload succeeded).
   */
  protected filtersJunkTables(): boolean {
    return true;
  }

  /**
   * Update schema and invalidate cached computations.
   * Filters out backup, temp, and archived tables before storing
   * (database sources only — see filtersJunkTables()).
   */
  protected setSchema(schema: SourceSchema): void {
    const originalCount = schema.entities.length;
    const filtered = this.filtersJunkTables()
      ? schema.entities.filter(e => !this.isJunkTable(e.name))
      : schema.entities;
    const removedCount = originalCount - filtered.length;

    if (removedCount > 0) {
      console.log(`[${this.getName()}] Filtered ${removedCount} backup/temp tables (${originalCount} → ${filtered.length})`);
    }

    this.rawSchema = { ...schema, entities: filtered };
    this.recomputeSchema();
  }

  /** Recomputes `schema` = rawSchema merged with the current semantic-model overlay, and invalidates caches. */
  private recomputeSchema(): void {
    this.schema = this.rawSchema
      ? mergeSchemaWithSemanticOverlay(this.rawSchema, this.config.semanticModel ?? null)
      : (this.config.semanticModel as SourceSchema) || null;
    this._sortedEntities = null;
    this._schemaTier = null;
  }

  /**
   * Detect backup, temp, and archived tables by naming patterns.
   * These are safe to exclude across all enterprise databases:
   * - Date stamps in name (03DEC2025, 20250301) — always point-in-time snapshots
   * - BACKUP_ prefix or _BACKUP/_BK_ infix — always snapshots
   * - DEL_BACKUP_/UPD_BACKUP_ — always migration script artifacts
   * - TMP_/TEMP_ prefix — always scratch tables
   * - x_ prefix — always archived copies
   * - ___ prefix — always scratch/staging tables
   */
  private isJunkTable(name: string): boolean {
    // Date stamp: 8+ consecutive digits NOT immediately preceded by a letter
    // (avoids false-positives on system-generated names like csv-bc8017062506_table)
    if (/(?<![a-zA-Z])\d{8,}/.test(name)) return true;

    // Date stamp: DDMMMYYYY (e.g., 03DEC2025, 14FEB2019)
    if (/\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{4}/i.test(name)) return true;

    // Backup prefixes and infixes
    if (/^BACKUP_/i.test(name)) return true;
    if (/_BACKUP/i.test(name)) return true;
    if (/_BK_/i.test(name)) return true;

    // Migration script artifacts
    if (/^DEL_BACKUP/i.test(name)) return true;
    if (/^UPD_BACKUP/i.test(name)) return true;
    if (/^UPD_BAKCUP/i.test(name)) return true;

    // Temp/scratch tables
    if (/^TMP_/i.test(name)) return true;
    if (/^TEMP_/i.test(name)) return true;

    // Archived copies
    if (/^x_/i.test(name)) return true;
    if (/^xBE_/i.test(name)) return true;

    // Triple-underscore scratch tables
    if (/^___/.test(name)) return true;

    return false;
  }
}
