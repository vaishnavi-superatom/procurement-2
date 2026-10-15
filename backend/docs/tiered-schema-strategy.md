# Tiered Schema Strategy for Multi-Agent System

## Problem

When a data source has hundreds of tables (e.g., 522-table MSSQL ERP), the current system fails because:

1. **Main Agent** sees only the first 20 tables alphabetically (`entities.slice(0, 20)`) — cannot route to tables starting with letters beyond C
2. **Source Agent** also sees only 20 tables — guesses table/column names, burns all 3 retries, times out
3. Multiple large sources compound the problem — main agent prompt bloats with redundant detail

### Root Cause in Code

```
base-source.ts:138  → formatSchemaForLLM(maxEntities = 20, maxFieldsPerEntity = 15)
base-source.ts:134  → formatFullSchemaForLLM() calls formatSchemaForLLM(20, Infinity)  // still 20 tables!
```

Both agents are blind to 96% of the schema. The "top 20" is alphabetical — not ranked by importance.

---

## Solution: Budget-Aware Tiered Schema

### Two Key Insights

1. **Main Agent only needs to route** — it needs to know what data exists, not full column details
2. **Source Agent needs to write SQL** — it needs exact column names, but not necessarily statistics

### Tier Determination

Each source computes its tier based on table count. The main agent's detail level is further adjusted by a **token budget** divided across all sources.

| Tier | Table Count | Description |
|------|------------|-------------|
| `small` | ≤ 50 | Full detail everywhere, no truncation |
| `medium` | 51–200 | Top 50 detailed + catalog for source agent |
| `large` | 201–500 | Top 50 detailed + catalog + `search_schema` tool |
| `very_large` | 500+ | Catalog only + `search_schema` tool required |

### Budget System for Main Agent

Total token budget for all source summaries in main agent: **~15,000 tokens**

```
per_source_budget = 15000 / total_source_count
```

| Sources | Per-Source Budget | Main Agent Detail Level |
|---------|-----------------|----------------------|
| 1 | 15,000 | Top 20 detailed tables + full catalog (all names + row counts) |
| 3 | 5,000 | Top 10 detailed tables + compact catalog (names only) |
| 5 | 3,000 | Top 5 detailed tables + keyword index |
| 10 | 1,500 | Domain summary + top 3 table names |

---

## Schema Formats

### Format 1: Full Detail (existing `formatSchemaForLLM`)

Used by: Main agent (small tier), Source agent (small tier)

```
• dbo.tblDocMain [~45,000 rows]:
  iDocSrNo(NUMBER)[PK], szDocType(TEXT)[LOW-CARD:good for GROUP BY]{QUO|SO|INV|PO},
  dTotalAmount(NUMBER)[0..9999999.99], szStatus(TEXT)[LOW-CARD]{Draft|Approved|Cancelled},
  dtDocDate(TIMESTAMP)[2020-01-01..2024-12-31], iCustomerId(NUMBER)[FK→tblCustomerMaster]
```

Includes: type, PK/FK markers, cardinality tags, sample values `{...}`, min/max ranges `[...]`

### Format 2: Top N Detailed + Catalog (medium/large tier)

Used by: Source agent (medium/large tier) — top 50 tables get full detail, rest are catalog names.

The top 50 tables (by importance score) get the same full detail format as Format 1.
Remaining tables listed as catalog (names + row counts only).
Context note at the top tells the LLM exactly what it's seeing.

Example context header:
```
[This source has 486 tables. Showing 50 most important tables in detail with all columns, types, and sample values.
Use the search_schema tool to look up column details for tables not shown in detail.]
```

Token cost: ~50 detailed tables × ~200 tokens + ~436 catalog entries × ~4 tokens = ~12K tokens.
Compare to old approach: 486 tables × ~120 tokens (all compact) = ~58K tokens — **5× fewer tokens AND higher quality**.

### Format 3: Table Catalog (`formatTableCatalog`)

Used by: Main agent (medium/large/very_large tier), Source agent (very_large tier prompt)

```
All 522 tables (sorted by relevance):
dbo.tblDocMain(45K rows), dbo.tblCustomerMaster(2K rows), dbo.tblItemMaster(15K rows),
dbo.tblDocDetails(120K rows), dbo.QuotationVsDesgnParamter(8K rows), ...
```

No columns, no types, no stats. Just table names + abbreviated row counts.
Sorted by importance score (see below).

Token cost: ~3-5 tokens per table. 522 tables = ~1,500-2,500 tokens.

### Format 4: Keyword Index (`formatKeywordIndex`)

Used by: Main agent when per-source budget is tight (5+ sources)

```
Data domains: documents, quotation, sales, purchase, invoice, customer, item,
inventory, employee, account, ledger, payment, approval, dispatch, receipt
```

Extracted from ALL table names — unique meaningful words sorted by frequency.

Token cost: ~50-80 tokens total for 500+ tables.

### Format 5: Domain Summary

Used by: Main agent when per-source budget is very tight (10+ sources)

```
ERP system: quotations, sales, purchases, invoicing, inventory, customers, employees
```

One-line description of what data exists. Cheapest possible representation.

---

## Entity Importance Scoring

The "top N" tables are no longer alphabetical — they're ranked by a composite score.

### Score Calculation

```typescript
score = (inbound_FK_count × 3)      // hub tables (referenced by many others)
      + (outbound_FK_count × 1)      // tables that join to others
      + log10(row_count + 1)          // large tables (log scale)
      + min(column_count / 10, 3)     // wide fact tables (capped at 3)
```

### Example Scores

| Table | Inbound FKs | Outbound FKs | Rows | Cols | Score |
|-------|------------|-------------|------|------|-------|
| tblCustomerMaster | 8 | 0 | 2K | 15 | 24 + 0 + 3.3 + 1.5 = **28.8** |
| tblDocMain | 5 | 3 | 45K | 20 | 15 + 3 + 4.7 + 2.0 = **24.7** |
| tblDocDetails | 1 | 2 | 120K | 12 | 3 + 2 + 5.1 + 1.2 = **11.3** |
| tblAuditLog | 0 | 0 | 500K | 5 | 0 + 0 + 5.7 + 0.5 = **6.2** |
| tblTempCalc | 0 | 0 | 0 | 3 | 0 + 0 + 0 + 0.3 = **0.3** |

Hub/master tables naturally surface first. Empty/temp tables sink to the bottom.

### Why These Weights

- **Inbound FKs × 3**: A table referenced by 8 others is a central entity (customers, products). Most user questions involve these. Highest weight.
- **Outbound FKs × 1**: Tables with FKs join to hub tables — they're transaction/detail tables (orders, line items). Important but secondary.
- **log10(rows)**: A million-row table is important, but not 6× more important than a 1-row table. Log scale prevents row count from dominating.
- **Columns / 10 (max 3)**: Wide tables tend to be fact tables with rich data. Capped to prevent it from dominating.

---

## What Each Agent Sees Per Tier

### Source Agent (per-source, unaffected by source count)

| Source Tables | Source Agent Prompt |
|--------------|-------------------|
| ≤ 50 | Full schema with stats/samples for ALL tables |
| 51–500 | Compact schema (all tables, cols + types, no stats) |
| 500+ | Table catalog + `search_schema` tool (on-demand lookup) |

### Main Agent (budget-aware across all sources)

| Per-Source Budget | Main Agent Sees |
|------------------|----------------|
| ≥ 10,000 tokens | Top 20 detailed tables (scored) + full catalog |
| 4,000–10,000 | Top 10 detailed tables (scored) + compact catalog (names only) |
| 2,000–4,000 | Top 5 detailed tables (scored) + keyword index |
| < 2,000 | Domain summary + top 3 table names |

---

## Schema Search Tool (Tier: very_large)

For 500+ table sources, the source agent gets a `search_schema` tool alongside the query tool.

### Tool Definition

```json
{
  "name": "{source_id}_search_schema",
  "description": "Search for tables and columns by keyword. Returns full column details for matching tables. Use BEFORE writing SQL.",
  "input_schema": {
    "type": "object",
    "properties": {
      "keywords": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Keywords to match against table and column names"
      }
    },
    "required": ["keywords"]
  }
}
```

### How It Works

1. Searches `schema.entities` — matches keywords against table names AND column names
2. Returns full detailed schema (with stats/samples) for matched tables
3. Caps results at 30 tables to prevent prompt explosion
4. Does NOT count as a retry attempt

### Example Flow

```
User: "What's the total quotation value?"

Main Agent → dispatches to MSSQL source with intent: "get total quotation value"

Source Agent prompt:
  "This source has 522 tables. Use search_schema to find relevant tables first."
  [catalog of all 522 table names]

Source Agent calls: search_schema(["quotation", "quote", "doc", "amount"])

Returns:
  dbo.QuotationVsDesgnParamter [~8,000 rows]:
    QuotationSrNo(NUMBER)[PK], DesignParam1(TEXT), ...

  dbo.tblDocMain [~45,000 rows]:
    iDocSrNo(NUMBER)[PK], szDocType(TEXT){QUO|SO|INV|PO},
    dTotalAmount(NUMBER)[0..9999999], szStatus(TEXT){Draft|Approved|Cancelled}, ...

Source Agent now writes correct SQL:
  SELECT szStatus, COUNT(*) as Count, SUM(dTotalAmount) as TotalValue
  FROM dbo.tblDocMain WHERE szDocType = 'QUO' GROUP BY szStatus

→ Succeeds on first attempt (instead of 3 failed retries)
```

### Source Agent Prompt Addition (Tier: very_large)

Added to `agent-source-query/system.md` via `{{SCHEMA_SEARCH_INSTRUCTIONS}}`:

```
## Schema Search
This source has a large schema (500+ tables). The schema above shows a catalog of table names.
Before writing any query, you MUST use the search_schema tool to find exact table and column names.
1. Search with keywords related to the user's question
2. Review the returned column details
3. Then write your SQL query using the exact names from the search results
You may search multiple times with different keywords if the first search doesn't find what you need.
```

---

## Files Changed

### 1. `backend/src/sources/core/types.ts`

**Add:**
- `SchemaTier` type: `'small' | 'medium' | 'large' | 'very_large'`
- New fields on `SourceTool` interface:
  - `schemaTier?: SchemaTier` — tier metadata for downstream consumers
  - `schemaSearchFn?: (keywords: string[]) => string` — schema search function for very_large tier

### 2. `backend/src/sources/core/base-source.ts` (core changes)

**New methods:**

| Method | Purpose |
|--------|---------|
| `determineSchemaTier(): SchemaTier` | Compute tier from `schema.entities.length` |
| `computeEntityScore(entity): number` | Importance score using FK connections + row count |
| `getSortedEntities(): SchemaEntity[]` | All entities sorted by importance score |
| `formatEntityForLLM(entity, options): string` | Per-entity formatting (extracted from `formatSchemaForLLM`) |
| `formatCompactSchemaForLLM(): string` | All tables, cols + types only, no stats |
| `formatTableCatalog(): string` | All table names + abbreviated row counts |
| `formatKeywordIndex(): string` | Domain keywords extracted from table names |
| `formatSchemaForMainAgent(): string` | Budget-aware schema for main agent (uses `_totalSourceCount`) |
| `setTotalSourceCount(count): void` | Set source count for budget calculation (called by SourceManager) |
| `searchSchema(keywords): string` | Keyword search over schema entities |

**Modified methods:**

| Method | Change |
|--------|--------|
| `formatFullSchemaForLLM()` | Tier-aware: small → full detail, medium/large → compact, very_large → catalog only |
| `buildFullSchemaDescription()` | Uses tier-aware `formatFullSchemaForLLM()` |
| `getTool()` | Adds `schemaTier` and `schemaSearchFn` to returned tool |
| `getDataDomainHints()` | Now scans ALL tables (currently used, no change needed in logic but benefits from sorted entities) |

**`formatSchemaForLLM()` is NOT modified** — kept as-is for backward compatibility. New code uses `formatSchemaForMainAgent()` instead.

### 3. Database subclasses (5 files)

Each calls `this.formatSchemaForLLM()` in `buildToolDescription()`. Change to `this.formatSchemaForMainAgent()`.

| File | Line | Change |
|------|------|--------|
| `backend/src/sources/postgres/instance.ts` | 767 | `formatSchemaForLLM()` → `formatSchemaForMainAgent()` |
| `backend/src/sources/mysql/instance.ts` | 743 | `formatSchemaForLLM()` → `formatSchemaForMainAgent()` |
| `backend/src/sources/mssql/instance.ts` | 843 | `formatSchemaForLLM()` → `formatSchemaForMainAgent()` |
| `backend/src/sources/excel/instance.ts` | 473 | `formatSchemaForLLM()` → `formatSchemaForMainAgent()` |
| `backend/src/sources/csv/instance.ts` | 333 | `formatSchemaForLLM()` → `formatSchemaForMainAgent()` |

### 4. `sdk-nodejs/src/userResponse/services/tool-executor-service.ts`

**Add to `ExternalTool` interface:**
- `schemaTier?: string`
- `schemaSearchFn?: (keywords: string[]) => string`

### 5. `sdk-nodejs/src/userResponse/agents/source-agent.ts`

**Changes:**
- `execute()`: Build tool array with both query tool + `search_schema` tool (when `schemaSearchFn` exists)
- `toolHandler`: Route `search_schema` calls to `schemaSearchFn`, NOT counting toward retry attempts
- `maxIterations`: Add +2 when schema search tool is present (extra round-trips for search)
- New method: `buildSchemaSearchToolDefinition()` — tool definition for the search tool

### 6. `backend/.prompts/agent-source-query/system.md`

**Add `{{SCHEMA_SEARCH_INSTRUCTIONS}}` placeholder** after `{{FULL_SCHEMA}}` section.

Empty for small/medium/large tiers. Populated for very_large tier with instructions to search before querying.

### 7. `backend/src/sources/core/source-manager.ts`

**Changes:**
- `getSourceTools()`: Calls `instance.setTotalSourceCount(totalCount)` on each instance before `getTool()` so budget-aware formatting works.

### 8. `sdk-nodejs/src/userResponse/agents/agent-prompt-builder.ts`

**Changes:**
- `extractEntityDetails()`: Now also parses table catalog format ("tableName(1.2K rows)") in addition to bullet-point entities
- `formatSummariesForPrompt()`: Use budget-aware formatting
- `extractEntityDetails()`: Handle catalog format (in addition to existing bullet-point parsing)

### 8. `sdk-nodejs/src/userResponse/agents/main-agent.ts`

**Changes:**
- `buildSourceToolDefinitions()`: Pass total source count when building summaries
- Budget calculation: `Math.floor(15000 / sourceTools.length)`

### 9. `sdk-nodejs/src/userResponse/agent-user-response.ts`

**Changes:**
- Pass `schemaTier` and `schemaSearchFn` through when mapping `externalTools` to `agentTools`

---

## Token Estimates Per Scenario

### Single Source (522 tables)

| Component | Before | After |
|-----------|--------|-------|
| Main agent source summary | ~2K (20 tables detailed) | ~4.5K (20 detailed + catalog) |
| Source agent schema | ~3-5K (20 tables, all cols) | ~3K catalog + ~2K search result |
| Wasted retries | 3 retries × ~2K each = ~6K | 0 (correct on first attempt) |
| **Total per request** | **~13K + timeouts** | **~9.5K + succeeds** |

### 3 Large Sources (500 tables each)

| Component | Before | After |
|-----------|--------|-------|
| Main agent (all sources) | ~6K (60 tables, 20 each) | ~9K (30 detailed + catalogs) |
| Source agent (per source) | ~3-5K (20 tables) | ~3K catalog + ~2K search |
| **Total per request** | **~15K + failures** | **~15K + succeeds** |

### 5 Large Sources

| Component | Before | After |
|-----------|--------|-------|
| Main agent (all sources) | ~10K (100 tables, 20 each) | ~8K (25 detailed + keyword indices) |
| Source agent (per source) | ~3-5K (20 tables) | ~3K catalog + ~2K search |

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Schema not yet extracted | `determineSchemaTier()` returns `small` (0 entities). Existing "Schema not available" message surfaces. |
| REST API / GraphQL | Custom `buildToolDescription()`, don't use `formatSchemaForLLM()`. Always effectively `small`. No changes needed. |
| Excel / CSV | Typically 1-10 tables (sheets/files). Always `small` tier. Changes are compatible but no-ops. |
| Source with 0 rows in all tables | Score = 0 for all. Alphabetical fallback. Fine — no data to query anyway. |
| No FK relationships | Score based on row count + column count only. Still better than alphabetical. |
| `search_schema` returns 0 results | Returns "No tables matched. Try different keywords." LLM retries with broader keywords. |
| `search_schema` matches 50+ tables | Capped at 30 results. Message: "Refine your keywords." |

---

## Implementation Order

1. `types.ts` — Add `SchemaTier`, update `SourceTool` interface
2. `base-source.ts` — All new methods + modified methods
3. Database subclasses (5 files) — One-line change each
4. `tool-executor-service.ts` — Update `ExternalTool` interface
5. `agent-user-response.ts` — Pass new fields through
6. `agent-prompt-builder.ts` — Budget-aware summaries
7. `main-agent.ts` — Budget calculation
8. `source-agent.ts` — Schema search tool
9. `agent-source-query/system.md` — Schema search instructions

---

## Schema Extraction

### Design Principle

**Extract everything, send smart.** Extraction time up to 10 minutes is acceptable. What matters is token efficiency and LLM accuracy when the schema is sent.

### Extraction Strategy

Full stats + sample values collected for ALL tables, regardless of count.

| Table Count | Processing Mode | Estimated Time |
|---|---|---|
| ≤ 50 | Sequential | 10s - 1min |
| 51+ | Parallel batches of 10 | 1-8 min (depends on table sizes) |

### Sample value thresholds

| Threshold | Value | Purpose |
|---|---|---|
| Collection trigger | `distinct ≤ 100` | When to fetch sample values for a column |
| Fetch limit | `TOP 50` / `LIMIT 50` | How many distinct values to fetch from DB |
| Display limit | 20 values in prompt | How many shown to LLM (with context: "showing 20 of 77") |

### Full context transparency

Every truncation point tells the LLM exactly what it's seeing vs what exists:

- **Sample values**: `[showing 20 of 77 distinct values]{GSTIN|DOM|EXP|...}` or `[all 5 values]{Draft|Approved|...}`
- **Columns truncated**: `(showing 15 of 40 columns)`
- **Compact schema**: `[Schema showing all N tables... Statistics not shown — use SELECT DISTINCT to discover]`
- **Table catalog**: `[...column details not listed here, use search_schema tool...]`
- **No samples available**: `[12 distinct values, samples not available — use SELECT DISTINCT to discover]`
- **Relationships**: `(showing 20 of 45 relationships)`

### Parallel processing

For 51-200 tables, we process in batches of 10 tables concurrently using `Promise.all()`. This uses the database connection pool efficiently without overwhelming it.

### Files changed

- `mssql/instance.ts` — `extractSchema()` uses `processTable()` helper with skipStats + parallel
- `postgres/instance.ts` — Same pattern
- `mysql/instance.ts` — Same pattern

### Constants

```
PARALLEL_BATCH_SIZE = 10   // Tables processed concurrently
STATS_THRESHOLD = 200      // Skip stats above this table count
```

---

## Future Enhancements

- **Table grouping by business domain**: Parse naming conventions (tbl*Main, *Master, *Details) to group tables into semantic clusters for even better main agent routing
- **On-demand stats enrichment**: When `searchSchema()` returns tables without stats, optionally fetch stats for those specific tables at query time
- **Dynamic budget**: Adjust total budget based on LLM model's context window size
- **Schema caching per tier**: Cache formatted schema strings to avoid recomputing on every request
