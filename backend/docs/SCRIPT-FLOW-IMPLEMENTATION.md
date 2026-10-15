# Script Flow — Implementation Plan

## Goal

Build a script flow that plugs into the existing `get_agent_user_response` pipeline. A saved script runs instead of the full multi-agent flow when a matching script exists. When no script matches, **MainAgent writes a new script** as part of its own turn (routing to SourceAgents for data, assembling code for any post-SQL transforms, executing in a subprocess, verifying, and saving).

Key principles:
- **The script is the agent's work product, not a post-hoc wrapper.** What runs is what gets saved.
- **Scripts are real `.ts` files** — subprocess execution via `tsx`, npm imports available, proper sandbox.
- **Post-SQL logic is first-class** — weighted averages, clustering, in-memory joins, normalization, etc., all live in the script.
- **Shared infrastructure** (ScriptContext, ScriptStore, ScriptMatcher, analysis, components) is reused across cached replay and fresh generation.

---

## What We're Building

### In Scope
- `ScriptContext` — the controlled runtime scripts execute against (ctx.query, ctx.now, ctx.emit for computed datasets)
- `ScriptStore` — persistent store: `scripts-store/<name>.ts` + `scripts-store/metadata/<name>.json`
- `ScriptMatcher` — one LLM call that picks the best script for a user prompt and extracts parameters
- **MainAgent as script author** — writes the draft, invokes SourceAgents for data, executes via subprocess, fixes if needed
- `ScriptRunner` — subprocess execution over `tsx`, NDJSON IPC for `ctx.query`
- Analysis LLM call on script results
- Lightweight component generator over `executedQueries` (per-source rendering)
- Embedding-based schema pre-resolve for large sources (independent optimization, still applies)
- Embedding-based source routing pre-filter for projects with ≥5 sources (independent optimization)

### Out of Scope (for now)
- Component recipes (skip component-gen LLM after first run — future)
- Long-lived child processes with `EVAL`/`INSPECT` for multi-turn script editing
- Per-client script tagging, approval workflow
- Script-embedding pre-filter for stores > 50 scripts

---

## File Structure

```
sdk-nodejs/src/userResponse/scripts/
  index.ts                    # re-exports
  script-store.ts             # ScriptStore — split-file layout (.ts body + metadata/*.json) + normalizeScriptBody
  script-matcher.ts           # ScriptMatcher — LLM-based matching + parameter extraction
  script-runner.ts            # ScriptRunner — spawn tsx child, IPC dispatcher, authorization, timeouts
  script-ipc.ts               # parent/child IPC message types + NDJSON helpers
  script-bootstrap.ts         # child entrypoint — imports user script, builds ctx, runs getData
  script-component-generator.ts   # lightweight component picker (reads executedQueries)
  types.ts                    # ScriptRecipe, ScriptParameter, ScriptResult, ScriptMatch

sdk-nodejs/src/userResponse/agents/
  main-agent.ts               # MainAgent — holds write_script/execute_script tools + per-turn scriptState
  types.ts                    # AgentResponse (with savedScript), AgentWrittenScript

sdk-nodejs/dist/userResponse/scripts/
  script-bootstrap.js         # built artifact the runner spawns via tsx

backend/scripts-store/        # persistent storage (runtime dir)
  <name>.ts                   # script body — `export async function getData(ctx, params) { ... }` — editable in IDE
  metadata/<name>.json        # recipe metadata (params, tables, counts, intent)
```

---

## Types (`types.ts`)

```typescript
import type { ExecutedToolInfo } from '../services/tool-executor-service';

/**
 * Recipe metadata — stored alongside each script for matching,
 * validation, and quality tracking.
 */
export interface ScriptRecipe {
  id: string;
  version: number;
  name: string;

  // MATCHING
  intentDescription: string;        // natural language description of what this script does
  embedding?: number[];             // semantic embedding of intentDescription
  tags: string[];                   // keyword tags for quick filtering

  // EXECUTION
  sourceIds: string[];              // which data sources this script queries
  tables: string[];                 // tables used (for future schema drift detection)

  // PARAMETERS (future — MVP scripts have hardcoded values)
  parameters: ScriptParameter[];

  // PRESENTATION (future — MVP uses current component generation)
  componentType?: string;
  columnMappings?: Record<string, string>;
  componentConfig?: Record<string, any>;

  // SCRIPT
  scriptBody: string;               // the actual script function body as a string

  // QUALITY TRACKING
  successCount: number;
  failureCount: number;
  lastUsed: string;                 // ISO timestamp
  createdFrom: string;              // original user question
  createdAt: string;
  updatedAt: string;
}

export interface ScriptParameter {
  name: string;
  type: 'string' | 'number' | 'date' | 'date_range' | 'enum' | 'boolean';
  required: boolean;
  default?: any;
  enumValues?: Record<string, string>;
  description: string;
}

/**
 * Result from executing a script via ScriptRunner.
 */
export interface ScriptResult {
  success: boolean;
  data: any[];
  executedQueries: ScriptQueryResult[];
  error?: string;
  executionTimeMs: number;
}

export interface ScriptQueryResult {
  sourceId: string;
  sourceName: string;
  sql: string;
  data: any[];
  count: number;
  totalCount?: number;
  executionTimeMs: number;
}

/**
 * Match result from ScriptMatcher.
 */
export interface ScriptMatch {
  recipe: ScriptRecipe;
  similarity: number;
  confidence: 'high' | 'medium' | 'low';
  extractedParams?: Record<string, any>;
}
```

---

## ctx — The Script Runtime (built in the child)

`ctx` is built inside `script-bootstrap.ts` — it is NOT a parent-side class. The child creates it after receiving the `INIT` message and passes it to `getData(ctx, params)`.

API the script sees:

```typescript
interface ScriptContext {
  /**
   * Query a data source. Sends a QUERY message to the parent over stdout and
   * awaits the matching QUERY_RESULT. The parent verifies `toolId` against the
   * authorized externalTools list before executing.
   */
  query(toolId: string, sql: string): Promise<{ data: any[]; count: number }>;

  /**
   * Register a computed dataset (e.g., weighted avg, clustering output) so it
   * flows into `executedQueries` alongside real SQL queries. The component
   * generator can render these just like real queries. sourceId is synthesized
   * as `computed:<name>`.
   */
  emit(name: string, rows: any[], meta?: { description?: string }): void;

  /** Forward a short progress message to the parent's StreamBuffer (UI continuity). */
  log(chunk: string): void;

  /** Frozen current-time Date — consistent within a single script execution. */
  readonly now: Date;
}
```

There is no `getQueryResults()` surface inside the child — executedQueries are accumulated internally and shipped in the `RESULT` message at the end. The parent's enrichment step fills in the real `sourceName` from the externalTool.

---

## ScriptStore (`script-store.ts`)

MVP: In-memory store backed by a JSON file per project. Can be upgraded to database later.

```typescript
import type { ScriptRecipe } from './types';
import { logger } from '../../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

export class ScriptStore {
  private recipes: Map<string, ScriptRecipe> = new Map();
  private storePath: string;

  constructor(projectId: string, baseDir?: string) {
    // Store scripts in a project-specific directory
    const dir = baseDir || path.join(process.cwd(), 'scripts-store');
    this.storePath = path.join(dir, `${projectId}.json`);
    this.loadFromDisk();
  }

  /**
   * Get all recipes.
   */
  getAll(): ScriptRecipe[] {
    return [...this.recipes.values()];
  }

  /**
   * Get a recipe by ID.
   */
  get(id: string): ScriptRecipe | null {
    return this.recipes.get(id) || null;
  }

  /**
   * Save a recipe (create or update).
   */
  save(recipe: ScriptRecipe): void {
    recipe.updatedAt = new Date().toISOString();
    this.recipes.set(recipe.id, recipe);
    this.saveToDisk();
    logger.info(`[ScriptStore] Saved script "${recipe.name}" (${recipe.id})`);
  }

  /**
   * Delete a recipe.
   */
  delete(id: string): void {
    this.recipes.delete(id);
    this.saveToDisk();
  }

  /**
   * Record success for a recipe.
   */
  recordSuccess(id: string): void {
    const recipe = this.recipes.get(id);
    if (recipe) {
      recipe.successCount++;
      recipe.lastUsed = new Date().toISOString();
      this.saveToDisk();
    }
  }

  /**
   * Record failure for a recipe.
   */
  recordFailure(id: string): void {
    const recipe = this.recipes.get(id);
    if (recipe) {
      recipe.failureCount++;
      recipe.lastUsed = new Date().toISOString();
      this.saveToDisk();
    }
  }

  // --- Persistence ---

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        for (const recipe of data.recipes || []) {
          this.recipes.set(recipe.id, recipe);
        }
        logger.info(`[ScriptStore] Loaded ${this.recipes.size} scripts from ${this.storePath}`);
      }
    } catch (err) {
      logger.warn(`[ScriptStore] Failed to load from disk: ${err}`);
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = { recipes: [...this.recipes.values()] };
      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.warn(`[ScriptStore] Failed to save to disk: ${err}`);
    }
  }
}
```

---

## ScriptMatcher (`script-matcher.ts`)

Uses an LLM call to match the user question against the script library. The LLM sees all script descriptions + parameters and picks the best match (or "none"). This is more accurate than embedding similarity because the LLM understands that "overstock by warehouse" and "revenue by warehouse" need different scripts even though they're semantically close.

One LLM call handles both matching AND parameter extraction — so we don't need a separate parameter extraction step.

### Why LLM over Embeddings

```
User: "Show me overstock by warehouse"

Embedding search (ChromaDB):
  1. "Top products by revenue"       — 0.82 similarity  ← WRONG (same domain, wrong intent)
  2. "Overstock by warehouse"        — 0.80 similarity  ← CORRECT but ranked lower
  3. "Inventory value by warehouse"  — 0.79 similarity  ← WRONG (same tables, different calc)

LLM matching:
  Sees all script descriptions → picks "Overstock by warehouse" 
  because it understands the calculation difference.
  Also extracts params: { limit: null, stockType: "STK" }
```

Embeddings capture topic similarity. LLM understands structural intent. For <50 scripts per project, sending the full list to an LLM is cheap and far more accurate.

When the script library grows past ~50, we'll add an embedding pre-filter (ChromaDB narrows to top 10 → LLM picks from those 10).

### Implementation

```typescript
import { LLM } from '../../llm';
import type { ScriptRecipe, ScriptMatch } from './types';
import type { ScriptStore } from './script-store';
import { logger } from '../../utils/logger';

export class ScriptMatcher {
  private store: ScriptStore;

  constructor(store: ScriptStore) {
    this.store = store;
  }

  /**
   * Find the best matching script for a user question.
   * Uses ONE LLM call that:
   *   1. Picks the right script (or "none")
   *   2. Extracts parameters for the matched script
   * Returns null if no script matches.
   */
  async match(
    userPrompt: string,
    apiKey?: string,
    model?: string
  ): Promise<ScriptMatch | null> {
    const recipes = this.store.getAll();
    if (recipes.length === 0) return null;

    // Filter out scripts with high failure rates
    const healthyRecipes = recipes.filter(r => {
      const total = r.successCount + r.failureCount;
      return total <= 5 || r.failureCount / total <= 0.2;
    });

    if (healthyRecipes.length === 0) return null;

    // Build the script catalog for the LLM
    const scriptCatalog = healthyRecipes.map((r, idx) => {
      const paramList = r.parameters.length > 0
        ? r.parameters.map(p => {
            let desc = `${p.name} (${p.type}`;
            if (!p.required) desc += ', optional';
            if (p.default !== undefined) desc += `, default: ${p.default}`;
            if (p.enumValues) desc += `, values: ${Object.keys(p.enumValues).join('/')}`;
            desc += `) — ${p.description}`;
            return `    - ${desc}`;
          }).join('\n')
        : '    (no parameters)';

      return `${idx + 1}. [${r.id}] "${r.name}"
   ${r.intentDescription}
   Parameters:
${paramList}`;
    }).join('\n\n');

    const systemPrompt = `You are a script matcher. Given the user's question and a library of available data scripts, determine:
1. Which script (if any) can answer this question
2. What parameter values to extract from the question for that script

Rules:
- Pick the script whose DATA RETRIEVAL matches what the user is asking for
- Do NOT pick a script just because it queries similar tables — the calculation/aggregation must match
- If no script can answer the question, return scriptId: "none"
- Extract parameter values from the user's question. Use defaults for unspecified parameters.
- For date parameters, interpret relative dates (e.g., "this quarter", "last month") relative to today

Return JSON only:
{
  "scriptId": "<script id or none>",
  "confidence": "high" | "medium" | "low",
  "params": { ... },
  "reasoning": "<1 sentence why this script matches or why none match>"
}`;

    const userMessage = `Today's date: ${new Date().toISOString().split('T')[0]}

Available scripts:
${scriptCatalog}

User question: "${userPrompt}"`;

    try {
      const response = await LLM.stream<any>(
        { sys: systemPrompt, user: userMessage },
        {
          model: model || undefined,
          maxTokens: 500,
          temperature: 0,
          apiKey,
        },
        true  // JSON mode
      );

      if (!response || response.scriptId === 'none') {
        logger.info(`[ScriptMatcher] No script matched. Reason: ${response?.reasoning || 'unknown'}`);
        return null;
      }

      if (response.confidence === 'low') {
        logger.info(`[ScriptMatcher] Low confidence match "${response.scriptId}" — skipping. Reason: ${response.reasoning}`);
        return null;
      }

      const recipe = this.store.get(response.scriptId);
      if (!recipe) {
        logger.warn(`[ScriptMatcher] LLM returned unknown script ID: ${response.scriptId}`);
        return null;
      }

      logger.info(`[ScriptMatcher] Matched "${recipe.name}" (confidence: ${response.confidence}). Reason: ${response.reasoning}`);

      return {
        recipe,
        similarity: response.confidence === 'high' ? 0.95 : 0.85,
        confidence: response.confidence,
        extractedParams: response.params || {},
      };

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[ScriptMatcher] LLM matching failed: ${msg}`);
      return null;
    }
  }
}
```

### Cost Justification

This matching call costs ~500 input tokens (script catalog) + ~100 output tokens. At Haiku pricing that's ~$0.0003 per match. The agent flow it replaces costs 3-6 LLM calls at ~$0.01-0.05 each. Net saving per script-matched question: **$0.03-0.15**.

Even at Sonnet pricing the matching call is ~$0.002 — still 10-50x cheaper than the agent flow.

---

## MainAgent as Script Author (replaces `ScriptGenerator`)

**There is no post-hoc script generator.** MainAgent writes the script itself during its turn, using two new tools in its tool-calling loop:

- `write_script(scriptBody: string)` — replaces the current draft.
- `execute_script()` — spawns the `tsx` subprocess, runs the script, returns `{ ok, sampleRows, executedQueries, error?, errorPhase? }`.

MainAgent's typical loop for a fresh question:

1. **Discovery** — dispatches SourceAgents as today. Each returns proven SQL + sample rows.
2. **Assemble** — calls `write_script` with a draft that wraps the proven SQL in `ctx.query()` calls and adds any post-SQL transforms the question needs (weighted avg, clustering, in-memory join, etc.).
3. **Execute** — calls `execute_script`.
4. **Verify** — judges whether the output satisfies the user's intent (one small LLM turn over `sampleRows` + the original question).
5. **Fix (if needed)** — rewrite via `write_script`, re-execute. Hard cap: 3 attempts.
6. **Analyze** — writes the user-facing answer over the script's final output.
7. **Save** — recipe + `.ts` body persisted via `ScriptStore.save()`.

The subprocess execution + IPC details are in `## ScriptRunner` and `## IPC Bridge` below. The obsolete single-shot LLM-wrapping generator was removed in favor of this design — it couldn't express post-SQL logic, routinely dropped `TOP N` parameterization, and misjudged multi-source composition.

### What MainAgent sees when judging "ok?"

```
Given the user question:  "..."
The script ran and returned:
  - executedQueries: [{ toolId, sql, sampleRows: [...], count }, ...]
  - transformedSample: first 5 rows of the script's final `data`
  - executionTimeMs: N

Does this output answer the user's question accurately?
{ ok: boolean, whatsWrong?: string }
```

If `ok: false`, `whatsWrong` feeds back into the next `write_script` prompt.

### Draft-pending semantics

A fresh script that hasn't succeeded is held in memory only. `ScriptStore.save()` is called ONCE — after a verified-correct execution. We do not save partial or failing drafts. If all 3 attempts fail, MainAgent falls back to answering from the raw `executedQueries` and nothing is saved.

---

## ScriptRunner (`script-runner.ts`)

Executes a script by spawning a `tsx` subprocess. The child runs the `.ts` file directly (no compile step); ctx.query calls are bridged to the parent over NDJSON on stdio. This replaces the old `new Function()` eval approach — it gives real sandbox isolation, real TypeScript, and npm imports.

### Shape

```typescript
export async function runScript(
  recipe: ScriptRecipe,          // or a draft body (for MainAgent's fix-loop)
  ctx: ScriptContextConfig,      // external tools, stream buffer, now
  params: Record<string, any> = {}
): Promise<ScriptResult>;
```

### Child lifecycle (single execution)

```
Parent                                              Child (tsx <scriptPath>)
────────────────────────────────────────────────────────────────────────────
spawn(tsxBinary, [scriptPath])                      starts, reads stdin
send: INIT { params, now }                  ───▶
                                                    builds ctx, calls getData(ctx, params)
                                            ◀───    QUERY { id, toolId, sql }
  verify toolId is authorized
  execute ExternalTool.fn(sql)
send: QUERY_RESULT { id, data, count }      ───▶
                                            ◀───    STREAM { chunk } (optional UI progress)
  streamBuffer.write(chunk)
                                            ◀───    RESULT { data, count, executedQueries, sampleRows, executionTimeMs }
  await child.exit(0)
  build ScriptResult, resolve
```

### Performance

- Cold-start: ~500–800ms (`npx tsx` resolution + compile).
- Mitigations:
  - Resolve the `tsx` binary once at SDK boot (`require.resolve('tsx/cli')`); `spawn` it directly. Saves ~200ms.
  - Precompile-on-save (future): `ScriptStore.save()` calls `esbuild` to emit a sibling `.js`; runner executes `node <path>.js`. Brings cold-start to ~150ms.
- Timeout: parent sends SIGKILL after 30s. IPC map is cleared; pending `ctx.query` promises reject.

### Error surfaces

- **Compile error** — tsx couldn't parse. Child exits 1, sends `ERROR { phase: "compile", message, stack }`. MainAgent treats this as "rewrite from scratch."
- **Runtime error** — thrown during `getData`. Child sends `ERROR { phase: "runtime", ... }`. MainAgent treats this as a targeted fix opportunity.
- **Unauthorized tool** — parent refuses a `QUERY` whose `toolId` isn't in the authorized externalTools list; parent replies with `QUERY_ERROR`, child's `ctx.query` rejects.

---

## IPC Bridge (`script-ipc.ts`)

Transport: NDJSON over child's stdin/stdout. stderr passed through for real errors.

### Messages — Parent → Child

| Type | Shape | Purpose |
|---|---|---|
| `INIT` | `{ type: "init", params, now }` | Once, after spawn. Child builds `ctx` from this. |
| `QUERY_RESULT` | `{ type: "query_result", id, data, count, metadata? }` | Response to a child query request. |
| `QUERY_ERROR` | `{ type: "query_error", id, error }` | Tool threw; child's `ctx.query` rejects. |

### Messages — Child → Parent

| Type | Shape | Purpose |
|---|---|---|
| `QUERY` | `{ type: "query", id, toolId, sql }` | Child's `ctx.query` awaits matching `QUERY_RESULT`/`QUERY_ERROR`. |
| `STREAM` | `{ type: "stream", chunk }` | Forwards script-level progress to parent's StreamBuffer. |
| `RESULT` | `{ type: "result", data, count, executedQueries, sampleRows, executionTimeMs }` | Sent once when `getData` returns. Child then exits 0. |
| `ERROR` | `{ type: "error", message, stack?, phase?: "compile" \| "runtime" }` | Uncaught; child exits 1. |

### Correlation

Child generates short uuids per `ctx.query` call. Parent maintains `Map<id, { resolve, reject }>` and routes `QUERY_RESULT`/`QUERY_ERROR` by id.

### Child boot context

Via `INIT` only: `params` and `now`. No API keys, no connection strings, no auth tokens. All privileged work stays in the parent.

---

## Integration into `agent-user-response.ts`

### Pipeline lifecycle

```
STEP 1   Semantic cache           (existing — exact-match fast path)
STEP 1.5 Script match             (existing — matcher + runner on cached hit)
STEP 2   MainAgent                (enhanced — now also a script author)
           2a. Route + dispatch SourceAgents         (unchanged — SourceAgent still owns SQL)
           2b. write_script()  ← tool call          (NEW)
           2c. execute_script() ← tool call          (NEW — tsx subprocess, IPC)
           2d. verify output vs user intent          (NEW — small judge LLM turn)
           2e. fix loop (≤ 3 attempts)               (NEW)
           2f. analyze over script output            (existing shape, new source)
STEP 2.5 ScriptStore.save()       (NEW — once, after verified-correct execution)
STEP 3   Lightweight component generator   (unchanged — reads executedQueries)
```

### Cached-replay path (STEP 1.5)

When a script matches a similar question:

1. `ScriptMatcher.match()` returns `{ recipe, extractedParams }`.
2. Parent spawns `tsx <scriptPath>`, sends `INIT { params, now }`.
3. Child runs; each `ctx.query` round-trips via IPC (parent verifies toolId, executes, replies).
4. On `RESULT`, parent builds `ScriptResult { data, count, executedQueries, sampleRows }`.
5. Analysis LLM over `executedQueries` produces the user-facing text.
6. Lightweight component generator picks components from `executedQueries`.

Script execution never touches `new Function()`. If the child fails, the matcher's recipe gets a `recordFailure()` and the flow falls through to MainAgent.

### Fresh-generation path (STEP 2)

When no script matches (or the matched one failed), MainAgent runs. It gets `write_script` and `execute_script` as tools in addition to the existing source-dispatch tools. Its outer loop:

```
write_script(draft)  →  execute_script()  →  {ok, sampleRows, error?, errorPhase?}
                                                   │
                                                   ├─ ok: true   → analyze + save → done
                                                   ├─ ok: false  → rewrite (≤ 3 attempts)
                                                   └─ attempts exhausted → answer from raw
                                                                           executedQueries;
                                                                           do not save
```

### Authorization

Parent-side query handler MUST verify `toolId` against the request's authorized `externalTools[]` before executing. Otherwise a malicious or hallucinated script could probe sources outside its scope.

### Routing (fast path vs script-first)

For trivial questions (one source, simple aggregation, no post-SQL logic), the cost of `write_script` + subprocess spawn isn't worth it. MainAgent should skip `write_script` entirely on these and still return normally — the matcher will pick it up next time, and if it's a true one-off we've lost nothing.

Signal for "script-worthy":
- Multi-source dispatch, OR
- Post-processing language in the prompt ("weighted", "per-capita", "normalized", "cluster", "compare X vs Y"), OR
- MainAgent sees it needs to combine results in-memory.

---

## Component Generation for Script Results

### How It Differs From Current Component Generation

Today's component generation (`generateAgentComponents()` in `agent-component-generator.ts`) does heavy work:

1. LLM reads analysis text + executedTools (SQL, schema, sample data)
2. LLM **discovers** the data shape (column names, types, cardinality)
3. LLM **picks** component types (BarChart, DataTable, KPICard, etc.)
4. LLM **writes new SQL** for each component — different from the analysis SQL (higher row limits, filter support, different column selections)
5. Each component's SQL is **validated** by execution — if it fails, LLM retries
6. Cost: 1 large LLM call + validation round-trips

With scripts, steps 1-2 are unnecessary — we already know the data shape because the script returned it. And step 4 is simpler — the script's SQL is already proven to work, so the component can reuse it with minor modifications (different LIMIT, added WHERE for filters) rather than the LLM writing SQL from scratch.

### The Approach: Lightweight Component Suggestion

The script returns data with known columns and types. We pass this known data shape to a focused LLM call that ONLY picks component types and maps columns — it doesn't write SQL from scratch.

```
Script returns:
  {
    data: [{ ProductName: "Widget A", TotalRevenue: 50000, OrderCount: 120 }, ...],
    count: 10,
    executedQueries: [{ sourceId: "mssql-abc123_query", sql: "SELECT ...", ... }]
  }

We know:
  - Columns: ProductName (TEXT), TotalRevenue (NUMBER), OrderCount (NUMBER)
  - Row count: 10
  - Source: mssql-abc123_query
  - Working SQL: "SELECT TOP 10 ProductName, SUM(Revenue) as TotalRevenue, COUNT(*) as OrderCount ..."

LLM only needs to answer:
  "Given these columns and data, what components should we show?"
  → BarChart (x: ProductName, y: TotalRevenue)
  → DataTable (all columns)
  → KPICard (SUM of TotalRevenue)
```

### Component Prompt (`backend/.prompts/script-components/`)

The prompt is much simpler than the current `dash-comp-picker` prompt because the LLM doesn't need to discover schema or write SQL:

```markdown
# system.md

You are a dashboard component selector. Given the data columns returned by a query, 
pick the best visualization components.

## Available Components
{{AVAILABLE_COMPONENTS}}

## Rules
- Pick 1-3 components that best display the data
- For each component, specify:
  - componentId: exact ID from the available list
  - config: axis mappings, title, description using the EXACT column names from the data
  - The original SQL query will be reused — do NOT write new SQL
- For ranking/top-N data: prefer BarChart (horizontal)
- For time series data: prefer LineChart
- For part-of-whole data (< 8 categories): prefer PieChart
- For detailed records: prefer DataTable
- For single aggregate values: prefer KPICard
- Always include a DataTable as the last component for full data access

Return JSON:
{
  "layoutTitle": "...",
  "components": [
    {
      "componentId": "...",
      "componentName": "...",
      "props": {
        "title": "...",
        "description": "...",
        "config": { "xAxisKey": "...", "yAxisKey": "..." }
      }
    }
  ]
}
```

```markdown
# user.md

User question: "{{USER_PROMPT}}"

Data returned:
- Source: {{SOURCE_NAME}} ({{SOURCE_TYPE}})
- Rows: {{ROW_COUNT}}
- Columns: {{COLUMN_DESCRIPTIONS}}
- SQL used: {{SQL_QUERY}}
- Sample data (first 3 rows):
{{SAMPLE_DATA}}

Pick the best components to display this data.
```

### Why This Is Cheaper

| Aspect | Current component generation | Script component generation |
|---|---|---|
| Schema discovery | LLM reads full schema + executedTools | **Not needed** — columns known from script result |
| SQL generation | LLM writes new SQL per component | **Not needed** — reuse script's SQL with queryId |
| SQL validation | Execute each component's SQL, retry on failure | **Not needed** — SQL already validated by script execution |
| Prompt size | Large (analysis + schema + executedTools + component library) | **Small** (column names + sample data + component library) |
| Component picking | LLM reasons about data shape from raw results | **Same** — LLM picks based on column types and counts |
| Output | Component JSON with `externalTool.parameters.sql` | Component JSON with `externalTool.parameters.queryId` |

The prompt is roughly **60-70% smaller** (no schema, no full executedTools dump, no SQL generation instructions). This translates to fewer input tokens and a simpler, more focused LLM task.

### How Components Reuse Script SQL

The script's SQL is already registered in the query cache during execution (via `ScriptContext.query()`). The component just references it by `queryId`:

```typescript
// During script execution, ScriptContext.query() registers the SQL:
const queryId = queryCache.storeQuery(sql, resultData);

// Component references the same SQL via queryId — no new SQL needed:
{
  componentId: "bar-chart",
  props: {
    externalTool: {
      toolId: "mssql-abc123_query",
      parameters: { queryId: queryId }  // reuses script's proven SQL
    },
    config: { xAxisKey: "ProductName", yAxisKey: "TotalRevenue" }
  }
}
```

When the frontend renders the component, it calls `executeByQueryId(queryId)` which decrypts the SQL and re-executes it with the component's row limit (`MAX_COMPONENT_QUERY_LIMIT = 100`).

### When the Component SQL Needs to Differ From the Script SQL

Sometimes the component needs different SQL than what the script used:
- **Different row limit**: Script fetched 10 rows (for analysis), component needs 100 (for display)
- **Added filters**: Component needs `WHERE OrderDate >= ?` for date filter support

For these cases, the component prompt can instruct the LLM to **modify** the script's SQL rather than write new SQL from scratch:

```
The working SQL is:
  SELECT TOP 10 ProductName, SUM(Revenue) as TotalRevenue ...

For the component, modify this SQL:
  - Change the row limit to 100
  - Add a WHERE clause for date filtering if applicable
  Do NOT rewrite the query — only modify the limit and add filters.
```

This is a much smaller, more constrained task than writing SQL from scratch. The LLM is adapting proven SQL, not inventing new SQL — same principle as the script flow itself.

### Integration: Updated Script Flow Step

The component generation step in the script flow integration (`agent-user-response.ts`) becomes:

```typescript
// After script analysis succeeds...

// STEP 3: Component Generation (lightweight — no SQL generation)
if (components && components.length > 0) {
  // Register script SQL in query cache for component reuse
  const queryIds: Record<string, string> = {};
  for (const q of scriptResult.executedQueries) {
    queryIds[q.sourceId] = queryCache.storeQuery(q.sql, {
      data: q.data,
      count: q.count,
    });
  }

  // Lightweight component suggestion — LLM picks types + maps columns
  const componentResult = await generateScriptComponents({
    userPrompt: prompt,
    scriptResult,
    queryIds,
    availableComponents: components,
    apiKey,
    model: sourceAgentModel,   // can use cheaper model — simpler task
  });

  matchedComponents = componentResult.components;
  layoutTitle = componentResult.layoutTitle;
  actions = componentResult.actions;
}
```

### Fallback

If the lightweight component generation fails (LLM returns invalid JSON, or no components match), fall back to the existing `generateAgentComponents()` with the script's `executedTools`. This ensures component generation never blocks the response — the user always gets at least the analysis text.

---

## System Prompts

All LLM calls use prompts loaded from `backend/.prompts/` with fallbacks in the SDK (`prompts.ts`). The SDK's `promptLoader` reads from disk first and falls back to the hardcoded fallback when a file is missing.

There is **no** `backend/.prompts/script-generate/` — script authoring happens inside MainAgent's own turn via its `write_script` tool. MainAgent's instructions live in `backend/.prompts/agent-main/system.md` under the "Authoring a Reusable Script" section.

### `backend/.prompts/script-match/`

- `system.md` — the script matcher system prompt (pick script + extract params)
- `user.md` — user message template with `{{SCRIPT_CATALOG}}`, `{{USER_PROMPT}}`, `{{CURRENT_DATE}}`

### `backend/.prompts/script-analysis/`

- `system.md` — the analysis prompt for script results (analyze data, answer question)
- `user.md` — user message template with `{{USER_PROMPT}}`, `{{DATA_CONTEXT}}`, `{{CONVERSATION_HISTORY}}`

### `backend/.prompts/script-components/`

- `system.md` — lightweight component picker (pick component types + map columns, no SQL generation)
- `user.md` — user message template with `{{USER_PROMPT}}`, `{{SOURCE_NAME}}`, `{{COLUMN_DESCRIPTIONS}}`, `{{SAMPLE_DATA}}`, `{{SQL_QUERY}}`, `{{ROW_COUNT}}`, `{{AVAILABLE_COMPONENTS}}`

### `backend/.prompts/agent-main/`

- `system.md` — MainAgent's system prompt. Includes the "Authoring a Reusable Script" section documenting `write_script` + `execute_script` tools, the 3-attempt fix cap, parameterization guidance, and examples of script-worthy post-SQL logic.

---

## Analysis LLM Call for Scripts

When a script returns data, we need a single LLM call to analyze it. This is simpler than the MainAgent prompt — no routing, no tool calling, just data analysis.

```typescript
/**
 * Run analysis on script results. One LLM.stream() call — no tools.
 */
async function runScriptAnalysis(params: {
  userPrompt: string;
  scriptResult: ScriptResult;
  apiKey?: string;
  model?: string;
  streamCallback?: (chunk: string) => void;
  conversationHistory?: string;
  knowledgeBaseContext?: string;
  globalKnowledgeBase?: string;
}): Promise<string> {
  const { userPrompt, scriptResult, apiKey, model, streamCallback } = params;

  // Format query results for the LLM
  const dataContext = scriptResult.executedQueries.map(q => {
    const preview = q.data.slice(0, 15);
    return `## Data from "${q.sourceName}"
Rows: ${q.count}${q.totalCount && q.totalCount > q.count ? ` (${q.totalCount} total)` : ''}
Execution time: ${q.executionTimeMs}ms

\`\`\`json
${JSON.stringify(preview, null, 2)}
\`\`\``;
  }).join('\n\n');

  const systemPrompt = `You are a data analyst. The user asked a question and data has been retrieved from their databases. Analyze the data and provide a clear, concise answer.

Rules:
- Only state facts that appear in the data. Every number must trace back to the query results.
- If data is insufficient, say so clearly.
- Be concise — answer the question directly, then provide supporting details.
- Do not fabricate data or invent statistics.

${params.globalKnowledgeBase ? `## Knowledge Base\n${params.globalKnowledgeBase}` : ''}
${params.knowledgeBaseContext ? `## Additional Context\n${params.knowledgeBaseContext}` : ''}
${params.conversationHistory ? `## Conversation History\n${params.conversationHistory}` : ''}`;

  const userMessage = `Question: "${userPrompt}"

${dataContext}

Analyze this data and answer the question.`;

  const text = await LLM.stream(
    { sys: systemPrompt, user: userMessage },
    {
      model: model || undefined,
      maxTokens: 3000,
      temperature: 0,
      apiKey,
      partial: streamCallback,
    }
  );

  return text;
}
```

---

## How to Test

### Manual Testing Steps

1. **Start the backend normally** — the script flow is a fast-path that falls through to the agent flow when no scripts exist.

2. **Ask a question** — it will go through the normal agent flow and automatically create a script.

3. **Check script was created** — look at `scripts-store/<projectId>.json`.

4. **Ask a similar question** — it should match the script and skip the agent flow. You'll see in logs:
   ```
   [AgentFlow] Script matched: "Revenue by Product" (0.892)
   [ScriptContext] Querying Inventory DB...
   ```
   Instead of:
   ```
   [MainAgent] Starting...
   [MainAgent] Dispatching SourceAgent...
   [SourceAgent] Schema search...
   ```

5. **Compare costs** — check `llm-usage-logs` for the number of LLM calls per question.

### What Success Looks Like

- **First question**: Same cost as today (agent flow + 1 extra LLM call for script creation)
- **Second similar question**: 2 LLM calls total (analysis + streaming) vs 4-8 today
- **Script store grows**: After a session, `scripts-store/<projectId>.json` has scripts for each unique question type

---

## Agent Flow Optimization: Embedding-Based Schema Search

This is an independent improvement to the existing agent flow that reduces LLM iteration cost for schema discovery. It works regardless of whether the script flow is implemented.

### The Problem: LLM-Driven Schema Search Is Expensive

For large sources (200+ tables), the SourceAgent uses a `search_schema` tool inside its `LLM.streamWithTools()` loop. The LLM guesses keywords, calls the tool, reads results, and often needs to search again with different keywords. Each search is a full LLM iteration.

Current flow for a very_large source (from `source-agent.ts`):

```
SourceAgent iteration 1: LLM reads intent → calls search_schema(["inventory", "stock"])
  → BaseSource.searchSchema() does KEYWORD substring matching on table/column names
  → Returns top 8 tables with column details

SourceAgent iteration 2: LLM needs more → calls search_schema(["demand", "warehouse"])
  → Returns 8 more tables

SourceAgent iteration 3: LLM has enough context → writes SQL

SourceAgent iteration 4: SQL executes (success or retry)
```

That's 2 iterations (sometimes 3) spent on schema discovery alone. For a question querying 2 sources, that's 4-6 extra LLM iterations just finding tables.

### The Solution: Embedding Search as First Pass

Pre-embed each table's metadata during schema extraction. Before the SourceAgent starts, embed the user question and do vector similarity search to find relevant tables. Inject the matched tables directly into the SourceAgent's prompt — eliminating the `search_schema` tool calls entirely.

```
With embedding pre-search (0 LLM iterations for schema):
  Step 0 (before SourceAgent): embed user question → vector search
    → finds: InventoryMaster, StockLevels, WarehouseMaster, DemandHistory
    → inject these tables (with full column details) into SourceAgent prompt

  SourceAgent iteration 1: LLM writes SQL immediately (relevant tables already in prompt)
  SourceAgent iteration 2: SQL executes

Savings: 1-3 LLM iterations per source agent call
```

### When Embeddings Work vs When They Don't

**Embeddings work well — clean, readable table/column names:**

```
Tables: InventoryMaster, OrderDetails, Products, Warehouses
Columns: ProductName, TotalRevenue, OnHandQty, WarehouseName

User: "show me revenue by product"
Embedding: instantly finds OrderDetails (Revenue), Products (ProductName)  ✓
```

This covers: PostgreSQL/MySQL apps, modern SaaS databases, Excel/CSV files (descriptive sheet names).

**Embeddings struggle — cryptic ERP/enterprise naming:**

```
Tables: OITM, ORDR, OINV, OCTG, RDR1, INV1
Columns: DocEntry, DocNum, CardCode, DocTotalSy, ItemCode

User: "show me revenue by product"
Embedding of "OITM" has NO semantic relationship to "product"
→ Embedding search returns low-confidence results
```

This is common in: SAP, Oracle EBS, Microsoft Dynamics, and other ERP databases where the LLM has trained on the naming conventions and can guess keywords like "ORDR" for orders.

### The Approach: Embeddings First, LLM Keyword Fallback

Don't replace one with the other. Use embeddings as the fast first pass with LLM keyword search as fallback:

```
Step 1: Embed user question → vector search against pre-embedded table metadata
        → If top results have high similarity (> 0.75)
          → Use these tables, inject into SourceAgent prompt
          → Remove search_schema from SourceAgent's tool definitions
          → Saves 1-3 LLM iterations

Step 2: If embedding results are low confidence (< 0.75 similarity)
        → Fall back to current LLM search_schema tool in SourceAgent
        → LLM picks keywords using its knowledge of naming conventions
        → Same cost as today, no worse
```

### Implementation

#### 1. Embed Table Metadata During Schema Extraction

In `BaseSource.setSchema()` (`backend/src/sources/core/base-source.ts`), after the schema is stored, embed each table's metadata:

```typescript
// What to embed per table (concatenated into one string):
// "{tableName} - {description}. Columns: {col1} ({type}), {col2} ({type}), ..."
//
// Example:
// "dbo.InventoryMaster - Inventory levels per product. 
//  Columns: ProductID (NUMBER), ProductName (TEXT), OnHandQty (NUMBER), 
//  ReorderPoint (NUMBER), WarehouseID (NUMBER), LastReceiptDate (DATE)"
```

Store embeddings in a ChromaDB collection per source (or in-memory if ChromaDB isn't available).

#### 2. Pre-Search Before SourceAgent

In `MainAgent.toolHandler()` (`sdk-nodejs/src/userResponse/agents/main-agent.ts`), before dispatching the SourceAgent, do the embedding search:

```typescript
// Before creating SourceAgent:
const preResolvedSchema = await embeddingSchemaSearch(
  externalTool,      // the source tool
  sourceInput.intent, // the user's intent for this source
  collections         // ChromaDB collections
);

if (preResolvedSchema.confidence === 'high') {
  // Inject pre-resolved tables into the source agent's prompt
  // Remove search_schema tool — not needed
  const sourceAgent = new SourceAgent(externalTool, this.config, taggedBuffer, {
    preResolvedSchema: preResolvedSchema.tables,
    skipSchemaSearch: true,
  });
} else {
  // Low confidence — let SourceAgent use search_schema as today
  const sourceAgent = new SourceAgent(externalTool, this.config, taggedBuffer);
}
```

#### 3. Reduce SourceAgent Iteration Budget

When `skipSchemaSearch` is true, the iteration budget drops significantly:

```typescript
// Current (source-agent.ts:243-247):
const hasSchemaSearch = !!schemaSearchFn;
const totalQueryAttempts = this.config.maxRetries + 2;
const perQueryCost = hasSchemaSearch ? 2 : 1;
const extraSearches = hasSchemaSearch ? 2 : 0;
const maxIterations = (totalQueryAttempts * perQueryCost) + extraSearches + 1;
// = (4 * 2) + 2 + 1 = 11 iterations

// With embedding pre-search (skipSchemaSearch = true):
const perQueryCost = 1;   // no schema search per query
const extraSearches = 0;  // no extra searches
const maxIterations = (totalQueryAttempts * 1) + 0 + 1;
// = 4 + 1 = 5 iterations (vs 11 today — 55% reduction)
```

### Cost Impact

| Database type | Today (LLM search only) | With embedding first-pass |
|---|---|---|
| Clean names (PostgreSQL, Excel) | 3-4 SourceAgent iterations | **1-2 iterations** |
| Abbreviated names (mixed) | 3-5 iterations | **2-3 iterations** |
| Cryptic ERP names (SAP, Dynamics) | 4-5 iterations | **4-5 iterations** (fallback, same as today) |
| **Average across all queries** | **~4 iterations** | **~2-3 iterations** |

For a typical question querying 1 source: saves ~2 iterations = ~30-40% cost reduction on the SourceAgent call.
For a multi-source question (2 sources): saves ~4 iterations total.

This compounds with the script flow savings: scripts eliminate the SourceAgent entirely for matched questions, and embedding search makes the SourceAgent cheaper for unmatched questions.

### What to Embed — Table Description Format

Each table gets one embedding string. The format balances semantic richness with token cost:

```
Format:
  "{fullTableName} - {description}. Columns: {col1Name} ({col1Type}), {col2Name} ({col2Type}), ..."

Examples:

  "dbo.InventoryMaster [50K rows] - Master inventory table.
   Columns: ProductID (NUMBER)[PK], ProductName (TEXT), OnHandQty (NUMBER),
   CommittedQty (NUMBER), ReorderPoint (NUMBER), UnitCost (NUMBER),
   WarehouseID (NUMBER)[FK], StockType (TEXT){STK|NON-STK}, LastReceiptDate (DATE)"

  "dbo.OrderDetails [500K rows] - Line items for customer orders.
   Columns: OrderID (NUMBER)[FK], ProductID (NUMBER)[FK], Quantity (NUMBER),
   Revenue (NUMBER), Discount (NUMBER), ShipDate (DATE)"

  "Sheet: Q1 Sales [2K rows] - Quarterly sales report.
   Columns: Region (TEXT), Product (TEXT), Units Sold (NUMBER), Revenue (NUMBER)"
```

Including sample values for low-cardinality columns (like `{STK|NON-STK}`) helps the embedding capture business semantics, not just column names.

### Implementation Priority

This is **independent of the script flow** and can be implemented separately:

- **Low risk**: embedding search is additive — if it fails or returns low confidence, the existing LLM search_schema flow runs unchanged
- **Immediate benefit**: every SourceAgent call on a clean-named database gets cheaper, even without scripts
- **No migration needed**: existing sources just get an embedding index built on next schema extraction

Can be implemented as Phase 1 (before or in parallel with the script flow), or deferred to after the script flow MVP is validated.

---

## Agent Flow Optimization: Embedding-Based Source Routing Pre-Filter

This is the second embedding optimization for the agent flow. It narrows which source summaries the MainAgent sees, reducing prompt tokens and improving routing accuracy. Most useful when a project has 5+ data sources.

### The Problem: MainAgent Sees All Sources

Today the MainAgent's system prompt includes summaries for EVERY connected source, regardless of relevance. The `buildSourceToolDefinitions()` in `main-agent.ts:297` builds a tool definition per source, each containing entity names, column lists, and row counts.

For a project with 10 data sources:

```
MainAgent system prompt includes:
  Source 1: "Sales DB (MSSQL)" — 45 tables, ~500 tokens
  Source 2: "Planning DB (PostgreSQL)" — 20 tables, ~300 tokens
  Source 3: "HR Database" — 30 tables, ~400 tokens
  Source 4: "Marketing Analytics" — 15 tables, ~250 tokens
  Source 5: "Inventory DB" — 60 tables, ~600 tokens
  Source 6: "Finance DB" — 50 tables, ~500 tokens
  Source 7: "CRM Export (Excel)" — 5 sheets, ~150 tokens
  Source 8: "Logistics DB" — 40 tables, ~450 tokens
  Source 9: "Product Catalog (CSV)" — 3 files, ~100 tokens
  Source 10: "Supplier Portal (REST API)" — 8 endpoints, ~200 tokens
  
  Total: ~3,450 tokens just for source summaries
```

When the user asks "show me overstock by warehouse", only Source 5 (Inventory) and maybe Source 8 (Logistics) are relevant. The other 8 sources add noise and cost.

### The Impact

- **Token cost**: ~3,000 extra tokens per MainAgent iteration × 3-5 iterations = ~9,000-15,000 wasted tokens per question
- **Routing accuracy**: More irrelevant sources = higher chance the LLM routes to the wrong one. With 10 sources, the LLM occasionally queries the HR database for an inventory question because a column name happened to match.
- **Latency**: Bigger prompt = slower time-to-first-token

### The Solution: Embedding Pre-Filter

Before the MainAgent starts, embed the user question and search against pre-embedded source descriptions. Only include the top N most relevant sources in the MainAgent's prompt.

```
Today (all 10 sources in prompt):
  MainAgent sees: 10 source summaries (3,450 tokens)
  LLM reads all 10, picks Source 5
  
With embedding pre-filter:
  Step 0: embed "show me overstock by warehouse" 
    → vector search against source description embeddings
    → Top matches: Inventory DB (0.89), Logistics DB (0.76), Sales DB (0.71)
    
  MainAgent sees: 3 source summaries (~1,350 tokens)
  LLM routes faster and can't accidentally query HR or Marketing
```

### What to Embed Per Source

Each source gets one embedding string built from its summary. This is already available from `buildSourceSummaries()` in `agent-prompt-builder.ts`:

```
Format:
  "{sourceName} ({sourceType}) — {description}. 
   Contains: {entity1} [{columns}]; {entity2} [{columns}]; ..."

Examples:

  "Inventory DB (MSSQL) — Master inventory and stock management system.
   Contains: dbo.InventoryMaster [ProductID, ProductName, OnHandQty, ReorderPoint, WarehouseID];
   dbo.StockTransactions [TransID, ProductID, TransType, Quantity, TransDate];
   dbo.Warehouses [WarehouseID, WarehouseName, Region, Capacity]"

  "HR Database (PostgreSQL) — Employee and payroll information.
   Contains: employees [id, name, department, hire_date, salary];
   departments [id, name, manager_id]; payroll [employee_id, period, amount]"
```

These are compact (~100-200 tokens each) and capture the semantic domain of each source.

### Implementation

#### 1. Embed Source Descriptions

After `buildSourceSummaries()` produces summaries, embed each one and store in a project-level ChromaDB collection (or in-memory index).

This happens once when sources are initialized and when schemas are refreshed — not on every request.

#### 2. Pre-Filter Before MainAgent

In `get_agent_user_response()` (`agent-user-response.ts`), before creating the MainAgent, filter the tools:

```typescript
// ============================================
// Source Routing Pre-Filter (embedding-based)
// ============================================

let filteredTools = agentTools;

if (agentTools.length >= 5) {
  // Only pre-filter when there are enough sources to benefit
  const relevantSources = await embeddingSourceFilter(
    prompt,
    agentTools,
    collections,
    { maxSources: Math.min(5, Math.ceil(agentTools.length * 0.5)) }
  );

  if (relevantSources.length > 0) {
    filteredTools = relevantSources;
    logger.info(`[AgentFlow] Source pre-filter: ${agentTools.length} → ${filteredTools.length} sources`);
  }
  // If embedding search fails or returns nothing, use all sources (safe fallback)
}

// Create MainAgent with filtered tools
const mainAgent = new MainAgent(filteredTools, agentConfig, streamBuffer);
```

#### 3. Safety Rules

- **Minimum sources**: Always include at least 3 sources (even if only 1 scores high). The user might ask a cross-source question.
- **Include direct tools**: Never filter out direct tools (toolType: 'direct') — they have pre-built business logic.
- **Threshold, not hard cutoff**: Include any source above 0.6 similarity, up to the max. If fewer than 3 sources pass the threshold, include top 3 anyway.
- **Skip for small projects**: If there are fewer than 5 sources, don't filter — the token savings aren't worth the risk of missing a source.
- **Fallback**: If embedding search fails entirely, use all sources (same as today).

### Cost Impact

| Project size | Today | With pre-filter |
|---|---|---|
| 2-4 sources | ~800-1,600 tokens per iteration | Same (pre-filter disabled) |
| 5-7 sources | ~2,000-3,000 tokens per iteration | **~1,000-1,500 tokens** (top 3-4 sources) |
| 8-12 sources | ~3,000-5,000 tokens per iteration | **~1,000-2,000 tokens** (top 3-5 sources) |
| Per question (5+ sources, ~4 iterations) | ~12,000-20,000 summary tokens | **~4,000-8,000 summary tokens** |

For projects with 8+ sources, this saves ~10,000+ tokens per question — roughly $0.01-0.03 at Sonnet pricing. Compounds with every question.

### Combined Impact: Both Embedding Optimizations Together

For a project with 8 sources, one of which has 500+ tables:

```
Today:
  MainAgent: 8 source summaries in prompt (4,000 tokens) × 4 iterations = 16,000 tokens
  SourceAgent: 3 search_schema iterations + 2 SQL iterations = 5 iterations
  Total: ~21,000+ summary/schema tokens

With both embedding optimizations:
  MainAgent: 3 source summaries in prompt (1,500 tokens) × 3 iterations = 4,500 tokens
  SourceAgent: 0 search iterations + 2 SQL iterations = 2 iterations
  Total: ~6,500 summary/schema tokens

Savings: ~70% reduction in schema/routing token cost
```

### Implementation Priority

Both embedding optimizations can be implemented together since they share the same infrastructure (embedding generation + vector search):

1. **Schema search embedding** — build during `setSchema()`, search before SourceAgent
2. **Source routing embedding** — build from source summaries during `getSourceTools()`, filter before MainAgent
3. **Shared ChromaDB collection** — one collection per project with both table-level and source-level embeddings, distinguished by metadata tags

---

## Current Implementation Status

Script-first is deployed end-to-end. MainAgent authors scripts in its own turn; execution runs in a tsx subprocess.

### Deployed

| Piece | Location | Status |
|---|---|---|
| Semantic cache | `agent-user-response.ts` → `ConversationSearch` | stable |
| Script match | `scripts/script-matcher.ts` | stable |
| Script store (split `.ts` + `metadata/*.json`) | `scripts/script-store.ts` | stable |
| `normalizeScriptBody` helper | `scripts/script-store.ts` | stable — exported for MainAgent temp files |
| Subprocess runner (tsx + IPC) | `scripts/script-runner.ts` + `scripts/script-ipc.ts` | stable — replaces `new Function()` |
| Child bootstrap | `scripts/script-bootstrap.ts` → bundled to `dist/userResponse/scripts/script-bootstrap.js` | stable |
| `ctx.emit(name, rows, meta?)` | `scripts/script-bootstrap.ts` | stable — emits virtual entries into executedQueries |
| MainAgent `write_script` / `execute_script` tools | `agents/main-agent.ts` | stable — per-turn scriptState, 3-attempt cap |
| `AgentResponse.savedScript` → `ScriptStore.save()` | `agents/types.ts` + `agent-user-response.ts` | stable — replaces post-hoc save |
| Param coercion (date/number/boolean) | `scripts/script-runner.ts` | stable |
| Authorization check on QUERY messages | `scripts/script-runner.ts` | stable |
| Lightweight component generator | `scripts/script-component-generator.ts` | stable (reads executedQueries — still per-source) |
| Schema embedding pre-resolve | `agents/main-agent.ts:preResolveSchema` | stable |
| Source routing pre-filter | `agent-user-response.ts` | stable |

### Removed / retired

| Piece | Reason |
|---|---|
| `scripts/script-generator.ts` (post-hoc LLM wrapper) | Replaced by MainAgent's `write_script` tool |
| `backend/.prompts/script-generate/` | Its rules moved into `agent-main/system.md` under "Authoring a Reusable Script" |
| `scripts/script-context.ts` (parent-side class) | `ctx` is now built in the child (`script-bootstrap.ts`) |

### Open (not deployed)

- **Component generator awareness of virtual entries** — `ctx.emit` data currently renders like any other query; component picker doesn't distinguish "real SQL result" from "computed dataset". Works today because both are just rows + columns, but future polish could label computed datasets differently in the UI.
- **Precompile-on-save** — optional `esbuild` step to emit a sibling `.js` and trim ~350ms off cold-start. Not wired yet; worth doing only if measured latency is a problem.

---

## Known Issues

Filtered to issues that remain relevant under script-first. Items resolved by the architectural shift are struck out with a note so the reasoning survives.

### 1. ~~Script runner sandbox is too permissive~~ — RESOLVED by subprocess
Replaced by `tsx` subprocess execution. Child has no shared memory with parent; SIGKILL on timeout. No `new Function()` in the SDK.

### 2. No schema-drift detection
Recipe stores `tables: string[]` via regex but never validates against current schema. If a column is renamed or a table is dropped, the matcher still picks the script and the child fails at runtime.

**Fix:** before running a matched script, diff `recipe.tables` against `SourceInstance.getSchema().entities`. If any table is missing, skip the match and fall through to MainAgent. Also re-validate on schema refresh.

### 3. ~~No parameter type validation~~ — RESOLVED
`script-runner.ts` now coerces `date`/`date_range`/`number`/`boolean` params before execution.

### 4. Matcher cost — wrong model + no cache
`ScriptMatcher.match()` fires on every request with ≥1 script and uses whichever `sourceAgentModel` was passed in. Matching is a classification task — should default to Haiku and cache results keyed on `(prompt, libraryHash)`.

### 5. Script name collisions silently overwrite
`toFileName()` kebab-cases names. Two scripts named "Sales Report" overwrite on disk. Detect at save; append `-2`/`-3` if the existing file has a different recipe id.

### 6. Source ID fragility
Recipes reference `mssql-abc123_query` as hardcoded tool IDs. If a source is removed and re-added with a new UUID, the script breaks.

**Fix:** store sources in the recipe by logical name + type (`{ logicalName: "Inventory DB", type: "mssql" }`); resolve at runtime via `SourceManager`. Rewrite the `.ts` body's tool-id references on re-add.

### 7. ~~No validation before save~~ — RESOLVED by MainAgent's execute + verify loop
MainAgent only calls `ScriptStore.save()` after a successful `execute_script` + judge-ok turn. Partial or broken drafts are never persisted.

### 8. ~~Unused `analysisText` in generator~~ — RESOLVED
Post-hoc generator is going away. MainAgent has full context natively.

### 9. ~~Concurrent-generation race~~ — RESOLVED
Each request has its own MainAgent turn; there's no background-generation path to race against.

### 10. No telemetry beyond success/failure counts
Need: match latency, execution latency (script vs MainAgent fresh-generation), token usage per matcher + per verify call, hit rate, lightweight component gen success rate. Log to `llm-usage-logs` + a `script_metrics` view.

### 11. Matcher ignores conversation history
Follow-ups like "now top 5 instead of top 10" may miss the previous turn's script. Pass previous-turn script id as a hint to the matcher.

### 12. Unbounded store growth
Every successful MainAgent turn creates a new script. Needs age-based pruning (archive scripts unused for 90 days) and, when the store exceeds ~50 scripts, an embedding pre-filter to narrow the matcher's input.

### 13. No component recipes
Every matched question still fires the lightweight component-gen LLM call. The choice is almost always stable for the same script; store it on the recipe, skip the call on repeat.

### 14. Admin surface is missing
Scripts are inspected/managed by editing files. Needs: list with counts, delete, soft-disable, reset-failure-counts endpoints.

### 15. Multi-user isolation is implicit
VM deployment assumption: one project per VM. If we ever run multi-project on one VM, every script is global. No access control.

### 16. Sequential `ctx.query()` only
Multi-source scripts run queries serially. Either document `Promise.all(ctx.query(...))` as the pattern or add `ctx.queryParallel([...])` as sugar.

### 17. No recipe versioning / migration
`recipe.version` exists but is never checked. When we change the `ScriptRecipe` shape, existing JSON files may not parse. Add a migration step on load.

---

## Future Work — Prioritized

Ordered from "ship this next" to "long-term, optional." Items referencing resolved issues above have been dropped.

### Near-term (required for script-first rollout)

1. **Subprocess runner + IPC bridge.** Replace `new Function()` with `tsx <scriptPath>` + NDJSON IPC. Covers Known Issue #1.
2. **`write_script` / `execute_script` tools on MainAgent.** The fix-loop (≤3 attempts). Replaces the post-hoc generator.
3. **`ctx.emit(name, rows)`.** Registers computed datasets alongside real queries so the component pipeline can render transformed data.
4. **Precompile-on-save (optional).** `esbuild` emits a sibling `.js`; runner prefers it. Cuts cold-start to ~150ms.
5. **Schema-drift guard (Issue #2).** Diff `recipe.tables` against live schema before running.
6. **Matcher model + cache (Issue #4).** Haiku default, per-call override, TTL cache keyed on `(prompt, libraryHash)`.
7. **Name-collision detection (Issue #5).** `-N` suffix on kebab-case collision.

### Medium-term

8. **Component recipes (Issue #13).** Store chosen components on the recipe. Skip the lightweight gen call on repeat. Biggest latency win on cached replay.
9. **Source-ID resilience (Issue #6).** Logical-name layer; rewrite `ctx.query(toolId, ...)` references on source re-add.
10. **Telemetry (Issue #10).** Latency, token counts, hit rate.
11. **Admin API (Issue #14).** List / disable / reset / delete scripts.

### Long-term

12. **Embedding pre-filter for >50 scripts (Issue #12).** Narrow matcher input via ChromaDB similarity search.
13. **Follow-up context in matcher (Issue #11).** Pass last turn's script id as a hint.
14. **Long-lived child with `EVAL`/`INSPECT`.** If measured first-pass latency is bad, replace fresh-child-per-attempt with a REPL-style child per MainAgent turn.
15. **Manual approval workflow.** `recipe.status: pending | active | disabled` for multi-user deployments.
16. **Recipe versioning / migration (Issue #17).** Upgrade old recipes to current shape on load.
17. **Component cache invalidation.** When a source schema changes, invalidate component recipes tied to it.

---

## Open Questions

1. **When does a script get "retired"?** After N failures? After M days unused? Leaning: failure rate >20% at 5+ uses (already implemented) AND no use in 90 days (pruning — not implemented).

2. **Matcher misfire cost.** If a bad match overrides what MainAgent would have produced, the user silently gets worse results. Do we need a "shadow" MainAgent run for low-confidence matches to compare outputs?

3. **Should scripts be shared across projects?** A script for "top N customers by revenue" is generic. Current design is per-VM/per-project — clean but duplicative.

4. **Parameter extraction quality.** LLM extracts params from natural language. When extraction is wrong (e.g., "last quarter" → no date range), the script fails and we fall through to MainAgent. Acceptable for now, but telemetry should tell us how often.

5. **Judge step placement.** Does "does this output match user intent?" live as a separate LLM turn after `execute_script`, or does MainAgent roll it into its next tool-call decision? Separate is cleaner but +1 turn; rolled-in is faster but blurs responsibilities.

6. **Precompile-on-save timing.** Is the `esbuild` dependency worth adding from day one, or defer until measured latency actually shows the 500ms cold-start is a problem?

7. **Routing decision owner.** Who picks "this is script-worthy, skip write_script"? MainAgent in its first turn, a heuristic keyword match pre-dispatch, or a dedicated classifier LLM call?

8. **Failed-attempts retention.** When all 3 attempts fail and MainAgent falls back to answering from raw `executedQueries`, do we save the best attempt (as a disabled recipe) for human review, or discard entirely?


                  
 Test Questions for Post-SQL Logic                                                             

  Tailored to your actual MSSQL schema (mssql-7d4d2f3d0224_query, 693 tables). Each pair is     
  designed so:
  1. A forces MainAgent into JS post-processing (SQL alone is awkward or the prompt biases      
  toward JS).                                                                                   
  2. B is a paraphrase that should match A's saved script via ScriptMatcher.
                                                                                                
  For each, I list: the tables involved, the JS logic that should appear in the saved .ts, and  
  the failure mode if MainAgent shortcuts to pure SQL.                                          
                                                                                                
  ---                                                                                           
  Pair 1 — Volume-weighted exchange rate (weighted average)
                                                                                                
  - A: "What's the volume-weighted average INR exchange rate for each invoice currency? Use 
  INVTOTAL as the weight."                                                                      
  - B: "Show me the weighted average exchange rate per currency, weighted by invoice total."
                                                                                                
  Tables: dbo.INV_DETAILS — INVCURRENCY (4 vals: EUR/GBP/INR/USD), INVEXRATE, INVTOTAL.         
   
  Expected JS in script:                                                                        
                  
  const q = await ctx.query(toolId, `                                                           
    SELECT INVCURRENCY, INVEXRATE, INVTOTAL FROM dbo.INV_DETAILS
  const acc = new Map();                                                                        
  for (const r of q.data) {                                                                     
    const k = r.INVCURRENCY;                                                                    
    const cur = acc.get(k) ?? { num: 0, den: 0 };                                               
    cur.num += Number(r.INVEXRATE) * Number(r.INVTOTAL);                                        
    cur.den += Number(r.INVTOTAL);                                                              
    acc.set(k, cur);                                                                            
  }                                                                                             
  const data = [...acc].map(([c, v]) => ({ currency: c, weightedAvgRate: v.num / v.den,
  totalWeight: v.den }));                                                              
                                                                                                
  Failure mode to catch: agent writes SUM(INVEXRATE*INVTOTAL)/SUM(INVTOTAL) GROUP BY INVCURRENCY
   — that's correct SQL and the answer is right, but the script is a passthrough with no JS     
  transform. That tells you the prompt isn't biting — it didn't reach for JS even though the
  rule says to.                                                                                 
                  
  ---
  Pair 2 — Pareto / cumulative-share-until-80%
                                                                                                
  - A: "Which states cumulatively account for 80% of all shipping bills? Show each state's share
   and the running total."                                                                      
  - B: "Pareto analysis: list states by shipping bill count until we reach 80% cumulative 
  coverage."                                                                                    
                  
  Tables: dbo.SB — IEC_STATE (22 distinct).                                                     
                  
  Expected JS (the cumulative-until-threshold is the JS-natural part):                          
                  
  const q = await ctx.query(toolId, `                                                           
  const total = q.data.reduce((s, r) => s + Number(r.cnt), 0);                           
  let running = 0;                                                                              
  const data = [];
  for (const r of q.data) {                                                                     
    running += Number(r.cnt);                                                                   
    const cumPct = (running / total) * 100;
    data.push({ state: r.IEC_STATE, count: r.cnt, share: (Number(r.cnt)/total)*100, cumulative: 
  cumPct });                                                                                    
    if (cumPct >= 80) break;                                                                    
  }                                                                                             
                                                                                                
  Why JS-only: SQL can do running total via window functions but the stop-when-80% loop is
  awkward; JS is the obvious choice.                                                            
   
  ---                                                                                           
  Pair 3 — HHI (Herfindahl–Hirschman Index) for airline concentration
                                                                                                
  - A: "Calculate the Herfindahl-Hirschman Index for airline concentration in airway bills. Show
   each airline's market share squared and the total HHI score."                                
  - B: "How concentrated is the airline AWB market? Give me the HHI."
                                                                                                
  Tables: dbo.AE_AIRWAYBILL — AABAIRLINENOCODE (39 distinct).                                   
                                                                                                
  Expected JS:                                                                                  
                  
  const q = await ctx.query(toolId, `
  const total = q.data.reduce((s, r) => s + Number(r.cnt), 0);                                  
  const rows = q.data.map(r => {                                                                
    const share = Number(r.cnt) / total;
    return { airline: r.AABAIRLINENOCODE, count: r.cnt, sharePct: share*100, sharePctSquared:   
  (share*100)**2 };                                                                          
  });                                                                                           
  const hhi = rows.reduce((s, r) => s + r.sharePctSquared, 0);
  ctx.emit('hhi_score', [{ hhi, interpretation: hhi < 1500 ? 'unconcentrated' : hhi < 2500 ?    
  'moderate' : 'high' }]);                                                                  
  return { data: rows, count: rows.length };                                                    
                                            
  Why this is a strong test: HHI is unambiguously a post-SQL computation. Also uses ctx.emit —  
  the only emit-using pair in this list. Watch for computed:hhi_score in executedQueries and a  
  separate component tile.                                                                      
                                                                                                
  ---             
  Pair 4 — Cross-currency contribution (separate-total + per-row division)
                                                                                                
  - A: "What percentage of total invoice INR value does each currency contribute? Show absolute 
  INR value and share."                                                                         
  - B: "Show currency mix as a share of total invoice value."
                                                                                                
  Tables: dbo.INV_DETAILS — INVCURRENCY, INVTOTALINR.
                                                                                                
  Expected JS pattern (matches doc line 131: "Computed percentages that depend on multiple      
  queries' totals"):
  const grand = await ctx.query(toolId, `SELECT SUM(INVTOTALINR) AS total FROM                  
  dbo.INV_DETAILS`);                                                           
  const byCcy = await ctx.query(toolId, `                                                       
    SELECT INVCURRENCY, SUM(INVTOTALINR) AS amt FROM dbo.INV_DETAILS GROUP BY INVCURRENCY`);
  const total = Number(grand.data[0].total);                                                    
  const data = byCcy.data.map(r => ({                                                           
    currency: r.INVCURRENCY,                                                                    
    amountInr: r.amt,                                                                           
    sharePct: (Number(r.amt) / total) * 100,                                                    
  }));                                      
                                                                                                
  Why JS: forces two ctx.query calls and an in-memory ratio — the canonical "computed           
  percentages from multiple queries' totals" pattern from the agent-main prompt.                
                                                                                                
  ---                                                                                           
  Pair 5 — Branch consistency via Coefficient of Variation
                                                                                                
  - A: "For each branch, calculate the coefficient of variation (stddev / mean) of monthly 
  transaction counts. Which branches have the most consistent monthly volume?"                  
  - B: "Rank branches by how consistent their monthly transaction volume is."
                                                                                                
  Tables: dbo.ACC_TRANSACTION — ACTBRANCHID (35), ACTVOUCHERDATE (1.46M rows, 2068 distinct     
  dates).                                                                                       
                                                                                                
  Expected JS:                                                                                  
   
  const q = await ctx.query(toolId, `                                                           
    SELECT ACTBRANCHID,
           FORMAT(ACTVOUCHERDATE, 'yyyy-MM') AS ym,
           COUNT(*) AS cnt                                                                      
    FROM dbo.ACC_TRANSACTION
    WHERE ACTVOUCHERDATE IS NOT NULL                                                            
    GROUP BY ACTBRANCHID, FORMAT(ACTVOUCHERDATE, 'yyyy-MM')`);
  for (const r of q.data) {                                                                     
    if (!byBranch.has(r.ACTBRANCHID)) byBranch.set(r.ACTBRANCHID, []);
    byBranch.get(r.ACTBRANCHID).push(Number(r.cnt));                                            
  }                                                                                             
  const data = [...byBranch].map(([b, counts]) => {                                             
    const mean = counts.reduce((s, n) => s + n, 0) / counts.length;                             
    const variance = counts.reduce((s, n) => s + (n - mean) ** 2, 0) / counts.length;           
    const stddev = Math.sqrt(variance);                                                         
    return { branch: b, months: counts.length, mean, stddev, cv: stddev / mean };
  }).sort((a, b) => a.cv - b.cv);                                                               
                                                                                                
  Why JS: stddev computed in SQL works but two-pass mean+variance per group, then ranking —     
  natural in JS over a small post-aggregate result.                                             
                  
  ---                                                                                           
  Pair 6 — In-memory composition (two aggregates, one ratio)
                                                                                                
  - A: "For each branch, what's the ratio of shipping bills issued to invoices issued? Identify 
  branches that are SB-heavy vs invoice-heavy."                                                 
  - B: "Show shipping bills vs invoices ratio per branch."
                                                                                                
  Tables: dbo.SB (MAOOFFICEID, 11 distinct) and dbo.INV_DETAILS (INVBRANCHID, 25 distinct).     
                                                                                                
  Expected JS (doc line 130: "In-memory JOIN/union of results from two different sources" — same
   source here, but the separate aggregates still force the same pattern):
                                                                                                
  const sb = await ctx.query(toolId, `
    SELECT MAOOFFICEID AS branch, COUNT(*) AS sbCount FROM dbo.SB GROUP BY MAOOFFICEID`);       
  const inv = await ctx.query(toolId, `                                                         
    SELECT INVBRANCHID AS branch, COUNT(*) AS invCount FROM dbo.INV_DETAILS GROUP BY            
  INVBRANCHID`);                                                                                
  const map = new Map();
  for (const r of sb.data) map.set(r.branch, { branch: r.branch, sbCount: Number(r.sbCount),    
  invCount: 0 });                                                                               
    const cur = map.get(r.branch) ?? { branch: r.branch, sbCount: 0, invCount: 0 };
    cur.invCount = Number(r.invCount);                                                          
    map.set(r.branch, cur);                                                                     
  }                        
  const data = [...map.values()].map(b => ({                                                    
    ...b,                                   
    ratio: b.invCount === 0 ? null : b.sbCount / b.invCount,                                    
    classification: b.invCount === 0 ? 'no-invoices' : (b.sbCount / b.invCount) > 1 ? 'sb-heavy'
   : 'invoice-heavy',                                                                           
  }));                                                                                          
      
  Why JS: agent could try a SQL FULL OUTER JOIN of two sub-aggregates, but the natural          
  script-flow path is two ctx.query calls + a JS Map join. This is the strongest "in-memory     
  join" test on a single source.
                                                                                                
  ---             
  Negative test (don't match anything above)
                                            
  After running A's, ask:
                                                                                                
  ▎ "List the top 5 IEC exporters by shipping bill count"                                       
                                                                                                
  This is pure SQL (SELECT TOP 5 IEC_NAME, COUNT(*) FROM dbo.SB GROUP BY IEC_NAME ORDER BY ...).
   Confirm:       
  - [ScriptMatcher] No script matched (none of Pairs 1–6 should bait it).                       
  - The newly saved script is a passthrough (no JS transforms beyond ctx.query + return). That's
   correct here.
                                                                                                
  ---             
  What to look for in logs (per pair)                                                           
                                                                                                
  On A (first run):
  [MainAgent] Schema embedding pre-resolved K tables ... (top=0.XX)                             
  [MainAgent] write_script called  ← script body should contain JS, not just one ctx.query
  [MainAgent] execute_script ok=true                                                            
  [ScriptStore] Saved script "<name>"                                                           
  Then open the saved .ts at backend/scripts-store/<name>.ts and check: does it have a          
  for/map/reduce over q.data, or is the .ts body literally just return { data: q.data, count:   
  q.count }? If the latter, MainAgent shortcut to SQL — the prompt isn't biting hard enough.    
                                                                                            
  On B (similar question):                                                                      
  [ScriptMatcher] Matched "<name>" (confidence: high)                                           
  [ScriptRunner] Executing "<name>" with params: {...}
  No [MainAgent] Starting..., no SourceAgent dispatch.                                          
                  
  ---                                                                                           
  Priority order to run
                                                                                                
  1. Pair 4 (currency contribution) — simplest, two-query pattern, very likely to work.
  2. Pair 6 (SB-vs-invoice ratio) — strongest in-memory-join test.                              
  3. Pair 1 (weighted avg exchange rate) — classic weighted-average forcer; also the one where a
   smart LLM is most tempted to use SQL SUM(a*b)/SUM(b) — if it does, you've found a prompt gap 
  to fix.                                                                                       
  4. Pair 2 (Pareto) — tests cumulative-loop logic.                                             
  5. Pair 3 (HHI) — tests ctx.emit flow.                                                        
  6. Pair 5 (CV per branch) — heaviest schema use, harder to match.                             
                                                                                                
  If Pair 1 produces a passthrough .ts, that's the signal to extend agent-main/system.md (lines 
  127–134) with a worked weighted-average example, since the bullet list isn't enough to        
  override the LLM's SQL instinct.          