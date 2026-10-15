/**
 * NetSuite Source Instance — executes SuiteQL over REST. Auth is OAuth2
 * client-credentials/JWT-bearer (see ./auth.ts); token cached and
 * re-minted ~60s before expiry.
 */

import {
  BaseSource,
  SourceSchema,
  QueryResult,
  SourceTool,
  SchemaEntity,
  SchemaField,
} from '../core';
import { NetSuiteAuthConfig, NetSuiteToken, mintAccessToken, getApiBaseUrl } from './auth';

interface NetSuiteConfig extends NetSuiteAuthConfig {
  timeout?: number;
}

interface SuiteQlResponse {
  links?: unknown;
  count: number;
  hasMore: boolean;
  items: Array<Record<string, any>>;
  offset: number;
  totalResults: number;
}

// Concurrent table probes during discovery — matches table-inventory.js; fast enough, stays under NetSuite's rate limits.
const DISCOVERY_CONCURRENCY = 5;

// Sample values shown to the LLM per column — a display cap, not the scan size (see COLUMN_DISCOVERY_ROWS).
const SAMPLE_ROWS = 3;

// Rows scanned to discover columns for tables with no REST metadata (see fetchAuthoritativeFieldNames) and to
// fill in types/sample values for tables that do have it. NetSuite omits null keys entirely, so small samples
// miss sparse/optional custom fields when metadata isn't available (this account's `job` alone has 100+
// custentity_* fields, several null across any 50-row window); 50 rows keeps that risk low for one cheap query.
const COLUMN_DISCOVERY_ROWS = 50;

// Timeout for discovery queries (background process, can wait longer than live execute()'s cfg.timeout).
// Dialed down from an original 5 min after slow tables occupied the whole concurrency pool for too long.
const DISCOVERY_TIMEOUT_MS = 90_000; // 1.5 minutes

// Longer per-attempt timeout for Phase 1 only, matching table-inventory.js — some tables need >90s but <180s to
// respond. A table's existence is worth waiting for; how much is known about it (Phase 2) isn't.
const DISCOVERY_VALIDITY_TIMEOUT_MS = 180_000; // 3 minutes

// Tables confirmed real via table-inventory.js-style probing that the metadata catalog never lists (catalog
// only covers REST record types, not the full SuiteQL table set) — account-specific (each NetSuite account's
// custom tables/lists differ). Empty by default; populate per-account with that account's own confirmed
// catalog-invisible tables. Merged into discoverCandidateTables' output, case-insensitively deduped. A bad
// name here just fails checkTableValid like any other candidate — no need to hand-filter.
const SUPPLEMENTAL_TABLE_NAMES: string[] = [];

// Tables merged straight into Phase 2, skipping Phase 1 (see extractSchema) — the only way to guarantee
// inclusion for a table that structurally fails Phase 1's existence check every attempt (confirmed
// repeatedly, not one-off variance) or is business-critical enough to not risk Phase 1's normal per-run
// variance. Account-specific — empty by default; populate per-account with that account's own confirmed
// Phase-1 failures plus any SUPPLEMENTAL_TABLE_NAMES entries that are catalog-invisible (those otherwise
// depend on Phase 1 succeeding on the very first run it ever sees them, which isn't a safe bet for a
// newly-discovered candidate).
const FORCE_INCLUDE_TABLE_NAMES: string[] = [];

const DEFAULT_PAGE_SIZE = 1000; // NetSuite's SuiteQL page size cap
const TOKEN_REFRESH_BUFFER_MS = 60_000;

// Retry policy for runSuiteQlWithRetries, matching table-inventory.js's suiteQl() wrapper.
const SUITEQL_RETRIES = 3;
const SUITEQL_RETRY_BASE_DELAY_MS = 500; // backoff: base * attempt number

// Rough estimate for estimateExtractionTime() — real full-run timings on this account have landed around
// ~1600-1900s for ~420-422 candidates, i.e. ~4-4.5s/table; not a precise promise, just a ballpark for the UI.
const ESTIMATED_SECONDS_PER_CANDIDATE_TABLE = 4.5;

/** True when `error` came from our own AbortController firing (a timeout), not a real API rejection. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
}

/** Renders a caught error as exactly "TIMED OUT after Xms" or "FAILED: <real error>" — never both. */
function describeError(error: unknown, timeoutMs: number): string {
  if (isTimeoutError(error)) return `TIMED OUT after ${timeoutMs}ms`;
  const msg = error instanceof Error ? error.message : String(error);
  return `FAILED: ${msg}`;
}

/** A SuiteQL request that got a non-2xx HTTP response (vs. a network failure or timeout). */
class SuiteQlHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'SuiteQlHttpError';
  }
}

/** Retryable = transient (timeout/network failure/429/5xx). Never retry a real 4xx — another attempt can't fix it. */
function isRetryableSuiteQlError(error: unknown): boolean {
  if (error instanceof SuiteQlHttpError) return error.status === 429 || error.status >= 500;
  return true;
}

export class NetSuiteInstance extends BaseSource {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  private getConnectionConfig(): NetSuiteConfig {
    return this.config.config as NetSuiteConfig;
  }

  /**
   * Return a valid access token, re-minting only when the cached one is
   * missing or within TOKEN_REFRESH_BUFFER_MS of expiring.
   */
  private async ensureValidToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.token;
    }
    const cfg = this.getConnectionConfig();
    const result: NetSuiteToken = await mintAccessToken(cfg);
    this.token = result.accessToken;
    this.tokenExpiresAt = Date.now() + result.expiresInSeconds * 1000;
    return this.token;
  }

  async connect(): Promise<void> {
    try {
      await this.ensureValidToken();
      this.setConnected(true);
      console.log(`[NetSuiteInstance:${this.getName()}] Connected to ${this.getConnectionConfig().accountId}`);
    } catch (error) {
      this.setConnected(false);
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to NetSuite: ${errorMsg}`);
    }
  }

  async disconnect(): Promise<void> {
    this.token = null;
    this.tokenExpiresAt = 0;
    this.setConnected(false);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.runSuiteQl('SELECT 1 AS health', 1, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fast (single REST call) candidate count + rough time estimate, so a caller can report "found N tables,
   * ~X min" back to a UI before committing to the full extractSchema() run. Independent of extractSchema() —
   * calling both means discoverCandidateTables() runs twice, an acceptable trade-off for keeping this simple.
   */
  async estimateExtractionTime(): Promise<{ candidateCount: number; message: string; estimatedMinutes: number }> {
    const candidates = await this.discoverCandidateTables();
    const estimatedMinutes = Math.max(1, Math.round((candidates.length * ESTIMATED_SECONDS_PER_CANDIDATE_TABLE) / 60));
    return {
      candidateCount: candidates.length,
      estimatedMinutes,
      message: `Found ${candidates.length} record(s) from metadata catalog, extracting schema...`,
    };
  }

  /**
   * Discover accessible SuiteQL tables by probing NetSuite's metadata-catalog
   * names directly — NetSuite has no SuiteQL table catalog, so probing is the
   * only way to know what's queryable. Two phases: Phase 1 (checkTableValid)
   * decides once which tables are real; Phase 2 (enrichTable) does the
   * heavier per-table work and can never remove a table Phase 1 confirmed —
   * a Phase-2 timeout only degrades what's known about it.
   *
   * Between the two, a field-catalog lookup pass (fetchAuthoritativeFieldNames) fetches each table's REST
   * metadata once and keeps it in memory (`fieldCatalog`) for Phase 2 to read — see that method's comment
   * for why: row-sampling alone (Phase 2's fallback) can miss a real column that's null in every sampled row.
   */
  async extractSchema(): Promise<SourceSchema> {
    const candidates = await this.discoverCandidateTables();
    console.log(`[NetSuiteInstance:${this.getName()}] Discovered ${candidates.length} candidate table(s) from the metadata catalog — Phase 1: checking validity via SuiteQL (concurrency ${DISCOVERY_CONCURRENCY})...`);

    // Phase 1 — which candidates are real, queryable tables.
    const validTables: Array<{ table: string; firstRow: Record<string, any> | null }> = [];
    {
      const inFlight = new Set<string>();
      let checked = 0;
      const heartbeat = setInterval(() => {
        console.log(`[NetSuiteInstance:${this.getName()}] Phase 1 still checking: ${checked}/${candidates.length} done, ${validTables.length} valid so far. Currently in flight: ${[...inFlight].join(', ') || '(none)'}`);
      }, 15_000);

      try {
        await this.mapWithConcurrency(candidates, DISCOVERY_CONCURRENCY, async (table) => {
          inFlight.add(table);
          try {
            const result = await this.checkTableValid(table);
            if (result) validTables.push(result);
          } finally {
            inFlight.delete(table);
          }
          checked++;
          if (checked % 10 === 0 || checked === candidates.length) {
            console.log(`[NetSuiteInstance:${this.getName()}] Phase 1: checked ${checked}/${candidates.length} candidate table(s), ${validTables.length} valid so far`);
          }
        });
      } finally {
        clearInterval(heartbeat);
      }
    }

    console.log(`[NetSuiteInstance:${this.getName()}] Phase 1 done: ${validTables.length}/${candidates.length} valid table(s).`);

    // Force-include tables Phase 1 can't be relied on to pass; deduped case-insensitively. firstRow is null —
    // Phase 1 never ran for these, so enrichTable relies entirely on its own column-discovery sample.
    const validNames = new Set(validTables.map(({ table }) => table.toLowerCase()));
    for (const table of FORCE_INCLUDE_TABLE_NAMES) {
      if (!validNames.has(table.toLowerCase())) {
        validTables.push({ table, firstRow: null });
        console.log(`[NetSuiteInstance:${this.getName()}] Force-including '${table}' — Phase 1 missed it this run, but it's confirmed real`);
      }
    }

    // Field-catalog lookup — one REST metadata-catalog fetch per table (final list, including force-included
    // ones), kept in memory for Phase 2 to read. Runs after Phase 1 so force-included tables are covered too,
    // and before Phase 2 so enrichTable() never makes this call itself — see fetchAuthoritativeFieldNames.
    console.log(`[NetSuiteInstance:${this.getName()}] Looking up authoritative field lists from the REST metadata catalog for ${validTables.length} table(s) (concurrency ${DISCOVERY_CONCURRENCY})...`);
    const fieldCatalog = new Map<string, string[] | null>();
    {
      let looked = 0;
      await this.mapWithConcurrency(validTables, DISCOVERY_CONCURRENCY, async ({ table }) => {
        fieldCatalog.set(table.toLowerCase(), await this.fetchAuthoritativeFieldNames(table));
        looked++;
        if (looked % 25 === 0 || looked === validTables.length) {
          console.log(`[NetSuiteInstance:${this.getName()}] Field-catalog lookup: ${looked}/${validTables.length} done`);
        }
      });
      const withCatalog = [...fieldCatalog.values()].filter((v) => v !== null).length;
      console.log(`[NetSuiteInstance:${this.getName()}] Field-catalog lookup done: ${withCatalog}/${validTables.length} table(s) have REST metadata (the rest fall back to row-sampling for column discovery).`);
    }

    console.log(`[NetSuiteInstance:${this.getName()}] Phase 2: enriching ${validTables.length} table(s) with columns/count/statistics (concurrency ${DISCOVERY_CONCURRENCY})...`);

    // Phase 2 — enrichTable() always returns an entity, so entities.length === validTables.length when done.
    const entities: SchemaEntity[] = [];
    {
      const inFlight = new Set<string>();
      let enriched = 0;
      const heartbeat = setInterval(() => {
        console.log(`[NetSuiteInstance:${this.getName()}] Phase 2 still enriching: ${enriched}/${validTables.length} done. Currently in flight: ${[...inFlight].join(', ') || '(none)'}`);
      }, 15_000);

      try {
        await this.mapWithConcurrency(validTables, DISCOVERY_CONCURRENCY, async ({ table, firstRow }) => {
          inFlight.add(table);
          try {
            entities.push(await this.enrichTable(table, firstRow, fieldCatalog));
          } finally {
            inFlight.delete(table);
          }
          enriched++;
          if (enriched % 10 === 0 || enriched === validTables.length) {
            console.log(`[NetSuiteInstance:${this.getName()}] Phase 2: enriched ${enriched}/${validTables.length} table(s)`);
          }
        });
      } finally {
        clearInterval(heartbeat);
      }
    }

    const schema: SourceSchema = {
      entities,
      extractedAt: new Date().toISOString(),
    };

    this.setSchema(schema);
    console.log(`[NetSuiteInstance:${this.getName()}] Extracted schema: ${entities.length}/${candidates.length} accessible table(s)`);
    return schema;
  }

  /** Candidate table names from the REST metadata catalog (not SuiteQL) — most also work as SuiteQL FROM targets, not guaranteed, hence probing each below. */
  private async discoverCandidateTables(): Promise<string[]> {
    const cfg = this.getConnectionConfig();
    const token = await this.ensureValidToken();
    const url = `${getApiBaseUrl(cfg.accountId)}/services/rest/record/v1/metadata-catalog`;

    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, DISCOVERY_TIMEOUT_MS);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to load NetSuite metadata catalog (${response.status} ${response.statusText}): ${text}`);
    }

    const body = (await response.json()) as { items?: Array<{ name?: string }> };
    const catalogNames = (body.items || []).map((item) => item.name).filter((name): name is string => !!name);

    // Merge in SUPPLEMENTAL_TABLE_NAMES, case-insensitively deduped against the catalog.
    const seen = new Set(catalogNames.map((name) => name.toLowerCase()));
    const merged = [...catalogNames];
    for (const name of SUPPLEMENTAL_TABLE_NAMES) {
      if (!seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        merged.push(name);
      }
    }
    return merged;
  }

  /**
   * Authoritative, data-independent column list for a table, from NetSuite's REST record metadata catalog —
   * unlike fieldsFromSample() below, this doesn't depend on any row being non-null, so it catches sparse
   * custom fields (e.g. a custentity_* override field populated on a small enough fraction of rows that
   * COLUMN_DISCOVERY_ROWS-row sampling can plausibly miss it entirely) that row-sampling alone can never
   * guarantee.
   *
   * `properties` on this endpoint lists every field the REST record type has, but not every one of them is
   * actually a valid SuiteQL identifier — confirmed empirically across job/customer/employee/timebill/charge/
   * projecttask: SuiteQL rejects a consistent subset of `properties` with "Unknown identifier". `x-ns-filterable`
   * — the set of fields NetSuite allows filtering on — turned out to be an exact predictor of that same
   * SQL-valid subset in every one of those six tables (zero mismatches either direction), so we intersect
   * against it here instead of live-probing each column, which would cost one query per bad column found.
   *
   * Returns null when this table has no REST record type at all — the common case for most
   * SUPPLEMENTAL_TABLE_NAMES/FORCE_INCLUDE_TABLE_NAMES entries (chargerule, budgets, transactionLine, and
   * other internal/system tables aren't REST-exposed) — not a failure worth warning about; callers fall back
   * to row-sampling for these.
   */
  private async fetchAuthoritativeFieldNames(table: string): Promise<string[] | null> {
    try {
      const cfg = this.getConnectionConfig();
      const token = await this.ensureValidToken();
      const url = `${getApiBaseUrl(cfg.accountId)}/services/rest/record/v1/metadata-catalog/${table}`;

      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/schema+json' },
      }, DISCOVERY_TIMEOUT_MS);

      if (!response.ok) return null; // no REST record type for this table — expected for most system/internal tables

      const body = (await response.json()) as { properties?: Record<string, unknown>; 'x-ns-filterable'?: string[] };
      const properties = Object.keys(body.properties || {});
      if (properties.length === 0) return null;

      const filterable = new Set((body['x-ns-filterable'] || []).map((f) => f.toLowerCase()));
      const fields = properties.filter((p) => filterable.has(p.toLowerCase())).map((p) => p.toLowerCase());
      return fields.length ? fields : null;
    } catch (error) {
      console.warn(`[NetSuiteInstance:${this.getName()}] Field-catalog lookup ${describeError(error, DISCOVERY_TIMEOUT_MS)} for '${table}' — falling back to row-sampling for its columns`);
      return null;
    }
  }

  /**
   * Phase 1: is this candidate a real, queryable-with-data table? A single cheap `WHERE ROWNUM <= 1` fetch, retried
   * at DISCOVERY_VALIDITY_TIMEOUT_MS per attempt. Returns null on a genuine failure (bad target, permission gap,
   * timeout across every attempt) or a truly empty table. The row returned on success seeds enrichTable's fallback.
   *
   * `ROWNUM <= 1` specifically is buggy on some tables (confirmed on EmployeeSubsidiaryRelationship/
   * ProjectSubsidiaryRelationship): NetSuite returns `items: []` with HTTP 200 while `totalResults` still reports a
   * row and COUNT(*)/FETCH FIRST both confirm real data. So items:[] only means empty when totalResults agrees —
   * otherwise fall back once to `FETCH FIRST 1 ROWS ONLY`, which doesn't have the bug.
   */
  private async checkTableValid(table: string): Promise<{ table: string; firstRow: Record<string, any> } | null> {
    try {
      const result = await this.runSuiteQlWithRetries(`SELECT * FROM ${table} WHERE ROWNUM <= 1`, 1, 0, DISCOVERY_VALIDITY_TIMEOUT_MS);
      if (result.items.length) return { table, firstRow: result.items[0] };
      if (!result.totalResults) return null; // items empty AND totalResults agrees — genuinely empty

      console.warn(`[NetSuiteInstance:${this.getName()}] Validity check for '${table}' got items:[] but totalResults:${result.totalResults} (ROWNUM<=1 pagination quirk) — retrying with FETCH FIRST 1 ROWS ONLY`);
      const fallback = await this.runSuiteQlWithRetries(`SELECT * FROM ${table} FETCH FIRST 1 ROWS ONLY`, 1, 0, DISCOVERY_VALIDITY_TIMEOUT_MS);
      if (!fallback.items.length) return null;
      return { table, firstRow: fallback.items[0] };
    } catch (error) {
      console.warn(`[NetSuiteInstance:${this.getName()}] Validity check ${describeError(error, DISCOVERY_VALIDITY_TIMEOUT_MS)} for '${table}' — excluding from schema`);
      return null;
    }
  }

  /** Column names/types/sample-values from sample rows. Unions column names across rows (null values omit the key entirely); `links` is HATEOAS metadata, not a real column. */
  private fieldsFromSample(rows: Array<Record<string, any>>): SchemaField[] {
    const columnNames = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (key !== 'links') columnNames.add(key);
      }
    }

    return [...columnNames].map((name) => {
      const values = rows
        .map((row) => row[name])
        .filter((v) => v !== null && v !== undefined);
      const sampleValues = [...new Set(values.map((v) => String(v)))].slice(0, SAMPLE_ROWS);
      return {
        name,
        type: this.inferSuiteQlType(values[0]),
        nullable: true,
        sampleValues: sampleValues.length ? sampleValues : undefined,
      };
    });
  }

  /**
   * Like fieldsFromSample, but merges into an already-known authoritative column list instead of replacing it:
   * fills in type/sampleValues for names already present, and — defensively — appends any name the sample
   * finds that the metadata catalog didn't (should be rare to never, given the x-ns-filterable intersection in
   * fetchAuthoritativeFieldNames, but costs nothing to keep as a safety net). A column present in `fields` but
   * null across every sampled row keeps its default TEXT type and no sampleValues, rather than disappearing —
   * that's the whole point of using the authoritative list in the first place.
   */
  private mergeSampleIntoFields(fields: SchemaField[], rows: Array<Record<string, any>>): SchemaField[] {
    const sampled = this.fieldsFromSample(rows);
    const byName = new Map(fields.map((f) => [f.name, f]));

    for (const s of sampled) {
      const existing = byName.get(s.name);
      if (existing) {
        existing.type = s.type;
        existing.sampleValues = s.sampleValues;
      } else {
        fields.push(s); // sample found a column metadata didn't list — keep it rather than drop it
      }
    }
    return fields;
  }

  /**
   * Phase 2: build the full SchemaEntity for a table Phase 1 confirmed valid — always returns an entity, never
   * excludes it. Each step is independent/best-effort; a failure just means less is known, falling back to
   * `firstRow` (Phase 1's row) if the fuller sample below can't beat it in time.
   *
   * Fetches COLUMN_DISCOVERY_ROWS rows (not just SAMPLE_ROWS) so sparse/optional columns null in the first few
   * rows still get discovered. Uses `WHERE ROWNUM <= N`, not `FETCH FIRST` — FETCH FIRST blows past
   * DISCOVERY_TIMEOUT_MS on huge tables (timebill, transactionline) since it materializes the full result before
   * paging; ROWNUM stops as soon as N rows exist (~1-3s on those same tables).
   */
  private async enrichTable(table: string, firstRow: Record<string, any> | null, fieldCatalog: Map<string, string[] | null>): Promise<SchemaEntity> {
    // Authoritative column list from the field-catalog lookup pass in extractSchema() (see
    // fetchAuthoritativeFieldNames) — when present, it defines which columns exist independent of what's
    // non-null in any sample, closing the gap where a sparse custom field null across every
    // COLUMN_DISCOVERY_ROWS-row sample would otherwise never appear at all.
    const authoritative = fieldCatalog.get(table.toLowerCase());
    let fields: SchemaField[] = [];
    let usedAuthoritative = false;

    if (authoritative && authoritative.length) {
      try {
        // One cheap query to confirm the whole list is actually valid SuiteQL before trusting it. Quoted
        // identifiers dodge reserved-word syntax errors (e.g. charge.use, charge.class) so a real bad-column
        // error is never masked by an unrelated one. If NetSuite's REST metadata and SuiteQL ever disagree for
        // this table, this fails loudly here and falls back to row-sampling below — rather than silently
        // poisoning computeColumnStatistics's batched query later, where one bad column loses statistics for
        // every column on the table, not just the bad one.
        // NOTE: no `LIMIT`/`FETCH FIRST` in the SQL text — SuiteQL has no LIMIT keyword, and runSuiteQl()
        // (unlike the public execute()) doesn't strip a trailing LIMIT for you; the row cap here comes
        // entirely from the `limit=1` argument below, which becomes the ?limit=1 URL param instead.
        await this.runSuiteQl(`SELECT ${authoritative.map((c) => `"${c}"`).join(', ')} FROM ${table}`, 1, 0, DISCOVERY_TIMEOUT_MS);
        fields = authoritative.map((name) => ({ name, type: 'TEXT', nullable: true }));
        usedAuthoritative = true;
      } catch (error) {
        console.warn(`[NetSuiteInstance:${this.getName()}] Metadata-catalog column list for '${table}' didn't validate against SuiteQL (${describeError(error, DISCOVERY_TIMEOUT_MS)}) — falling back to row-sampling`);
      }
    }

    // null firstRow when force-included and no authoritative list — Phase 1 never ran, so this seeds nothing
    // until the sample below succeeds.
    if (!usedAuthoritative) fields = firstRow ? this.fieldsFromSample([firstRow]) : [];

    try {
      const sample = await this.runSuiteQl(`SELECT * FROM ${table} WHERE ROWNUM <= ${COLUMN_DISCOVERY_ROWS}`, COLUMN_DISCOVERY_ROWS, 0, DISCOVERY_TIMEOUT_MS);
      if (sample.items.length) {
        fields = usedAuthoritative ? this.mergeSampleIntoFields(fields, sample.items) : this.fieldsFromSample(sample.items);
      }
    } catch (error) {
      console.warn(`[NetSuiteInstance:${this.getName()}] Column-discovery sample ${describeError(error, DISCOVERY_TIMEOUT_MS)} for '${table}' — keeping ${usedAuthoritative ? 'the metadata-catalog column list' : 'the single row from the validity check'} instead`);
    }

    let rowCount: number | undefined;
    try {
      const countResult = await this.runSuiteQl(`SELECT COUNT(*) AS row_count FROM ${table}`, 1, 0, DISCOVERY_TIMEOUT_MS);
      rowCount = Number(countResult.items[0]?.row_count) || 0;
    } catch (error) {
      console.warn(`[NetSuiteInstance:${this.getName()}] Row count ${describeError(error, DISCOVERY_TIMEOUT_MS)} for '${table}' (keeping table without it)`);
    }

    // Full-table-scan cost, unlike the sample above — a timeout here only drops the statistics, not the table.
    await this.computeColumnStatistics(table, fields, rowCount);

    // Same as PostgresInstance/MSSQLInstance: enum-like columns (≤100 distinct) get real values, not just samples.
    for (const field of fields) {
      if (field.statistics?.distinct !== undefined && field.statistics.distinct > 0 && field.statistics.distinct <= 100) {
        const values = await this.getDistinctValues(table, field.name);
        if (values && values.length > 0) field.sampleValues = values;
      }
    }

    return { name: table, fullName: table, fields, rowCount };
  }

  /** Distinct values for a low-cardinality column — mirrors PostgresInstance.getSampleValues. */
  private async getDistinctValues(table: string, column: string): Promise<string[] | null> {
    try {
      const result = await this.runSuiteQl(
        `SELECT DISTINCT "${column}" FROM ${table} WHERE "${column}" IS NOT NULL ORDER BY "${column}" FETCH FIRST 50 ROWS ONLY`,
        50,
        0,
        DISCOVERY_TIMEOUT_MS
      );
      return result.items
        .map((row) => String(row[column]))
        .filter((v) => v !== 'null' && v !== '');
    } catch (error) {
      console.warn(`[NetSuiteInstance:${this.getName()}] Distinct-value fetch ${describeError(error, DISCOVERY_TIMEOUT_MS)} for '${table}.${column}' (keeping the smaller sample set)`);
      return null;
    }
  }

  /**
   * Batches every column's COUNT(DISTINCT)/COUNT/(numeric) MIN/MAX/AVG into one query — mirrors
   * PostgresInstance.getBatchedColumnStatistics. Positional aliases (f0_d, f1_d, ...) avoid NetSuite's identifier
   * length limits on long custom field names. Mutates `fields` in place; failures leave statistics unset.
   */
  private async computeColumnStatistics(table: string, fields: SchemaField[], rowCount: number | undefined): Promise<void> {
    if (fields.length === 0) return;

    const selectParts: string[] = [];
    fields.forEach((field, i) => {
      const col = `"${field.name}"`;
      selectParts.push(`COUNT(DISTINCT ${col}) AS f${i}_d`, `COUNT(${col}) AS f${i}_n`);
      if (field.type === 'NUMBER') {
        selectParts.push(`MIN(${col}) AS f${i}_mn`, `MAX(${col}) AS f${i}_mx`, `AVG(${col}) AS f${i}_a`);
      }
    });

    let row: Record<string, any> | undefined;
    try {
      const result = await this.runSuiteQl(`SELECT ${selectParts.join(', ')} FROM ${table}`, 1, 0, DISCOVERY_TIMEOUT_MS);
      row = result.items[0];
    } catch (error) {
      console.warn(`[NetSuiteInstance:${this.getName()}] Column statistics ${describeError(error, DISCOVERY_TIMEOUT_MS)} for '${table}' (keeping table without them)`);
      return;
    }
    if (!row) return;

    fields.forEach((field, i) => {
      const distinct = Number(row![`f${i}_d`]) || 0;
      const nonNullCount = Number(row![`f${i}_n`]) || 0;
      const stats: NonNullable<SchemaField['statistics']> = { distinct, nonNullCount };

      if (field.type === 'NUMBER') {
        const min = row![`f${i}_mn`];
        const max = row![`f${i}_mx`];
        const avg = row![`f${i}_a`];
        if (min != null) stats.min = Number(min);
        if (max != null) stats.max = Number(max);
        if (avg != null) stats.avg = Number(avg);
      }

      // Needs a row count to classify; if that timed out, keep the raw distinct count without a label.
      if (rowCount !== undefined && rowCount > 0) {
        stats.cardinality = this.determineCardinality(distinct, rowCount);
      }

      field.statistics = stats;
    });
  }

  /** Same thresholds as PostgresInstance so "low"/"high" means the same thing everywhere. */
  private determineCardinality(distinctCount: number, totalCount: number): 'unique' | 'low' | 'medium' | 'high' {
    if (totalCount === 0) return 'low';
    const ratio = distinctCount / totalCount;
    if (ratio >= 0.95 || distinctCount === totalCount) return 'unique';
    if (ratio <= 0.05 || distinctCount <= 10) return 'low';
    if (ratio <= 0.25 || distinctCount <= 100) return 'medium';
    return 'high';
  }

  /** Bounded-concurrency worker pool — mirrors data-inventory.js's mapWithConcurrency. */
  private async mapWithConcurrency<T>(values: T[], concurrency: number, worker: (value: T) => Promise<void>): Promise<void> {
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= values.length) return;
        await worker(values[index]);
      }
    });
    await Promise.all(runners);
  }

  private inferSuiteQlType(value: unknown): string {
    if (typeof value === 'number') return 'NUMBER';
    if (typeof value === 'boolean') return 'BOOLEAN';
    return 'TEXT';
  }

  /**
   * Execute a SuiteQL query.
   */
  async execute(params: { sql: string; params?: Record<string, any>; limit?: number; offset?: number }): Promise<QueryResult> {
    const startTime = Date.now();

    // $paramName placeholders (frontend/LLM convention, see FILTERING-SYSTEM.md) — SuiteQL has no bind-param
    // mechanism, so substitute to literals before anything else sees the query.
    const rawSql = params.params && Object.keys(params.params).length > 0
      ? this.substituteNamedParams(params.sql, params.params)
      : params.sql;

    // SuiteQL has no LIMIT keyword; strip it and fold into limit/offset (sent via ?limit=&offset= instead).
    const { sql: strippedSql, limit: sqlLimit, offset: sqlOffset } = this.stripTrailingLimitOffset(rawSql);
    // CAST(...) is rejected outright by this account's SuiteQL endpoint regardless of type — unwrap to bare expr.
    let sql = this.stripUnsupportedCasts(strippedSql);
    // An explicit LIMIT in the SQL itself wins over params.limit (source-agent's maxRowsFetched=50 default would
    // otherwise silently override a smaller intentional LIMIT).
    const limit = sqlLimit ?? params.limit;
    const offset = params.offset ?? sqlOffset;

    // Authorization seam — write policy + AST rewrite. See BaseSource.prepareSql.
    sql = await this.prepareSql(sql);

    console.log(`[NetSuiteInstance:${this.getName()}] Executing SuiteQL:`, sql.substring(0, 100) + (sql.length > 100 ? '...' : ''));

    const result = await this.runSuiteQl(sql, limit ?? DEFAULT_PAGE_SIZE, offset ?? 0);

    return {
      data: result.items.map(row => this.normalizeRowNumbers(row)),
      count: result.items.length,
      metadata: {
        executionTime: Date.now() - startTime,
        totalCount: result.totalResults,
        truncated: result.hasMore,
      },
    };
  }

  /**
   * Replace $paramName with a typed SQL literal (mirrors mssql's convertNamedParams); unmatched names left as-is.
   * Numbers/numeric-looking strings go bare — NetSuite internal-id NUMBER columns reject a quoted numeric literal.
   */
  private substituteNamedParams(sql: string, params: Record<string, any>): string {
    return sql.replace(/\$(\w+)/g, (match, paramName) => (
      paramName in params ? this.formatSqlLiteral(params[paramName]) : match
    ));
  }

  private formatSqlLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (Array.isArray(value)) {
      // For `column IN ($paramName)` — empty selection becomes NULL, not an invalid empty `IN ()`.
      return value.length > 0 ? value.map(v => this.formatSqlLiteral(v)).join(', ') : 'NULL';
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return value.trim();
    return `'${String(value).replace(/'/g, "''")}'`; // escape quotes to prevent injection
  }

  /** NetSuite serializes large aggregates as scientific-notation strings (e.g. "6.79E7") — normalize once here. */
  private normalizeRowNumbers(row: Record<string, any>): Record<string, any> {
    const sciNotation = /^-?\d+(\.\d+)?[eE][+-]?\d+$/;
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string' && sciNotation.test(value.trim())) {
        const n = Number(value);
        out[key] = Number.isFinite(n)
          ? n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
          : value;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  /** Strip a trailing `LIMIT n [OFFSET m]` (invalid in SuiteQL) and return the numbers for the caller to fold in. */
  private stripTrailingLimitOffset(sql: string): { sql: string; limit?: number; offset?: number } {
    const match = sql.match(/\s+LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?\s*;?\s*$/i);
    if (!match || match.index === undefined) return { sql };
    return {
      sql: sql.slice(0, match.index).trimEnd(),
      limit: Number(match[1]),
      offset: match[2] !== undefined ? Number(match[2]) : undefined,
    };
  }

  /** Unwrap `CAST(expr AS type)` to bare `expr` (CAST is rejected outright here). Paren-balanced scan, not regex, since expr can nest parens/aggregates. */
  private stripUnsupportedCasts(sql: string): string {
    let out = sql;
    for (let pass = 0; pass < 5; pass++) { // loop to also catch CAST(...) nested inside another CAST(...)
      const castRe = /CAST\s*\(/gi;
      const match = castRe.exec(out);
      if (!match) break;

      const openParenIdx = match.index + match[0].length - 1;
      let depth = 1;
      let i = openParenIdx + 1;
      for (; i < out.length && depth > 0; i++) {
        if (out[i] === '(') depth++;
        else if (out[i] === ')') depth--;
      }
      if (depth !== 0) break; // unbalanced — leave untouched rather than mangle it

      const closeParenIdx = i - 1;
      const inner = out.slice(openParenIdx + 1, closeParenIdx);
      const expr = this.stripTopLevelAsType(inner);
      out = out.slice(0, match.index) + expr + out.slice(closeParenIdx + 1);
    }
    return out;
  }

  /** Drop the trailing ` AS <type>` from a CAST(...) call's inner content, only at the top level (not nested). */
  private stripTopLevelAsType(inner: string): string {
    let depth = 0;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && /\s/.test(ch)) {
        const rest = inner.slice(i);
        const asMatch = rest.match(/^\s+AS\s+/i);
        if (asMatch) return inner.slice(0, i).trim();
      }
    }
    return inner.trim();
  }

  /** POST a SuiteQL query, single attempt. Used by Phase 2 and live execute() — a failure there only degrades results, so no retry benefit; Phase 1 uses runSuiteQlWithRetries instead. */
  private async runSuiteQl(sql: string, limit: number, offset: number, timeoutOverrideMs?: number): Promise<SuiteQlResponse> {
    const cfg = this.getConnectionConfig();
    const token = await this.ensureValidToken();
    const url = `${getApiBaseUrl(cfg.accountId)}/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Prefer: 'transient',
      },
      body: JSON.stringify({ q: sql }),
    }, timeoutOverrideMs);

    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }

    if (!response.ok) {
      const detail = typeof json === 'string' ? json : JSON.stringify(json);
      throw new SuiteQlHttpError(response.status, `SuiteQL request failed (${response.status} ${response.statusText}): ${detail}`);
    }

    return json as SuiteQlResponse;
  }

  /** Same as runSuiteQl, but retries transient failures up to SUITEQL_RETRIES times with backoff — used only by checkTableValid (Phase 1), where a failure decides if the table appears at all. */
  private async runSuiteQlWithRetries(sql: string, limit: number, offset: number, timeoutOverrideMs?: number): Promise<SuiteQlResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= SUITEQL_RETRIES; attempt++) {
      try {
        return await this.runSuiteQl(sql, limit, offset, timeoutOverrideMs);
      } catch (error) {
        lastError = error;
        if (attempt === SUITEQL_RETRIES || !isRetryableSuiteQlError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, SUITEQL_RETRY_BASE_DELAY_MS * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async fetchWithTimeout(url: string, options: RequestInit, timeoutOverrideMs?: number): Promise<Response> {
    const cfg = this.getConnectionConfig();
    const timeout = timeoutOverrideMs ?? (180000);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================
  // Tool Generation
  // ============================================

  protected getToolId(): string {
    return `${this.config.id}_suiteql`;
  }

  protected getToolName(): string {
    return `Query ${this.config.name} (NetSuite SuiteQL)`;
  }

  protected buildToolDescription(): string {
    const cfg = this.getConnectionConfig();
    const schemaInfo = this.formatSchemaForMainAgent();
    const sourceContext = this.getSourceContext();
    const domainHints = this.getDataDomainHints();

    return `Query ${this.config.name} (NetSuite ERP account: ${cfg.accountId}) via SuiteQL. Read-only.${sourceContext}${domainHints}

SuiteQL is NetSuite's own query language, with its own rules — do not assume
behavior carries over from anywhere else. CAST(...) of any target type
(NUMBER/DECIMAL/FLOAT/DOUBLE/INTEGER) does not work; this tool auto-strips it
before sending, but writing it still wastes a retry — numeric-looking fields
work fine bare, e.g. SUM(total), total > 100. Only the searched CASE WHEN
condition THEN form works for conditionals — the simple CASE column WHEN value
THEN form does not; always write out the condition on each WHEN line. ORDER BY
COUNT(*) (or its alias) fails, on any table, joined or not — but ORDER BY
COUNT(id) (a named column instead of *) and ORDER BY SUM(...)/AVG(...) all
work fine; this is specific to the COUNT(*) asterisk form, not aggregates in
general. Prefer COUNT(id) over COUNT(*) whenever the result needs ordering.
There is no ILIKE (use UPPER(col) LIKE UPPER('%text%')) and
no native LIMIT/TOP keyword (its real pagination syntax is FETCH FIRST/OFFSET)
— but write "LIMIT n" anyway at the end of every query: this tool converts it
internally before the query reaches NetSuite. Never write FETCH FIRST,
OFFSET...FETCH NEXT, or TOP yourself. This LIMIT instruction is narrow and
specific to this one clause — it does not extend to anything else in the query.
Boolean-looking columns store the text 'T'/'F', not true/false. Reference/
lookup fields (e.g. a "*_rag", "*_status", "*_pillar" style column) hold a raw
internal id, not a readable name — only trust an id→name mapping if the
schema's field description or value list actually documents one; never assume
you can JOIN against a NetSuite custom list as if it were a normal table —
resolve it with a searched CASE WHEN instead.

Available tables:
${schemaInfo}`;
  }

  protected getToolParams(): Record<string, string> {
    return {
      sql: 'string - SuiteQL query to execute (read-only SELECT). SuiteQL has its own rules: no CAST of any type (unsupported, auto-stripped — use numeric columns bare), searched CASE WHEN cond THEN only (not simple CASE col WHEN val THEN), no ORDER BY on a COUNT(*) alias (use COUNT(id) instead — SUM/AVG are unaffected and order fine), no ILIKE. Write LIMIT n at the end of every query anyway (never FETCH FIRST/OFFSET/TOP) — this tool converts it internally since SuiteQL itself has no LIMIT keyword. May contain $paramName placeholders resolved from the params object below.',
      params: 'object (optional) - Named parameters { "paramName": value }. Every $paramName occurrence in sql is replaced with the matching value as a SQL literal before the query runs (bare number for a numeric value, quoted+escaped string otherwise, NULL for null/undefined, comma-joined list for an array — for column IN ($paramName)).',
      limit: 'number (optional) - Max rows per page, default 1000 (NetSuite page size cap). Prefer a LIMIT clause in the sql itself; this parameter is an alternative, not additional.',
      offset: 'number (optional) - Row offset for pagination, default 0',
    };
  }

  protected getToolOutputSchema(): SourceTool['outputSchema'] {
    return {
      description: `Query results from ${this.config.name}. Output columns depend on the SELECT clause in the SuiteQL query.`,
      fields: [
        { name: 'data', type: 'array', description: 'Array of result rows with columns matching the SuiteQL SELECT clause' },
        { name: 'count', type: 'number', description: 'Number of rows returned in this page' },
      ],
    };
  }
}
