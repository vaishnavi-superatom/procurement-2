# Script-Based Query Architecture

## SuperAtom — Persistent, Reusable Data Scripts with Recipe Metadata

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [Why Full Scripts Fail — And What Thin-Wrapper Scripts Get Right](#2-why-full-scripts-fail--and-what-thin-wrapper-scripts-get-right)
3. [Architecture: Scripts + ScriptContext + Recipe Metadata](#3-architecture-scripts--scriptcontext--recipe-metadata)
4. [ScriptContext — The Controlled Runtime](#4-scriptcontext--the-controlled-runtime)
5. [What Scripts Can Do That Pure SQL Templates Cannot](#5-what-scripts-can-do-that-pure-sql-templates-cannot)
6. [Script Generation — Why It's No Harder Than SQL Generation](#6-script-generation--why-its-no-harder-than-sql-generation)
7. [How the Flow Works](#7-how-the-flow-works)
8. [Script Matching and Parameter Extraction](#8-script-matching-and-parameter-extraction)
9. [Script Lifecycle](#9-script-lifecycle)
10. [Consolidation Strategy](#10-consolidation-strategy)
11. [Component Generation with Scripts](#11-component-generation-with-scripts)
12. [Cost Comparison: Current vs Scripts](#12-cost-comparison-current-vs-scripts)
13. [Migration Path](#13-migration-path)
14. [Pain Points: Scripts vs Current Multi-Agent Flow](#14-pain-points-scripts-vs-current-multi-agent-flow)

---

## 1. The Problem

### Current Architecture: Every Question Starts From Scratch

Today, SuperAtom answers user questions through a multi-agent pipeline where every step is driven by LLM reasoning:

```
User Question
  -> MainAgent (LLM) reads source summaries, decides which source to query
  -> SourceAgent (LLM) searches schema, discovers tables/columns
  -> SourceAgent (LLM) generates SQL from scratch
  -> SQL fails? SourceAgent (LLM) retries with corrected SQL
  -> Need more data? SourceAgent (LLM) writes follow-up query
  -> MainAgent (LLM) analyzes returned data
  -> Component Generator (LLM) builds dashboard components
```

For large data sources (500+ tables), this pipeline requires **4-8 LLM API calls** per question. The cost multiplies when users ask related follow-up questions, because none of the knowledge gained while answering the first question (which source, which tables, which SQL patterns work) carries forward to the next question.

### The Real Cost of a Conversation

Consider a typical user session with 5 related questions about inventory:

| Question | LLM Calls | What's Repeated |
|---|---|---|
| "What's our total inventory value?" | 6 | — |
| "Break that down by warehouse" | 6 | Same source, same tables, same base SQL |
| "Which warehouses are overstocked?" | 7 | Same source, same tables, similar SQL |
| "Show me the top 10 overstocked products" | 5 | Same source, same tables, similar SQL |
| "Compare this month vs last month" | 7 | Same source, same tables, similar SQL |
| **Total** | **31** | **~80% is redundant discovery** |

The system re-discovers the same schema, re-routes to the same source, and re-generates similar SQL patterns 5 times. For enterprise customers with multiple large databases, this translates directly into high API costs and slow response times.

### Root Cause: No Knowledge Persistence

The multi-agent system has no mechanism to remember:

- **Which source** answered a particular topic (source routing knowledge)
- **Which tables and columns** are relevant for a domain (schema discovery knowledge)
- **Which SQL patterns** work for a database (query generation knowledge)
- **What business logic** applies to specific calculations (domain knowledge)
- **Which components** display a particular type of data (presentation knowledge)

Each question is a blank slate. The LLM must reason through the entire pipeline every time.

---

## 2. Why Full Scripts Fail — And What Thin-Wrapper Scripts Get Right

### The Full Script Problem

A "full script" means the LLM generates a complete TypeScript program — imports, connection management, error handling, SQL, data transformation, and output formatting. This is genuinely problematic:

```typescript
// FULL SCRIPT — too much for the LLM to get right
import { getSource } from '../sources';
import { format } from 'date-fns';

export async function getData(params: { region?: string }) {
  const db = await getSource('inventory-db');    // must know exact module path
  try {                                           // must write error handling
    const conn = await db.connect();              // must manage connection lifecycle
    const result = await conn.execute({           // must know execute() API shape
      sql: `SELECT ...`,
      params: [...]
    });
    await conn.disconnect();                      // must remember cleanup
    return result.data.map(row => ({              // must transform correctly
      ...row,
      formattedDate: format(row.date, 'yyyy-MM-dd')  // must know library API
    }));
  } catch (e) {
    await db.disconnect();                        // must handle error cleanup
    throw e;
  }
}
```

The LLM must get imports, connection lifecycle, API shapes, error handling, and cleanup all correct — in addition to the SQL itself. This is much harder than writing SQL alone and leads to more retries, not fewer.

### The Thin-Wrapper Insight

The key realization: **the hard part is the SQL, and the LLM already generates SQL today**. Everything else — connections, error handling, cleanup — is mechanical boilerplate that should be handled by a runtime, not generated by the LLM.

A thin-wrapper script separates what the LLM is good at (SQL + data logic) from what should be infrastructure (connections, execution, error handling):

```typescript
// THIN-WRAPPER SCRIPT — LLM only writes what it's good at
export async function getData(ctx: ScriptContext, params: { region?: string }) {
  const orders = await ctx.query('inventory-db', `
    SELECT p.ProductName, SUM(od.Revenue) as TotalRevenue
    FROM dbo.OrderDetails od
    JOIN dbo.Products p ON od.ProductID = p.ProductID
    ${params.region ? `WHERE r.RegionName = @region` : ''}
    GROUP BY p.ProductName
    ORDER BY TotalRevenue DESC
  `, params.region ? { region: params.region } : {});

  return orders;
}
```

No imports. No connection management. No error handling boilerplate. The `ScriptContext` handles all of that. The LLM writes SQL (which it already does today) wrapped in `ctx.query()` calls (trivial boilerplate).

**Script generation difficulty = SQL generation difficulty.** The wrapper adds near-zero complexity.

---

## 3. Architecture: Scripts + ScriptContext + Recipe Metadata

### The Two Layers

Every saved script has two parts:

**1. Recipe Metadata (JSON)** — how to find, match, validate, and present the script:

```typescript
interface ScriptRecipe {
  // Identity
  id: string;
  version: number;
  name: string;                          // "Revenue by Dimension"

  // MATCHING
  intentPatterns: string[];              // ["top * by revenue", "revenue by *"]
  embedding: number[];                   // semantic embedding for similarity search
  tags: string[];                        // ["revenue", "sales", "ranking"]

  // VALIDATION
  sources: string[];                     // source IDs used by the script
  tables: string[];                      // tables used (for schema drift detection)

  // PARAMETERS
  parameters: ParameterDefinition[];     // what can vary

  // PRESENTATION
  componentType: string;                 // "BarChart", "DataTable", etc.
  columnMappings: Record<string, string>;
  componentConfig: Record<string, any>;

  // SCRIPT REFERENCE
  scriptPath: string;                    // path to the .ts file

  // QUALITY TRACKING
  successCount: number;
  failureCount: number;
  lastUsed: string;
  createdFrom: string;                   // original question
  createdAt: string;
  updatedAt: string;
}
```

**2. Script File (.ts)** — the actual data extraction and transformation logic:

```typescript
// scripts/revenue-by-dimension.ts
import type { ScriptContext, ScriptParams } from '../script-context';

export const meta = {
  id: 'revenue-by-dimension',
  description: 'Get revenue aggregated by a chosen dimension (product, category, region)',
};

export async function getData(ctx: ScriptContext, params: ScriptParams) {
  const dimension = params.dimension || 'product';

  const dimensionMap: Record<string, { column: string; join: string }> = {
    product:  { column: 'p.ProductName',  join: 'JOIN dbo.Products p ON od.ProductID = p.ProductID' },
    category: { column: 'c.CategoryName', join: 'JOIN dbo.Categories c ON p.CategoryID = c.CategoryID' },
    region:   { column: 'r.RegionName',   join: 'JOIN dbo.Regions r ON od.RegionID = r.RegionID' },
  };

  const dim = dimensionMap[dimension] || dimensionMap['product'];
  const limit = params.limit || 10;
  const sortDir = params.sort === 'bottom' ? 'ASC' : 'DESC';

  const result = await ctx.query('inventory-db', `
    SELECT TOP ${limit}
      ${dim.column} AS dimension,
      SUM(od.Revenue) AS total_revenue,
      COUNT(DISTINCT od.OrderID) AS order_count
    FROM dbo.OrderDetails od
    ${dim.join}
    ${params.dateFrom ? `WHERE od.OrderDate >= '${params.dateFrom}' AND od.OrderDate <= '${params.dateTo}'` : ''}
    GROUP BY ${dim.column}
    ORDER BY total_revenue ${sortDir}
  `);

  return result;
}
```

### Why Two Layers?

The recipe metadata is what makes scripts **findable, matchable, and validatable** without reading or executing the script itself. Think of it as the index card in a library catalog — you don't need to read the book to know if it's relevant.

The script file is where **flexibility lives** — client-specific business logic, multi-source joins, conditional queries, post-processing transforms. Things that a pure SQL template cannot express.

---

## 4. ScriptContext — The Controlled Runtime

### What ScriptContext Provides

`ScriptContext` is the only interface a script has to the outside world. It provides a small, controlled API that handles all infrastructure concerns:

```typescript
interface ScriptContext {
  // Query a data source by its ID — handles connection, execution, error propagation
  query(sourceId: string, sql: string, params?: Record<string, any>): Promise<QueryResult>;

  // Query the federation DuckDB (for cross-source JOINs)
  federation(sql: string): Promise<QueryResult>;

  // Access script parameters (extracted from user question)
  params: ScriptParams;

  // Current date/time (for date-relative queries like "last month")
  now: Date;
}

interface QueryResult {
  data: any[];
  count: number;
  metadata?: {
    executionTime?: number;
    truncated?: boolean;
    totalCount?: number;
  };
}

type ScriptParams = Record<string, string | number | boolean | null>;
```

### What ScriptContext Handles (So Scripts Don't Have To)

| Concern | ScriptContext handles it | Script doesn't touch it |
|---|---|---|
| Source connections | `ctx.query(sourceId, ...)` acquires and releases connections | No imports, no connect/disconnect |
| SQL dialect | ScriptContext knows the source type, applies dialect rules | Script writes standard SQL |
| Row limits | ScriptContext enforces max rows per query automatically | Script doesn't need LIMIT safety nets |
| Error handling | ScriptContext catches SQL errors, returns structured error | Script doesn't need try/catch |
| Parameterized queries | ScriptContext handles parameter binding securely | Script passes params object |
| Timeouts | ScriptContext enforces execution timeout per query | Script doesn't manage timeouts |
| Logging | ScriptContext logs all queries, execution times, results | Script doesn't need logger imports |

### Security: A Controlled Sandbox

Because scripts only interact through `ScriptContext`, the attack surface is constrained:

- **No filesystem access** — `ScriptContext` doesn't expose `fs`
- **No network access** — `ScriptContext` doesn't expose `http` or `fetch`
- **No process access** — `ScriptContext` doesn't expose `process` or `child_process`
- **No arbitrary imports** — scripts import only `ScriptContext` types
- **Query-only database access** — `ctx.query()` can enforce read-only mode

The script runtime can additionally:
- Run scripts in a V8 isolate or Node.js `vm` module with restricted globals
- Enforce execution time limits (kill scripts that run too long)
- Enforce memory limits (prevent unbounded data accumulation)

This gives scripts the flexibility of code (loops, conditionals, transforms) without the security risks of arbitrary code execution.

---

## 5. What Scripts Can Do That Pure SQL Templates Cannot

### 1. Client-Specific Business Logic

```typescript
// BlueLinx: custom overstock calculation
// Rule: Do NOT subtract committed inventory from on-hand (per client meeting 2026-04-09)
// Rule: Include consignment demand in demand calculation
// Rule: Only SO + RM sales types (SalesTypeFK filtering pending)
export async function getOverstock(ctx: ScriptContext, params: ScriptParams) {
  const inventory = await ctx.query('bluelinx-mssql', `
    SELECT i.ProductID, i.ProductName, i.OnHand, i.Committed,
           d.AvgMonthlyDemand, d.ConsignmentDemand
    FROM dbo.InventoryMaster i
    JOIN dbo.DemandHistory d ON i.ProductID = d.ProductID
    WHERE i.StockType IN ('STK')
  `);

  // BlueLinx-specific overstock formula:
  //   Overstock = OnHand - (AvgMonthlyDemand + ConsignmentDemand) * 3 months
  //   NOTE: Do NOT subtract Committed from OnHand
  return {
    data: inventory.data.map(row => ({
      ...row,
      totalDemand: (row.AvgMonthlyDemand + row.ConsignmentDemand) * 3,
      overstockQty: row.OnHand - ((row.AvgMonthlyDemand + row.ConsignmentDemand) * 3),
    })).filter(row => row.overstockQty > 0),
    count: inventory.count,
  };
}
```

A SQL template can't encode "don't subtract committed" as a business rule with a comment explaining WHY. The script preserves this institutional knowledge.

### 2. Multi-Source Joins in Code

```typescript
// Compare sales actuals (MSSQL) against planning targets (PostgreSQL)
export async function getSalesVsTarget(ctx: ScriptContext, params: ScriptParams) {
  const actuals = await ctx.query('sales-mssql', `
    SELECT ProductID, SUM(Revenue) as ActualRevenue
    FROM dbo.OrderDetails
    WHERE OrderDate >= '${params.dateFrom}' AND OrderDate <= '${params.dateTo}'
    GROUP BY ProductID
  `);

  const targets = await ctx.query('planning-postgres', `
    SELECT product_id, target_revenue
    FROM sales_targets
    WHERE fiscal_year = ${params.year}
  `);

  // Join across sources in code
  const merged = actuals.data.map(actual => {
    const target = targets.data.find(t => t.product_id === actual.ProductID);
    return {
      productId: actual.ProductID,
      actual: actual.ActualRevenue,
      target: target?.target_revenue || 0,
      variance: actual.ActualRevenue - (target?.target_revenue || 0),
      variancePct: target?.target_revenue
        ? ((actual.ActualRevenue - target.target_revenue) / target.target_revenue * 100).toFixed(1)
        : null,
    };
  });

  return { data: merged, count: merged.length };
}
```

This queries two different database engines and joins the results with business logic (variance calculation). A SQL template is limited to a single source. The federation DuckDB could handle cross-source JOINs, but the variance percentage calculation and null handling are easier to express in code.

### 3. Conditional Queries (Smart Drilldown)

```typescript
// First get summary, then drill into anomalies if found
export async function getSmartInventoryCheck(ctx: ScriptContext, params: ScriptParams) {
  const summary = await ctx.query('inventory-db', `
    SELECT WarehouseName, SUM(OnHand) as TotalStock,
           SUM(OnHand * UnitCost) as StockValue,
           AVG(DaysOnHand) as AvgDaysOnHand
    FROM dbo.InventorySnapshot
    GROUP BY WarehouseName
  `);

  // Only drill down into warehouses with aging stock
  const anomalies = summary.data.filter(row => row.AvgDaysOnHand > 90);

  if (anomalies.length > 0) {
    const warehouseNames = anomalies.map(a => `'${a.WarehouseName}'`).join(',');
    const details = await ctx.query('inventory-db', `
      SELECT WarehouseName, ProductName, OnHand, DaysOnHand, UnitCost,
             OnHand * UnitCost as StockValue
      FROM dbo.InventoryDetail
      WHERE WarehouseName IN (${warehouseNames}) AND DaysOnHand > 90
      ORDER BY StockValue DESC
    `);

    return {
      data: {
        summary: summary.data,
        anomalies: details.data,
        anomalyCount: anomalies.length,
      },
      count: summary.count,
    };
  }

  return { data: { summary: summary.data, anomalies: [], anomalyCount: 0 }, count: summary.count };
}
```

The second query's WHERE clause depends on the first query's results. This conditional logic cannot be expressed in a SQL template — it requires control flow.

### 4. Data Enrichment and Formatting

```typescript
// Add computed fields and business categorizations
export async function getInventoryHealth(ctx: ScriptContext, params: ScriptParams) {
  const raw = await ctx.query('inventory-db', `
    SELECT ProductID, ProductName, OnHand, ReorderPoint,
           AvgMonthlySales, UnitCost, LastReceiptDate
    FROM dbo.InventoryMaster
    WHERE IsActive = 1
  `);

  return {
    data: raw.data.map(row => ({
      ...row,
      stockValue: row.OnHand * row.UnitCost,
      monthsOfSupply: row.AvgMonthlySales > 0
        ? (row.OnHand / row.AvgMonthlySales).toFixed(1)
        : 'No sales',
      // Business categorization
      healthStatus:
        row.OnHand <= 0 ? 'Out of Stock' :
        row.OnHand < row.ReorderPoint ? 'Below Reorder' :
        row.OnHand > row.ReorderPoint * 3 ? 'Overstocked' :
        'Healthy',
      daysSinceLastReceipt: Math.floor(
        (ctx.now.getTime() - new Date(row.LastReceiptDate).getTime()) / 86400000
      ),
    })),
    count: raw.count,
  };
}
```

The `healthStatus` categorization is business logic that changes per client. Scripts let you encode it once, document it with comments, and reuse it across all related questions about inventory health.

---

## 6. Script Generation — Why It's No Harder Than SQL Generation

### What the LLM Actually Generates

The LLM generates a script that is structurally always the same:

```typescript
export async function getData(ctx: ScriptContext, params: ScriptParams) {
  // 1. One or more ctx.query() calls  ← THIS IS SQL (LLM already does this)
  // 2. Optional: data transformation   ← Simple map/filter/reduce
  // 3. Return result                   ← Always the same shape
}
```

The hard part — writing correct SQL for the right tables with the right columns — is identical to what the SourceAgent already does today. The wrapper (`ctx.query`, parameter destructuring, return statement) is boilerplate that follows a fixed pattern.

### Generation Prompt Is Simpler

Instead of the complex SourceAgent prompt (schema search, SQL rules, retry logic, follow-up rules), the script generation prompt is:

```
You are generating a data script. You have access to these data sources:

Source "inventory-db" (MSSQL):
  [schema details...]

Source "planning-db" (PostgreSQL):
  [schema details...]

Write a script function that answers: "{{user_question}}"

The function signature is always:
  export async function getData(ctx: ScriptContext, params: ScriptParams)

Available methods:
  ctx.query(sourceId, sql, params?) — query a data source
  ctx.federation(sql) — cross-source DuckDB query
  ctx.now — current date

Return { data: any[], count: number }

Parameters available: {{extracted_params}}
```

The LLM doesn't need to know about retries, tool calling, streaming, or iteration limits. It writes a function. One shot.

### Error Recovery Is Simpler Too

If the generated script has a SQL error:
1. Execute the script
2. `ctx.query()` returns the SQL error
3. Pass the error back to the LLM: "This SQL in your script failed: [error]. Fix the script."
4. LLM regenerates the script (not just the SQL — the whole function, which is cheap since it's small)

This is simpler than the current SourceAgent retry loop because there's no tool-calling state machine to manage.

---

## 7. How the Flow Works

### Flow When a Script Exists (Deterministic Path)

```
User: "Show me top 5 regions by revenue this quarter"
                     |
                     v
         ┌─────────────────────────┐
         │  1. Script Matching      │  Embedding similarity search against script recipes
         │     (No LLM call)       │  Match: "revenue-by-dimension" (similarity: 0.94)
         └──────────┬──────────────┘
                    |
                    v
         ┌─────────────────────────┐
         │  2. Parameter            │  LLM extracts params from question + recipe definition
         │     Extraction           │  {dimension: "region", limit: 5, sort: "DESC",
         │     (1 small LLM call)  │   dateFrom: "2026-01-01", dateTo: "2026-03-31"}
         └──────────┬──────────────┘
                    |
                    v
         ┌─────────────────────────┐
         │  3. Schema Validation    │  Check that tables in recipe still exist
         │     (No LLM call)       │  with expected columns. If invalid -> fallback
         └──────────┬──────────────┘
                    |
                    v
         ┌─────────────────────────┐
         │  4. Execute Script       │  Run getData(ctx, params) with ScriptContext
         │     (No LLM call)       │  ScriptContext handles connections, execution
         └──────────┬──────────────┘
                    |
                    v
         ┌─────────────────────────┐
         │  5. Analysis             │  LLM analyzes the returned data
         │     (1 LLM call)        │  Generates insights, summary text
         └──────────┬──────────────┘
                    |
                    v
         ┌─────────────────────────┐
         │  6. Component Assembly   │  Use recipe's componentType + columnMappings
         │     (No LLM call)       │  Deterministic — no component generation LLM call
         └──────────┬──────────────┘
                    |
                    v
              Return Response

Total LLM calls: 2 (parameter extraction + analysis)
Compare to current: 4-8 LLM calls
```

### Flow When No Script Matches (Fallback + Script Creation)

```
User: "What's the correlation between humidity and product returns?"
                     |
                     v
         ┌─────────────────────────┐
         │  1. Script Matching      │  No script above similarity threshold
         │     (No LLM call)       │
         └──────────┬──────────────┘
                    |
                    v
         ┌─────────────────────────┐
         │  2. Current Agent Flow   │  MainAgent -> SourceAgent(s) -> SQL -> Analysis
         │     (4-8 LLM calls)    │  Same pipeline as today — proven, reliable
         └──────────┬──────────────┘
                    |
                    v
         ┌─────────────────────────┐
         │  3. Script Generation    │  Extract: source, tables, successful SQL, params
         │     (1 LLM call)        │  LLM wraps successful SQL into a script function
         │                         │  with parameterized variations
         └──────────┬──────────────┘
                    |
                    v
         ┌─────────────────────────┐
         │  4. Store Script +       │  Save .ts file + recipe metadata
         │     Recipe Metadata     │  Index with embedding for future matching
         │     (No LLM call)       │
         └──────────┬──────────────┘
                    |
                    v
              Return Response (from step 2)

Total LLM calls: 5-9 (agent flow + script creation)
But every future similar question: 2 LLM calls
```

### Flow for Multi-Source Questions

```
User: "Compare our actual sales against plan targets"
                     |
                     v
         ┌─────────────────────────┐
         │  1. Match                │  Finds "sales-vs-target" script
         └──────────┬──────────────┘
                    |
                    v
         ┌─────────────────────────┐
         │  2. Extract Params       │  {year: 2026, dateFrom: "2026-01-01", ...}
         └──────────┬──────────────┘
                    |
                    v
         ┌─────────────────────────┐
         │  3. Execute Script       │  Script internally:
         │                         │    ctx.query('sales-mssql', ...)     → actuals
         │                         │    ctx.query('planning-postgres', ...)→ targets
         │                         │    Join + variance calculation in code
         └──────────┬──────────────┘
                    |
                    v
         ┌─────────────────────────┐
         │  4. Analyze + Render     │
         └─────────────────────────┘

The script handles multi-source orchestration. No MainAgent routing needed.
No SourceAgent per source. Just direct queries through ScriptContext.
```

---

## 8. Script Matching and Parameter Extraction

### Matching: How to Find the Right Script

Script matching uses a two-stage approach:

**Stage 1: Embedding Similarity (fast, coarse)**
- Embed the user question using the same embedding model used for conversation search
- Search against all script recipe embeddings (stored in ChromaDB or in-memory index)
- Return top 5 candidates above a minimum similarity threshold (e.g., 0.75)

**Stage 2: Intent Pattern Matching (precise, confirmatory)**
- For each candidate, check if the user question matches any of its `intentPatterns`
- Patterns use simple wildcards: `"top * by revenue"` matches "top 10 products by revenue"
- Scoring:
  - Embedding > 0.85 AND pattern match -> **high confidence** (use script directly)
  - Embedding > 0.85 AND no pattern match -> **medium confidence** (use script, validate result)
  - Embedding 0.75-0.85 AND pattern match -> **medium confidence** (use script, validate result)
  - Below both thresholds -> **no match** (fall back to agent flow)

**Fallback**: If no script scores above threshold, fall back to the current agent pipeline. The successful result then creates a new script.

### Parameter Extraction

Once a script is matched, extract parameter values from the user question. This is a focused, constrained LLM call — much cheaper and more reliable than open-ended SQL generation:

```
System: Extract parameters for the "Revenue by Dimension" script.

Parameters:
- dimension (enum: product, category, region) [default: product]
- limit (number) [default: 10]
- sort (enum: top, bottom) [default: top]
- dateFrom (date, optional)
- dateTo (date, optional)

User question: "Show me top 5 regions by revenue this quarter"
Current date: 2026-04-16

Extract the parameter values as JSON.
```

Response:
```json
{
  "dimension": "region",
  "limit": 5,
  "sort": "top",
  "dateFrom": "2026-01-01",
  "dateTo": "2026-03-31"
}
```

This is a simple structured extraction task. The LLM has a constrained output space (specific enum values, numbers, dates) and clear instructions. First-attempt success rate is near 100%. This call can use a smaller, cheaper model (e.g., Haiku).

---

## 9. Script Lifecycle

### Creation

Scripts are created automatically after the agent pipeline successfully answers a new type of question:

1. Agent pipeline completes successfully (data returned, analysis generated, components built)
2. System extracts from the successful execution:
   - Source ID(s) and tables queried
   - The SQL queries that succeeded
   - Parameters that could vary (detected from the SQL and user intent)
   - Component type and configuration used
3. A focused LLM call wraps the successful SQL into a parameterized script function
4. The script file is written and the recipe metadata is stored with the original question's embedding

### Validation

Before executing a script, validate that the data sources it depends on are still compatible:

```typescript
async function validateScript(recipe: ScriptRecipe, sourceManager: SourceManager): Promise<boolean> {
  for (const sourceId of recipe.sources) {
    const source = sourceManager.getSource(sourceId);
    if (!source || !source.isConnected()) return false;

    const schema = source.getSchema();
    if (!schema) return false;

    // Check that tables referenced by this script still exist
    const scriptTables = recipe.tables.filter(t => t.startsWith(sourceId));
    for (const tableName of scriptTables) {
      const entity = schema.entities.find(e =>
        e.name === tableName || e.fullName === tableName
      );
      if (!entity) return false;
    }
  }

  return true;
}
```

If validation fails:
1. Script is marked as `stale`
2. System falls back to the agent pipeline for this question
3. The agent pipeline's successful result regenerates the script
4. The updated script replaces the stale one

### Quality Tracking

Every script recipe tracks `successCount` and `failureCount`:

- **Success**: Script executed, returned data, user didn't immediately rephrase the question
- **Failure**: Script threw an error, returned empty data when data was expected, or user rephrased

Scripts with a failure rate above 20% are automatically **demoted** — the system falls back to the agent pipeline even when the script matches. The agent pipeline's result is used to regenerate the script.

### Per-Client Scripts

Scripts can be tagged as client-specific. When a client has custom business logic (like BlueLinx's overstock calculation), their scripts are:
- Only matched for that client's project
- Manually reviewable and editable by the engineering team
- Not subject to automatic consolidation (business rules shouldn't be merged)

### Retirement

Scripts that haven't been used in 90 days are archived. They remain searchable for reference but are not used for matching. Consolidated scripts that supersede individual scripts cause the originals to be retired.

---

## 10. Consolidation Strategy

### What Consolidation Means for Scripts

Consolidation is the process of merging multiple similar scripts into a single, more general script that handles all of their use cases through parameters. The goal is to keep the script library manageable and improve match quality.

### When Consolidation Is Tractable

Scripts that share the same base SQL pattern with different dimensions, filters, or aggregations are good consolidation candidates:

```
Script A: "top products by revenue"
  → ctx.query('inv-db', `SELECT TOP 10 p.ProductName, SUM(od.Revenue) ... GROUP BY p.ProductName`)

Script B: "top categories by revenue"
  → ctx.query('inv-db', `SELECT TOP 10 c.CategoryName, SUM(od.Revenue) ... GROUP BY c.CategoryName`)

Script C: "top regions by revenue"
  → ctx.query('inv-db', `SELECT TOP 10 r.RegionName, SUM(od.Revenue) ... GROUP BY r.RegionName`)

Consolidated:
  → A single script with a dimension parameter that controls the SELECT, JOIN, and GROUP BY
```

### When Consolidation Should Not Happen

**Client-specific business logic scripts** should never be merged:

```
Script: "BlueLinx overstock calculation"
  → Custom formula, custom filters, client-specific rules in comments
  → This stays as-is. Business rules are not parameterizable.
```

**Scripts with different post-processing logic** should stay separate even if their SQL looks similar:

```
Script A: "inventory value" → returns raw totals
Script B: "inventory health" → returns totals + computed healthStatus categorization

These have similar SQL but different business meaning. Don't merge.
```

### How Consolidation Works

**Step 1: Group by Source + Base Tables**

Scripts that query the same source and share at least one table are candidates.

**Step 2: Compare SQL Patterns**

Extract the SQL from each script's `ctx.query()` calls. Use structural comparison (not string comparison) to identify:
- Same FROM/JOIN structure with different SELECT/GROUP BY → dimension parameter
- Same query with different WHERE clauses → filter parameter
- Same query with different ORDER BY / LIMIT → sort/limit parameter

**Step 3: Generate Consolidated Script**

An LLM call merges the scripts into a single parameterized function. The prompt includes all original scripts so the LLM can see the patterns.

**Step 4: Validate**

Run the consolidated script with each original question's parameters. Verify it produces the same results. If any test fails, keep the individual scripts.

**Step 5: Update**

Replace individual scripts with the consolidated version. Merge all intent patterns and embeddings from the originals into the new recipe metadata.

### Consolidation is Periodic, Not Real-Time

Consolidation runs as a background job (weekly), not on every request:
- No runtime performance impact
- Failed consolidation doesn't affect live scripts
- Results can be reviewed before deployment
- Client-specific scripts are excluded automatically

---

## 11. Component Generation with Scripts

### Current Problem

Today, component generation is a separate LLM call that reads the analysis text and tool results, then generates component JSON. This is expensive and non-deterministic — the same data might get a BarChart one time and a DataTable the next.

### Script-Based Components

Each script recipe stores its presentation configuration:

```typescript
{
  componentType: "BarChart",
  columnMappings: {
    "dimension": "{{dimension}}",       // label adapts to the parameter value
    "total_revenue": "Revenue ($)",
    "order_count": "Order Count"
  },
  componentConfig: {
    xAxis: "dimension",
    yAxis: "total_revenue",
    orientation: "horizontal",
    showDataLabels: true
  }
}
```

When a script is used, component assembly is **deterministic**:

1. Execute the script -> get data with known column structure
2. Take the recipe's `componentType` and `componentConfig`
3. Map SQL result columns to display labels using `columnMappings`
4. Register any SQL in the query cache (for security, same as current `queryId` pattern)
5. Build the component JSON directly — no LLM call needed

**This eliminates the component generation LLM call entirely for script-matched questions.**

### Multi-Component Scripts

Scripts that return structured data (like the smart drilldown example) can have multiple component definitions:

```typescript
{
  componentType: "MultiComponentContainer",
  components: [
    {
      dataKey: "summary",              // maps to result.data.summary
      type: "DataTable",
      config: { title: "Warehouse Summary" }
    },
    {
      dataKey: "anomalies",            // maps to result.data.anomalies
      type: "DataTable",
      config: { title: "Aging Stock Details", conditional: "anomalyCount > 0" }
    }
  ]
}
```

### Adaptive Components

If the user explicitly requests a different visualization ("show that as a pie chart"), the parameter extraction step detects the visualization preference and overrides the recipe's default `componentType`. This is still deterministic — no component generation LLM call needed.

---

## 12. Cost Comparison: Current vs Scripts

### LLM API Calls Per Question

| Scenario | Current Agent Flow | Script Flow |
|---|---|---|
| First question (no script exists) | 4-8 calls | 5-9 calls (agent + script creation) |
| Repeat exact question | 0 (semantic cache) | 0 (semantic cache) |
| Related follow-up (script exists) | 4-8 calls | **2 calls** |
| Same type, different params | 4-8 calls | **2 calls** |
| Multi-source question (script exists) | 6-12 calls | **2 calls** |
| 5-question conversation (after warmup) | 20-40 calls | **8-11 calls** |

### Cost for a Typical Conversation (5 Related Questions)

**Current architecture:**
```
Q1: 6 calls (schema search + SQL + retry + analysis + components)
Q2: 6 calls (same work repeated)
Q3: 7 calls (same work repeated)
Q4: 5 calls (same work repeated)
Q5: 7 calls (same work repeated)
Total: 31 LLM calls
```

**Script architecture (after Q1 creates the script):**
```
Q1: 7 calls (agent flow + script creation)
Q2: 2 calls (param extraction + analysis) ← script matched
Q3: 2 calls (param extraction + analysis) ← script matched
Q4: 2 calls (param extraction + analysis) ← script matched
Q5: 2 calls (param extraction + analysis) ← script matched
Total: 15 LLM calls (52% reduction)
```

**Script architecture (script already existed from a previous conversation):**
```
Q1: 2 calls (param extraction + analysis)
Q2: 2 calls (param extraction + analysis)
Q3: 2 calls (param extraction + analysis)
Q4: 2 calls (param extraction + analysis)
Q5: 2 calls (param extraction + analysis)
Total: 10 LLM calls (68% reduction)
```

### Additional Savings

| Aspect | Current | Scripts |
|---|---|---|
| Schema discovery (search_schema) | 1-3 LLM calls per source per question | **0** (script knows the tables) |
| SQL retries | ~30-50% of queries need retry | **0** (script has proven SQL) |
| Component generation | 1 LLM call per question | **0** (recipe metadata) |
| Source routing | LLM reasons each time | **0** (script knows the source) |

### Reliability

| Aspect | Current | Scripts |
|---|---|---|
| Deterministic for known question types | No | **Yes** |
| Same question → same SQL | No (LLM may vary) | **Yes** (script is fixed) |
| Same question → same component | No (LLM may vary) | **Yes** (recipe metadata) |
| First-attempt SQL success | ~50-60% | **~99%** (proven SQL in script) |
| Schema drift detection | Fails at runtime | **Validates before execution** |
| Client-specific logic preserved | No (rediscovered each time) | **Yes** (encoded in script) |

---

## 13. Migration Path

### Phase 1: ScriptContext + Script Runner (Foundation)

Build the `ScriptContext` runtime and script execution infrastructure. Define the script file format and recipe metadata schema. At this stage, scripts are created manually from known, high-frequency question patterns.

**Deliverables:**
- `ScriptContext` class with `query()` and `federation()` methods
- Script runner that loads and executes `.ts` script files in a sandboxed context
- Recipe metadata storage (database table or JSON files)
- Manual script creation tooling

**Expected impact:** Validate the architecture with a few hand-crafted scripts for the highest-volume question types.

### Phase 2: Script Matching + Parameter Extraction

Build the retrieval layer that matches user questions to existing scripts and extracts parameters. Integrate into the main `get_agent_user_response` flow as a fast-path before the agent pipeline.

**Deliverables:**
- Embedding index for script recipes (ChromaDB collection or in-memory HNSW)
- Intent pattern matching engine
- Parameter extraction LLM prompt and call
- Integration into `agent-user-response.ts` as Step 1.5 (after semantic cache, before agent)

**Expected impact:** 40-50% cost reduction for questions that match existing scripts.

### Phase 3: Automatic Script Creation

After every successful agent pipeline execution, automatically generate a script from the results. The LLM wraps successful SQL into a parameterized function. New scripts are validated before being added to the store.

**Deliverables:**
- Post-execution script generation pipeline
- Script validation (execute with original params, verify same results)
- Recipe metadata auto-generation (embedding, intent patterns, tags)

**Expected impact:** Script coverage grows organically. After 2-4 weeks of usage per client, 60-70% of questions match existing scripts. Cost reduction reaches 50-60%.

### Phase 4: Component Recipes

Extend script recipes with component configurations so that matched questions skip the component generation LLM call entirely. Components are assembled deterministically from recipe metadata.

**Deliverables:**
- Component configuration in recipe metadata
- Deterministic component assembly from script results + recipe config
- Adaptive component override (user requests specific visualization)

**Expected impact:** Eliminates 1 LLM call per script-matched question. Total cost reduction for script-matched questions: ~75%.

### Phase 5: Consolidation

Implement the periodic consolidation job that groups and merges related scripts. This reduces the script count, improves matching accuracy, and creates more broadly applicable scripts.

**Deliverables:**
- Script grouping by source + tables
- SQL pattern comparison and parameterization
- Consolidated script generation and validation
- Client-specific script exclusion

**Expected impact:** Script store stays manageable. Match quality improves. Long-term cost reduction stabilizes at 60-70%.

---

## 14. Pain Points: Scripts vs Current Multi-Agent Flow

This section documents the concrete implementation challenges of the script-based architecture compared to the current multi-agent approach. These are real trade-offs, not theoretical concerns — each is traced to specific code and behavior in the existing system.

### Pain Point 1: Script Creation From a Messy Agent Conversation

**The problem**: The current agent flow that produces successful SQL is a back-and-forth LLM conversation — not a clean linear path. A typical SourceAgent execution looks like:

```
LLM: search_schema(["inventory", "stock"])        → finds 8 tables
LLM: search_schema(["demand", "sales"])            → finds 5 more tables
LLM: executes SQL → ERROR: column "StockQty" not found
LLM: search_schema(["inventory master columns"])   → finds correct column "OnHandQty"
LLM: executes corrected SQL → SUCCESS (45 rows)
LLM: follow-up query for demand data → SUCCESS (30 rows)
```

To create a script from this, we need to extract:
- The **final working SQL** (not the failed attempts)
- Which **tables and columns** actually worked
- The **follow-up query** as a second `ctx.query()` call
- Any **post-processing** the MainAgent did on the combined results

**Why it's hard**: The successful SQL is buried inside `executedTools[].params.sql` (from `source-agent.ts` `allExecutedTools`). But the *intent* behind it — why those tables, why that JOIN — is in the LLM's unstructured reasoning text mixed with streaming markers. The script creation LLM must reconstruct a clean parameterized function from scattered pieces.

What `allExecutedTools` gives us:

```typescript
executedTool = {
  id: this.tool.id,
  name: this.tool.name,
  params: cappedInput,           // has the raw SQL
  result: { _sampleData, ... },  // has sample output
  sourceSchema: this.tool.description,
  sourceType: this.extractSourceType(),
};
```

We have the raw SQL and sample data, but we DON'T have:
- Which values in the SQL should be parameters vs hardcoded constants
- What the JOIN logic means semantically (why this JOIN and not another)
- Whether WHERE clause values are user-specific or universal business rules
- How primary and follow-up queries relate to each other logically

The LLM that creates the script must infer all of this from raw SQL + the original user question. It will sometimes get the parameterization wrong — hardcoding values that should be parameters, or parameterizing values that should be hardcoded.

**Severity**: Medium — solvable but imperfect. Expect ~70-80% of auto-generated scripts to be correctly parameterized on first attempt.

---

### Pain Point 2: The Adaptation Gap — When a Script Is a 70% Match

**The problem**: User asks "Show me overstock by warehouse for products received in the last 60 days." We have a script for "overstock by warehouse" but it doesn't have a "days since receipt" filter.

**The current agent flow handles this perfectly** — the SourceAgent writes fresh SQL with the extra WHERE clause. No problem.

**With scripts, there are 3 options, all problematic:**

**Option A: Fall back to agent flow.** Defeats the purpose. If 30-40% of questions hit this gap, we're only saving cost on 60-70% of questions, and every fallback is the full 4-8 LLM call cost.

**Option B: Modify the script's SQL at runtime.** This means an LLM call to adapt the script's SQL template with the extra filter. Now we're back to LLM-generated SQL, just with more context. The cost saving is marginal compared to the full agent flow.

**Option C: Pre-build scripts with every possible filter combination.** Combinatorial explosion. A script for "overstock by warehouse" could be filtered by date, product category, stock type, supplier, region, or any combination. We can't pre-build all permutations.

**The real cost**: Every new dimension a user adds to a question that doesn't perfectly match an existing script either triggers a full agent fallback or requires script modification. This is the most common case — users rarely ask the exact same structured question twice. They iterate and explore.

**Severity**: **High** — this is the biggest risk to the cost savings model. The adaptation gap determines whether scripts save 30% or 70% of costs.

---

### Pain Point 3: Multi-Source Scripts Need Hardcoded Source IDs

**The problem**: The current `SourceManager` assigns source IDs like `postgres-a1b2c3` (UUID-based) when sources are added to a project. A script that does:

```typescript
const sales = await ctx.query('mssql-f7e8d9', `SELECT ...`);
const targets = await ctx.query('postgres-a1b2c3', `SELECT ...`);
```

is hardcoded to specific source instances. This breaks when:

- A client disconnects and reconnects their database (new source ID)
- A source is removed and re-added during troubleshooting (new source ID)
- We want the same script to work across clients with similar database structures

**The current agent flow handles this naturally** — the MainAgent routes by reading source summaries at runtime. It doesn't depend on source IDs, it reasons about what data each source contains.

**Solution required**: A logical name mapping layer:
- Mapping table: `{ logicalName: "sales", sourceId: "mssql-f7e8d9" }`
- Scripts use logical names: `ctx.query('sales', ...)`
- The mapping must be maintained when sources change
- Someone (automated or manual) must create and maintain these mappings

**Severity**: Low — solvable with a mapping layer, but adds configuration complexity that doesn't exist today.

---

### Pain Point 4: Schema Drift Is Harder to Detect Than It Looks

**The problem**: The recipe metadata says `tables: ["dbo.OrderDetails", "dbo.Products"]`. Pre-execution validation checks these tables exist. But schema drift goes deeper than table existence.

**Case 1: Column Renamed**

`dbo.OrderDetails.Revenue` is renamed to `dbo.OrderDetails.TotalRevenue`. The table exists, validation passes, but the script's SQL fails at execution time.

To catch this pre-execution, we'd need to parse the SQL template and extract every column reference from SELECT, WHERE, JOIN ON, GROUP BY, and ORDER BY clauses. But script SQL has JavaScript template interpolation mixed in:

```sql
SELECT TOP {{limit}}
  ${dim.column} AS dimension,           -- dim.column is a RUNTIME variable
  SUM(od.Revenue) AS total_revenue      -- "Revenue" is hardcoded in SQL
FROM dbo.OrderDetails od
${dim.join}                              -- join clause is a RUNTIME variable
```

Extracting column names requires understanding both the JavaScript template logic AND the SQL grammar. This is significantly harder than parsing static SQL.

**Case 2: New Column Changes Semantics**

A new column `IsReturned` is added to `OrderDetails`. The existing script still runs successfully, but revenue numbers now include returned orders — which produces incorrect results. No automated validation can catch this because nothing technically broke.

**Case 3: Data Values Changed**

The script filters `WHERE StockType IN ('STK')`. The client adds a new stock type `'STK-CNS'` (consignment stock). The script still runs, but silently excludes consignment inventory from results. No validation catches this.

**How the current agent flow handles this**: The SourceAgent sees the live schema with sample values on every call. If `StockType` now shows `{STK|STK-CNS|NON-STK}` in the schema, the LLM includes the new value. Scripts are frozen at creation time and can't adapt to data evolution.

**Severity**: **High** — table-level validation is easy, column-level is hard, data-value drift is undetectable. Silent incorrect results are worse than loud errors.

---

### Pain Point 5: Streaming UX Changes Significantly

**The problem**: Today's user experience streams granular progress through `TaggedStreamBuffer` with markers the frontend parses:

```
🔍 Looking up tables: inventory, stock
📝 Generated SQL query: SELECT TOP 10 ...
⏳ Executing query... (live timer: 1.2s, 2.4s, 3.1s)
✅ 45 rows from Inventory DB
<DataTable>[preview]</DataTable>

📝 Follow-up query...
✅ 30 rows from Inventory DB

[Analysis text streams in real-time...]

📊 Generating visualization components...
[Components stream one by one via __ANSWER_COMPONENT_START__ markers]
```

This is driven by the SourceAgent's streaming state machine (`source-agent.ts:112-186`) — different emoji labels for retry vs follow-up (tracked via `querySucceeded` boolean), timer markers (`__QUERY_TIMER_START__`, `__QUERY_TIMER_DONE__`), and DataTable previews.

**With scripts**, the flow becomes:

```
[Matched script — extracting parameters...]     ← less interesting to watch
[Executing script...]                           ← one opaque step, no granularity
✅ Got data                                     ← done, no intermediate progress
[Analysis streams...]                           ← same as today
[Component assembled]                           ← instant, no streaming needed
```

For a script that queries 3 sources sequentially, the user waits with no progress indication. The solution is to add streaming hooks into `ScriptContext.query()`:

```typescript
async query(sourceId: string, sql: string, params?: any): Promise<QueryResult> {
  this.stream?.write(`📝 Querying ${this.getSourceName(sourceId)}...\n`);
  this.stream?.write(`__QUERY_TIMER_START_Executing query__`);
  const result = await source.execute({ sql, params });
  const seconds = ((Date.now() - startTime) / 1000).toFixed(1);
  this.stream?.write(`__QUERY_TIMER_DONE_${seconds}__\n`);
  this.stream?.write(`✅ ${result.count} rows from ${this.getSourceName(sourceId)}\n`);
  if (result.data.length > 0) {
    this.stream?.write(`<DataTable>${JSON.stringify(result.data.slice(0, 10))}</DataTable>\n`);
  }
  return result;
}
```

This is doable but means `ScriptContext` must carry the full streaming infrastructure — `StreamBuffer`, timer markers, DataTable formatting — that currently lives inside SourceAgent. The frontend marker protocol must be shared between both code paths.

**Severity**: Medium — solvable with engineering effort, but adds complexity to ScriptContext.

---

### Pain Point 6: Component Generation Isn't Always Deterministic

**The problem**: The recipe metadata says `componentType: "BarChart"`. But the right component depends on the actual data returned, not just the question type.

Consider the script "revenue by dimension":
- `dimension=product, limit=10` → BarChart makes sense (10 bars)
- `dimension=product, limit=100` → DataTable makes more sense (100-bar chart is unreadable)
- `dimension=region, limit=5` → PieChart might be better (few categories, part-of-whole relationship)
- Two dimensions queried → needs a grouped/stacked chart or multiple components

Today's component generation LLM (`dash-comp-picker` prompt) sees the actual data shape — row count, column types, cardinality — and picks accordingly. The current `generateAgentComponents()` function validates component SQL, retries on failure, and streams components one by one. Static component metadata in recipe can't adapt to data shape.

**Options:**

**Option A**: Rules in the recipe metadata — `if limit > 20 then DataTable else BarChart`. Gets complex quickly and reimplements what the LLM does naturally.

**Option B**: Keep the component generation LLM call for script-matched questions too. Erases one of the claimed cost savings.

**Option C**: Generate a "good enough" default component from the recipe and let users switch visualization type. Practical but lower quality than today for edge cases.

**Severity**: Medium — Option C is acceptable for most cases. The default component will be correct 80% of the time since the recipe was created from a successful component generation.

---

### Pain Point 7: Cold Start Problem Is Per-Client, Per-Source

**The problem**: Scripts accumulate through usage. A new client starts with zero scripts — every question goes through the full agent flow until scripts build up. The value proposition only kicks in after enough scripts exist.

**Timeline for a typical client:**
- Week 1: 0 scripts → 100% agent flow → same cost as today (or slightly higher due to script creation overhead)
- Week 2: ~20 scripts → ~30% script hits → 70% still agent flow
- Week 4: ~50 scripts → ~50% script hits → meaningful savings start
- Week 8: 100+ scripts → 60-70% script hits → target savings achieved

**The harder dimension**: Scripts are per-source. If Client A has an MSSQL inventory database with tables `dbo.InventoryMaster`, `dbo.OrderDetails` and Client B has a PostgreSQL database with tables `inventory_master`, `order_details`, Client A's scripts don't work for Client B — even if they ask identical questions. The SQL dialect, table names, column names, and JOIN patterns are all different.

Scripts cannot be pre-seeded across clients. Every client starts cold. Enterprise clients with 5+ data sources need scripts per source, multiplying the cold start period.

**Severity**: Medium — this is an accepted trade-off. The agent flow is a proven fallback. The question is how long until ROI-positive, which depends on question volume per client.

---

### Pain Point 8: Script Execution Errors Are Harder to Recover From

**The problem**: The current agent flow has built-in self-healing through the SourceAgent's retry loop. When SQL fails:

```
Query failed: "Conversion failed converting varchar to int"
SourceAgent LLM (same conversation): "StatusCode is varchar not int, need string comparison"
SourceAgent retries: WHERE StatusCode = '1' instead of = 1
→ Succeeds transparently, user never sees the error
```

This works because the error message goes back into the same `LLM.streamWithTools()` conversation in `source-agent.ts`, preserving full context — the schema, the original intent, the failed SQL, and the error.

**When a script fails**, there's no LLM conversation to recover within. The script has hardcoded SQL that either works or doesn't. Options:

**Option A: Fall back to agent flow.** User pays the full cost anyway, plus wasted time from the failed script execution. The failed script should be marked for regeneration.

**Option B: Pass the error to an LLM to fix the script.** This requires starting a NEW LLM conversation with: the script source code, the error message, the schema, and the original intent. This is roughly equivalent to a SourceAgent retry in cost, but with more setup overhead and less context (the LLM doesn't have the conversation history that led to the original SQL).

**Option C: Just fail and show the error.** Unacceptable UX — the current system retries transparently in most cases.

**Practical choice**: Option A (fall back to agent flow + mark script for regeneration) is the safest. But it means every script failure costs MORE than the current approach (failed script execution time + full agent flow cost).

**Severity**: Medium — fallback to agent flow is reliable, but script failures are more expensive than never having matched a script at all.

---

### Summary: Pain Point Severity Matrix

| # | Pain Point | Severity | Solvable? | Impact on Cost Savings |
|---|---|---|---|---|
| 1 | Script creation from messy agent output | Medium | Yes — LLM inference, ~70-80% accuracy | Minor — incorrect scripts get caught by quality tracking |
| 2 | **Adaptation gap (70% match)** | **High** | Partially — need hybrid strategy | **Major — determines 30% vs 70% savings** |
| 3 | Hardcoded source IDs | Low | Yes — logical name mapping layer | None — engineering effort only |
| 4 | **Schema drift beyond table existence** | **High** | Partially — column-level hard, data-value undetectable | **Major — silent incorrect results** |
| 5 | Streaming UX changes | Medium | Yes — streaming hooks in ScriptContext | Minor — engineering effort |
| 6 | Component generation not always deterministic | Medium | Partially — default + override | Minor — acceptable for 80% of cases |
| 7 | Cold start per client | Medium | Accepted — agent flow fallback | Moderate — delays ROI by 2-4 weeks |
| 8 | Error recovery harder | Medium | Yes — fallback to agent flow | Minor — rare once scripts stabilize |

**The two critical pain points are #2 (adaptation gap) and #4 (schema drift).** These are where scripts fundamentally trade the current system's flexibility for determinism. The current agent flow handles both naturally because the LLM sees live schema and writes fresh SQL every time. Scripts lock in a solution that may not fit future variations of the question or future states of the data.

Strategies for mitigating these two critical pain points should be designed before implementation begins.
