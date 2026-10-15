# Component Generation v2 — Agent-Authored, Validated, Grain-Correct

> Successor to `SCRIPT-COMPONENT-CONSISTENCY.md`. That plan's Phases 1–3 are **built**
> (deterministic repair, script-as-source-of-truth prompts, component recipe + replay).
> This document covers the failures that survived them, and reverses one decision from
> that doc — see §7.

## Purpose

Component generation still produces wrong dashboards on questions the script answers
correctly. Four reported symptom classes:

1. KPI card value ≠ the number in the analysis text.
2. Bar charts render with no meaningful data (every bar the same height, or empty).
3. Axes swapped, or `seriesKey` grouping visibly wrong.
4. DataTable shows internal/total columns the answer didn't ask for.

The goal of this plan is **correctness of the rendered dashboard**. Cost and latency are
explicitly *not* constraints for v2 — we may spend extra model turns and extra
server-side computation to get the numbers right.

---

## 1. Why Phases 1–3 didn't close this

Phase 1 added `validateAndRepairComponent()` (`script-component-generator.ts:111`) and it
does real work — it canonicalizes column names, enforces axis type roles, and forces KPI
aggregation. But it repairs a *spec* against *column metadata*. It never sees the rendered
result, and it has no way to tell the author it was wrong.

Three gaps remain.

### Gap A — the repair guesses instead of failing

`firstOfType()` (`script-component-generator.ts:88`) returns the **first** NUMBER or TEXT
column in insertion order whenever the LLM's key doesn't resolve. Every branch of
`validateAndRepairComponent` falls back to it (`:132–133`).

An unresolvable `yAxisKey` therefore becomes an arbitrary numeric column, and the chart
renders — plausibly, and wrong. This is worse than dropping the component: a missing chart
is visible, a chart of the wrong column is not.

### Gap B — the frontend re-derives every number

The spec that survives validation is a *recipe* (`valueKey` + `aggregation`), not a value.
The browser executes that recipe against the payload it fetched by `queryId`, which is
capped at `MAX_ROWS_RENDERED = 250` (`agent-user-response.ts:212`) — or at
`DEFAULT_QUERY_LIMIT = 24` on the full-generator path, where `ensureQueryLimit` injects a
`LIMIT` when the LLM's SQL has none (`agent-component-generator.ts:579`).

So the same number is computed three times, over three different row sets:

| Stage | Computed over | Where |
|---|---|---|
| Analysis | `summarizeRows(result.data)` — all returned rows, server-side | `agents/data-summary.ts:37`, injected at `main-agent.ts:540` |
| Component-gen LLM | **3 sample rows** + column list + the analysis prose | `script-component-generator.ts:505` (`TOOL_TRACKING_SAMPLE_ROWS`) |
| The component itself | The render-capped payload, re-reduced in the browser | `DynamicKPICard/index.tsx:698–766` |

Only the first has the real numbers. This is the mechanism behind symptom 1, and no
change to *which model* picks the components affects it.

### Gap C — confirmed frontend defects that corrupt correct specs

These fire even when the spec is perfect. Verified in the shared-modules source:

| # | Defect | Location | Effect |
|---|---|---|---|
| C1 | `aggregationType = config.aggregation \|\| 'count'`, and `needsAggregation` also triggers when `data[0][yAxisKey]` is `undefined` | `DynamicBarChart/index.tsx:810`, `:818–821` | Silently switches to counting rows → every bar becomes a row count. **Symptom 2.** |
| C2 | `sum`/`avg` fall through to `agg.count` when `aggregationField` is absent | `DynamicBarChart/index.tsx:853`, `:858` | Same as C1, via a different path |
| C3 | `seriesMap.get(name).set(category, value)` — last row wins | `DynamicBarChart/index.tsx:908` | Duplicate (series, category) pairs silently overwrite instead of summing; `seriesKey` mode is also excluded from aggregation entirely (`:818`). **Symptom 3.** |
| C4 | `avg` divides by `dataArray.length`; `parseFloat(val) \|\| 0` coerces nulls to 0 | `DynamicKPICard/index.tsx:733`, `:730` | Nulls counted in the denominator → wrong mean |
| C5 | With no `aggregation`, value is `data[0][valueKey]` | `DynamicKPICard/index.tsx:862` | Silent first-row KPI |
| C6 | DataTable branch deletes the **entire** `columns` list if any single key fails to resolve; frontend then auto-detects `Object.keys(data[0])` | `script-component-generator.ts:247–259`, `DynamicDataTable/index.tsx:1017–1019` | One hallucinated column name flips the table from curated to raw, exposing `TotalItems`, rank helpers, join keys. **Symptom 4.** |

C6 is aggravated by our own script contract: `SCRIPT_BODY_CONTRACT` (`prompts.ts:3318`)
instructs scripts to carry true totals as columns (`COUNT(*) OVER () AS TotalItems`), so
the columns that leak are ones we deliberately added.

### Gap D — the component contract has three disagreeing sources of truth

The catalog the LLM authors against is built from each component's static `Metadata`
(`frontend/src/superatom.ts:113–116` → `sendComponents` → `COMPONENT_LIST_RES` →
`sdk-nodejs/src/index.ts:369`). That declared contract does not match what the components
actually read, nor what the prompt tells the LLM to set:

| Component | Declared in `Metadata.props.config` — what the LLM sees | Read by the component but **undeclared** |
|---|---|---|
| KPICard | `valueKey, prefix, suffix, formatNumber, icon, iconColor` | `aggregation`, `aggregationField` (`DynamicKPICard/index.tsx:695–696`) |
| BarChart | `xAxisKey, yAxisKey, metricKeys, metricLabels, xAxisLabel, yAxisLabel, seriesKey, height, orientation, colorPalette` | `groupBy`, `aggregation`, `aggregationField` (`DynamicBarChart/index.tsx:809–811`) |
| DataTable | `pageSize, showPagination, height, sortable, striped, hoverable, compact, showExpandButton` | `columns` |

Meanwhile `backend/.prompts/script-components/system.md` explicitly instructs the LLM to
set `aggregation`, `aggregationField`, and `columns` — none of which appear in the catalog
it is reading — and `validateAndRepairComponent` sets them a third time.

**A fourth disagreement, inside `Metadata` itself.** The descriptions encode the
*full-generator* contract, where the LLM writes SQL:

> `KPICard.description`: "…**Always use externalTool with SQL aggregation (COUNT/SUM/AVG) in
> `parameters.sql`** for metrics over all data."
> `KPICard.props.externalTool`: "(object) REQUIRED… **Put SQL with COUNT/SUM/AVG in
> `parameters.sql`**."

In the script flow that field is unconditionally replaced with
`{toolId, toolName, parameters: {queryId}}` (`script-component-generator.ts:390`), so the
SQL the model was told to write is discarded. We are spending prompt tokens instructing
behavior the flow throws away — and which §2.5 forbids outright, since the aggregate must
come from the script, not from component-authored SQL.

So the LLM is told to use fields the catalog says don't exist, for behavior we are about to
declare a bug (§2.5). Aligning these three is not cosmetic: it removes the only documented
reason the model reaches for client-side aggregation at all.

**Two smaller catalog defects, same root:**

- **Registered ≠ implemented.** Gauge, Treemap, Heatmap, CandleStick, EMap and LocationFlow
  are commented out of `COMPONENTS` (`superatom.ts:51–74`), yet
  `validateAndRepairComponent` still carries dedicated repair branches for `GaugeChart`,
  `TreemapChart` and `HeatmapChart` (`script-component-generator.ts:138, 168, 202`).
  Dead code today; a source of confusion when someone re-enables one.
- **`Home` and `DatabaseOverview` reach the chat catalog.** Their types are `'Home'` and
  `'DatabaseOverview'`, so the `type !== 'DashboardLayout'` filter at `superatom.ts:138`
  does not catch them. They are whole dashboard pages.

### Gap E — the answer flow is the only consumer that doesn't filter the catalog

`superatom.ts:138` strips just `Workflow_*` and `DashboardLayout`, then `sendComponents()`
lands the rest in the SDK's `this.components` (`index.ts:705`). Five consumers read that one
array, and four of them narrow it first:

| Consumer | Entry | Filter |
|---|---|---|
| **Answer flow (chat)** | `handleUserPromptRequest` (`index.ts:342`) | **none** |
| Suggestions | `handleUserPromptSuggestions` (`index.ts:364`) | `isDisplayComp === true` (`user-prompt-suggestions.ts:119`) |
| Dashboard components | `handleDashCompRequest` (`index.ts:430`) | strips `MultiComponentContainer` (`dashComp/utils.ts:82`) |
| Dashboard filters | inside dashComp | `type.startsWith('Filter')` (`create-filter.ts:45`) |
| Report components | `handleReportCompRequest` (`index.ts:446`) | strips `MultiComponentContainer` (`reportComp/utils.ts:79`) |

Neither `generateAgentComponents` nor `generateScriptComponents` filters, so the chat agent
is offered the entire catalog — each entry rendered with its **full props JSON**
(`agent-component-generator.ts:277`, `script-component-generator.ts:481`). Of roughly 28
entries, about 10 are valid answers:

| Group | Count | Examples |
|---|---|---|
| **Answer components** | 10 | Bar, Line, Pie, Scatter, Radar, Waterfall, DataTable, KPICard, MarkdownBlock, MapView |
| Dashboard interaction | 4 | Form, FilterDropdown, FilterTree, ApplyFiltersButton |
| Dashboard pages | 2 | Home, DatabaseOverview |
| UI primitives | ~10 | Card, Carousel, Tabs, Checkbox, FileUpload, Gallery, Input, List, MarkdownPreview, RichTextEditor |
| Debug | 1 | DebugPropsModal |
| The wrapper itself | 1 | `MultiComponentContainer` |

That last row is the sharpest: the answer flow **builds** a `MultiComponentContainer` as the
dashboard wrapper (`agent-user-response.ts:1419`) while simultaneously offering it to the
LLM as a candidate child. dashComp and reportComp both strip it explicitly; the answer flow
does not.

This is dead weight in the prompt and a live risk of the agent nominating a filter widget,
a text input, or a whole dashboard page as the answer to a data question. §2.6(c) narrows
it to 9.

> **Not a global filter.** Dashboard generation legitimately needs more than the answer
> flow does — `create-filter.ts:45` selects on `type.startsWith('Filter')`, and dashComp
> uses `DynamicForm`. Narrowing the catalog at `superatom.ts` would break dashboard filter
> generation. The narrowing belongs at the answer-flow entry, matching how every other
> consumer already filters for its own purpose.

---

## 2. Design

Seven parts. §2.1–2.3 are the correctness engine (author with full context, emit through a
typed channel, reject with actionable errors). §2.5 closes the number-fidelity gap — by
making the analysis and the component read the same column, not by verifying them against
each other (§2.4 records why the verification approach was dropped).
§2.6–2.7 make the contract and the render cap honest.

### 2.1 Component instructions move into MainAgent

MainAgent already holds everything the component step is currently guessing at: the user
question, the script it authored, `dataSummary` over all rows, a byte-budgeted row sample,
and the analysis it is about to write (`main-agent.ts:490–560`).

Distil the load-bearing rules from `backend/.prompts/script-components/system.md` into
`backend/.prompts/agent-main/system.md`:

- when to call `render_components` (after a successful `execute_script`, before writing the answer)
- the answer-component rule (one primary component, first in the list)
- **do not include a markdown block** — the flow adds the narrative from the final analysis (§2.4)
- axis role rules (x = TEXT/DATE, y = NUMBER)
- "every key must be a real returned column — never invent a measure"
- emit the grain each component needs; never rely on render-time aggregation (§2.5)

Keep this section **short**. The detailed rules live in the tool description and in the
validation error messages (§2.3), which are read exactly when they are relevant. MainAgent
already carries routing, SQL authoring, script authoring, and analysis; a fifth job stated
at length risks diluting the first four.

### 2.2 `render_components` — a tool, not a prose block

Registered alongside `write_script` / `execute_script` (`main-agent.ts:49`, `:82`;
dispatch at `:247–251`).

```ts
{
  name: 'render_components',
  description: '<projected 9-component catalog + config contract per component type>',
  input_schema: {
    type: 'object',
    properties: {
      layoutTitle:       { type: 'string' },
      layoutDescription: { type: 'string' },
      components: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            componentType: { type: 'string' },  // registered name, e.g. DynamicBarChart
            sourceRef:     { type: 'string' },  // executedQueries[].sourceId, or 'computed:_final'
            title:         { type: 'string' },
            description:   { type: 'string' },
            config:        { type: 'object' },  // axis/value keys — no aggregation (§2.5)
          },
          required: ['componentType', 'sourceRef', 'config'],
        },
      },
      actions: { type: 'array', items: { type: 'object' } },  // 3 follow-up questions
    },
    required: ['layoutTitle', 'components'],
  },
}
```

No `content` field and no `'markdown'` `sourceRef`: the narrative is not authored here
(V7/§2.4). Every entry binds a real dataset.

The input is exactly `ScriptComponentSpec[]` (`scripts/types.ts:240`) plus layout and
actions — the type the recipe already persists and `assembleComponentsFromSpecs`
(`script-component-generator.ts:720`) already consumes. No new data model.

**The catalog in the tool description is generated, never hand-written.** It is rendered
from the registered `Metadata` the frontend already sends (`sdk.getComponents()`,
`index.ts:716`) and filtered to the 9 answer components (§2.6). Hand-writing it would create
yet another source of truth alongside those in Gap D, and it would silently rot the next
time a component ships or is retired.

**Pass `Metadata.props` whole — do not trim it to a key list.** It is already a compact,
self-describing schema (~15 lines per component; nine of them is a couple hundred lines),
and its values carry the semantics a bare key list would lose:

```ts
config: {
  valueKey: 'Field name for the value from query result or tool outputSchema',
  prefix:   '(optional) Prefix for the value',
  …
}
```

**What the agent actually returns is far smaller than what it reads.** Only `props` — in
practice `title`, `description`, and `config`. Every other field is taken from the
registered template when the component is built
(`script-component-generator.ts:409–418`; `agent-component-generator.ts:232–235`):

| Field | Source |
|---|---|
| `id` | generated per render |
| `name`, `displayName`, `type`, `description`, `category`, `keywords` | the registered template |
| `externalTool` | **overwritten** by the flow with `{toolId, toolName, parameters: {queryId}}` |
| rendered / total row counts | stamped by the flow (§2.7) |
| `title`, `description`, `config` | the agent |

That output surface is exactly `ScriptComponentSpec`, which is why it is the right tool
schema — the agent is asked for precisely the fields it is allowed to decide.

**Why a tool and not instructions plus a prose block.** These are not alternatives: the
instructions go in the prompt either way (§2.1). The tool is the emission channel, and it
buys three things prose cannot:

1. **Schema validation at the tool-call layer** — no marker parsing. We already strip
   `<DashboardComponents>` blocks out of prose (`agent-user-response.ts:1143`) precisely
   because that pattern failed before.
2. **A rejection path.** A tool result can tell the agent it was wrong; the agent is still
   in its loop and can fix it. This is the entire correctness mechanism — see §2.3.
3. **Ordering.** The call is rejected unless a successful `execute_script` preceded it, so
   components can never be authored against data that doesn't exist.

A tool call is *not* a second LLM call — it is another turn in the same agent loop, on the
same cached prefix (`llm.ts:1725` puts the `cache_control` breakpoint on the system prompt,
which caches tools + system together).

### 2.3 The validation gate — reject with actionable errors

The tool handler validates every spec against the **real columns of the bound dataset**
before accepting. On any failure it returns a text tool result, not an exception, and the
agent retries (bounded — see §5).

Checks, in order:

| # | Check | Error returned to the agent |
|---|---|---|
| V1 | `sourceRef` matches an `executedQueries[].sourceId`, `computed:_final`, or `markdown` | `sourceRef "x" not found. Available: computed:_final, mssql-722b…` |
| V2 | Every config key resolves to an exact column | `yAxisKey "Revenue" is not a column. NUMBER columns: WSP, RSP, Qty. TEXT: District, Brand.` |
| V3 | `yAxisKey`/`valueKey`/`aggregationField` are NUMBER; `xAxisKey`/`nameKey`/`seriesKey` are TEXT/DATE | `xAxisKey "WSP" is NUMBER and yAxisKey "District" is TEXT — these look swapped.` |
| V4 | **`seriesKey` × `xAxisKey` is unique across rows** | `seriesKey "Brand" × xAxisKey "Date" → 340 rows for 45 unique pairs. The chart would show only the last value per cell. Pre-aggregate in the script, or drop seriesKey.` |
| V5 | **No component requires client-side aggregation.** A KPI bound to a multi-row dataset, or a `seriesKey` chart whose (series, category) pairs are not unique, is rejected — the script must emit that grain (§2.5) | `KPICard "Total WSP" is bound to computed:_final (1,204 rows) and would aggregate in the browser over a 250-row cap. Emit the total from the script — e.g. ctx.emit('summary', [{ TotalWSP: … }]) — and bind the card to it.` |
| V6 | DataTable: every listed column resolves | `columns[3].key "foo_dedup" is not a column.` (**partial** — see §2.5) |
| V7 | **No markdown block in the call.** The narrative is injected by the flow after the turn (§2.4), not authored here | `Do not include a DynamicMarkdownBlock — the narrative is added from your analysis after this call.` |
| V8 | **No completeness claim on a capped dataset.** If the bound dataset exceeds `MAX_ROWS_RENDERED`, the title/description must not say "all", "complete", "every", or carry a count that isn't the rendered count | `by_district returned 300 rows; 250 render. Title says "All Districts" — drop the completeness claim.` |

V4 is the fix for symptom 3 at the authoring layer: it detects exactly the shape the
frontend renders wrong (C3), before it ships.

`firstOfType()` guessing (Gap A) is removed from this path. Unresolvable keys are a
**rejection**, not a silent substitution — the agent that named the column is still in the
loop and can name the right one.

### 2.4 The tool result, and the narrative written after it

**Status: the markdown half shipped; the resolved-value half was dropped. See the box below.**

On success the tool confirms what bound to what:

```
✓ DynamicKPICard  "Total Price Observations" → computed:summary (1 rows)
✓ DynamicBarChart "Observations by Status"   → computed:_final (3 rows)
```

**The narrative is authored after this call, not inside it.** `render_components` emits data
components only — no `DynamicMarkdownBlock` (V7). The flow injects the markdown from the
final analysis text once the turn completes — mechanically what `assembleComponentsFromSpecs`
already does when the specs contain no markdown (`script-component-generator.ts:822`), which
V7 guarantees. One narrative, one source, authored last. It also moves the markdown guarantee
from "the agent must remember" to "the flow ensures", which is where a mandatory element
belongs.

> ### ⛔ Dropped: server-side resolved-value verification
>
> This section originally specified that the tool would **compute each component's rendered
> output server-side** — the KPI's aggregated value, the chart's resolved series — and return
> it so MainAgent could check its narrative before writing it. Two reasons that is no longer
> the right design:
>
> **1. §2.5 closed the gap structurally, so there is nothing left to verify.** The script
> emits `{ total: 81329 }`, the card binds `valueKey: 'total'`, and the analysis reads the
> same column. There is only ONE number, so analysis and component cannot disagree. Verified
> on two live runs: `₹303.66` in both the prose and the card; `81,329 / 4,192` in both.
> Symptom 1 is prevented, not detected.
>
> **2. Building it would create a fourth source of truth.** Computing a component's rendered
> output server-side means reimplementing what `DynamicKPICard` and `DynamicBarChart` do at
> render time — aggregation, series grouping, null handling, formatting. A second
> implementation that drifts from the frontend by one rounding rule reintroduces exactly the
> divergence class this whole document exists to remove (Gap B).
>
> **What is worth keeping** is the cheap part: for a KPI bound to a one-row dataset, echo the
> actual value in the tool result (`→ computed:summary: total = 81,329`). That is a column
> read, not a simulation, and carries no duplication risk. Full chart-series resolution buys
> the least and risks the most — do not build it.
>
> The residual gap (prose-only figures such as a percentage no component renders) would not
> have been caught by this mechanism either, since there is no component to compare against.
> It is recorded in §9 and belongs to evaluation harnesses.

The flow injects the markdown from the final analysis text once the turn completes —
mechanically what `assembleComponentsFromSpecs` already does when the specs contain no
markdown (`script-component-generator.ts:822`), which V7 guarantees. One narrative, one
source, authored last. It also means the markdown guarantee moves from "the agent must
remember" to "the flow ensures", which is where a mandatory element belongs.

Because nothing streams on this path (§5), the user reads the analysis as it streams and
then receives the complete dashboard — narrative block included — in one piece.

### 2.5 Emit the right grain — no aggregation at render time, client or server

The component spec stays **declarative** and the frontend keeps fetching. We do *not*
freeze values into props.

Freezing would break three behaviors the current design depends on:

| Behavior | Where | What a frozen value would do |
|---|---|---|
| Filters / drill-down re-execute the query with new params | `external-tools.ts:174` (`hasOverrides` → re-run) | Card keeps showing the unfiltered number while the table beside it refetches |
| Expired script datasets are regenerated by re-running the recipe — *"never persist stale computed rows"* | `external-tools.ts:189` | Card shows an authoring-time number against freshly regenerated rows |
| Cached conversations are rehydrated and re-fetched | `agent-user-response.ts:130` (`rehydrateCachedComponent`) | Every replay shows the number from the day it was authored |

The codebase already took this position once: `assembleComponentsFromSpecs` deliberately
**regenerates** the markdown summary on replay rather than replaying stored content,
because "the stored content has authoring-time numbers"
(`script-component-generator.ts:766`). The same reasoning applies to a KPI value.

So the defect in Gap B was never *who holds the value*. It is **who performs the
derivation, and over how many rows** — today the browser reduces, over a payload capped at
250 rows.

The fix is to eliminate the derivation entirely: **the script emits data at the grain each
component renders, and each component binds 1:1 to a dataset of that grain.** A KPI binds
to a one-row summary dataset and displays a column. A grouped chart binds to a dataset
that is already one row per (series, category). Nothing aggregates at render time —
client-side *or* server-side — because the aggregation was done in SQL, over the complete
set, by the script.

`ctx.emit(name, rows, meta)` (`script-bootstrap.ts:178`) already provides this. Each call
pushes a `computed:<name>` entry into `executedQueries` as its own virtual source, which
gets its own `queryId` and is bindable via `sourceRef` like any other:

```js
// in the authored script
const detail = await ctx.query(srcId, `SELECT District, Brand, Date, WSP FROM ...`);
ctx.emit('summary',     [{ TotalWSP: 41200, DistrictCount: 23 }]);          // KPI grain
ctx.emit('by_district', [{ District: 'Anjaw', WSP: 41200 }, /* … */]);      // chart grain
return { data: detail, count: detail.length };                              // table grain
```

→ `computed:summary` (1 row), `computed:by_district` (23 rows), `computed:_final` (detail).
The KPI reads `data[0].TotalWSP` with **no** `aggregation` set; the bar chart binds
`x=District, y=WSP` against a dataset with no duplicate keys; the table binds the detail.

**This is the strongest version of the fix, because it removes the failure modes rather
than guarding them:**

| Defect | Why it can no longer occur |
|---|---|
| KPI ≠ analysis (symptom 1) | Both read the same column of the same emitted dataset. There is no second computation to disagree. |
| Render cap corrupts totals | The total is a column in a 1-row dataset, so the cap cannot touch it. (The cap still applies to every *other* dataset — see §2.7.) |
| C3 grouped-bar last-row-wins | The bound dataset has one row per (series, category), so `seriesMap.set()` never overwrites. |
| C1/C2 silent `count` fallback | `data[0][yAxisKey]` is always present and `config.aggregation` is never set, so `needsAggregation` is false. |
| C4/C5 KPI avg/row-0 | No client-side reduction path is taken. |

It also needs **no new API surface**: no `derive` parameter, no response-envelope change, no
cache-key change. `executeByQueryId` is untouched, and freshness is unchanged — each
dataset refetches, and `computed:*` datasets regenerate by re-running the recipe on cache
miss (`external-tools.ts:189`).

This is `SCRIPT-COMPONENT-CONSISTENCY.md` Phase 2 ("script is the single source of truth
for numbers") carried to its conclusion: Phase 2 required every *stated* number to be a
column; this requires every *rendered* number to be a column too.

**The invariant, stated plainly:** *client-side aggregation is a bug, not a feature.* A
component that needs `config.aggregation` set is a signal that the script emitted the wrong
grain. That makes the validation rule sharper than the coherence check in §2.3 — see V5.

**What this demands, honestly.** The agent must plan the component shapes while writing the
script, and a five-component dashboard means several `ctx.emit` calls. The script gets
longer. That is real work, but it is *verifiable* work — an emitted dataset either has the
right columns or it doesn't, unlike a chart config, whose wrongness is only visible in the
rendered pixels. And it is exactly the loop `render_components` closes: if the agent binds
a KPI to a 1,204-row dataset, validation rejects it and the fix goes back into the script,
where it belongs.

**Frontend changes** are now *defence in depth* rather than the fix. They still matter,
because the fallback generator path and older cached dashboards continue to ship
recipe-style specs:

- `DynamicBarChart:810` — `|| 'count'` must not be the silent default. With no
  `aggregationField`, use `yAxisKey`; if `data[0][yAxisKey]` is missing, render an error
  state rather than counting rows (C1, C2).
- `DynamicKPICard:733/730` — `avg` must divide by the count of numeric values, not
  `dataArray.length` (C4).
- Surface `meta.truncated` — a component rendering a capped set should say "first 250 of
  1,204" rather than implying completeness. Today nothing tells the browser its payload was
  capped.

And one generator fix for C6: the DataTable branch drops only the **unresolvable** entries
and keeps the rest; it falls back to "all columns" only if fewer than two survive. Combined
with a `_`-prefix convention for script-internal columns that `DynamicDataTable` hides by
default, symptom 4 closes.

### 2.6 Align the component contract to one source of truth

Gap D is a prerequisite, not a cleanup task: the agent cannot author correctly against a
catalog that disagrees with the prompt and with the code. Five changes make `Metadata`
authoritative.

A full audit of the 9 allowlisted components found the contract inconsistent in **both**
directions:

- **Read and validated, but never declared:** `aggregation`, `aggregationField` (KPICard),
  `groupBy` (BarChart), `columns` (DataTable)
- **Declared, but never validated:** `dimensionKey` (Radar), `sizeKey` (Scatter), the five
  MapView geo fields, `metricLabels` (Bar/Line)

**(a) Project the descriptions in the answer-flow catalog builder — do NOT rewrite the
stored `Metadata`.**

Seven of nine descriptions and eight of nine `externalTool` values instruct the model to
author SQL into `parameters.sql` — a field the script flow unconditionally overwrites
(`script-component-generator.ts:390`):

| Component | `description` | `props.externalTool` |
|---|---|---|
| BarChart | "Always use externalTool with **SQL GROUP BY** … in `parameters.sql`" | "Put SQL with GROUP BY in `parameters.sql`" |
| LineChart | "…**SQL GROUP BY** for time-series…" | same |
| PieChart | "…**SQL GROUP BY** for distributions…" | same |
| ScatterChart | "…**SQL** for data points…" | same |
| RadarChart | "…**SQL GROUP BY**…" | same |
| DataTable | "…**SQL** in `parameters.sql` to fetch rows" | same |
| KPICard | "…**SQL aggregation (COUNT/SUM/AVG)**…" | same |
| **MarkdownBlock** | *clean — describes what it renders, names its one prop* | *(none)* |
| MapView | clean | "REQUIRED. `{ toolId, toolName, parameters: { sql: "…" } }`" |

**But that SQL contract is correct for two of the three consumers.** `dashComp` reads
`props.query` and `externalTool.parameters.sql`, limits both, and executes the SQL
(`pick-component.ts:280–296, 378`); the dash-comp-picker prompt references SQL five times,
report-comp-picker twice. Rewriting the shared `Metadata` would fix the answer flow by
breaking dashboard and report generation.

So the answer-flow catalog builder (§2.6e) **projects** rather than mutates: it already
filters to 9 components, and it additionally rewrites each entry's `description` and drops
`props.externalTool` / `props.query` when rendering the tool description. One stored source
of truth, one projection per consumer — the same pattern the codebase already uses for
filtering, applied one level deeper.

The projected description states what the component *renders* and what grain it needs —
e.g. KPICard: *"Displays a single metric. Bind to a source whose value is already one row;
do not aggregate."* The projection also rewords the config keys' *"MUST exactly match a
column name returned by the SQL query"* to *"…of the bound dataset"*.

**MarkdownBlock is the template to copy** — it is the only one of the nine already correct,
and (per §2.4/F3) it is excluded from the tool schema anyway.

No shared frontend component files are touched by (a).

**(b) Drop the client-aggregation fields from the *tool* contract — but keep them in the
fallback prompt.** `aggregation`, `aggregationField` and `groupBy` were never declared in
`Metadata`, and §2.5 makes them unnecessary on the primary path: the script emits the grain,
so nothing aggregates at render time. The projected tool catalog therefore omits them, and
V5 rejects any spec that needs them.

**`backend/.prompts/script-components/system.md` keeps its aggregation guidance.** That
prompt governs the *fallback* generator, which runs precisely when `render_components` was
not called — meaning the script was almost certainly not authored with per-component emits
either. Stripping aggregation there would leave the fallback with a multi-row dataset and no
way to express a total. Scope the removal to the tool path; the fallback stays as-is.

Components keep reading these fields, so older cached dashboards and the fallback path
continue to render unchanged.

**(c) Declare `columns` on DataTable.** It is load-bearing — the prompt requires it, the
component reads it, symptom 4 is caused by mishandling it — and it is the one undeclared
field we must keep. Add it to `DynamicDataTable`'s `Metadata.props.config` with its real
shape (`[{ key, label }]`).

**(d) Extend validator coverage to every declared key.** `ALL_KEY_NAMES`
(`script-component-generator.ts:93`) plus the per-type branches only ever touch ten keys:
`aggregation, aggregationField, categoryKey, columns, metricKeys, nameKey, seriesKey,
valueKey, xAxisKey, yAxisKey`. Eight declared column-referencing keys fall outside it:

| Component | Unvalidated key(s) | Consequence |
|---|---|---|
| RadarChart | `dimensionKey` | The Radar branch (`:239`) handles only `valueKey`; a hallucinated dimension column passes through untouched |
| ScatterChart | `sizeKey` | Bubble-size column never resolved or dropped |
| MapView | `latitudeField`, `longitudeField`, `labelField`, `orderField`, `stageField` | **No MapView branch exists** — it falls to `default:`, and none of its keys are in `ALL_KEY_NAMES`. MapView configs are entirely unvalidated |
| Bar / Line | `metricLabels` | `metricKeys` is filtered at `:128`, `metricLabels` is not — the parallel arrays desync and series get the wrong labels |

Add the missing keys to `ALL_KEY_NAMES`, add a `MapView` branch (lat/lon must be NUMBER;
label/order/stage must resolve), and filter `metricLabels` in lockstep with `metricKeys`.

**This gates the tool.** Shipping `render_components` before this leaves Radar, Scatter and
MapView with the new authoring path and none of the checking — the current failure mode with
a better-informed author. See §6.

**(e) Filter the chat catalog to answer components — in the SDK, at the answer-flow entry.**

**Not in the frontend.** `superatom.ts:138` is the wrong place: the filter components must
keep reaching the SDK, because `create-filter.ts:45` selects on `type.startsWith('Filter')`
to build dashboard filters. Narrowing the catalog at the source would starve that path.

The correct pattern is the one the codebase already uses (Gap E): **each consumer filters at
its own entry, for its own purpose.** dashComp strips the container, create-filter selects
`Filter*`, suggestions selects `isDisplayComp`. The answer flow should do the same — a
single `answerComponents(components)` helper applied in `get_agent_user_response` before the
array reaches `generateAgentComponents` / `generateScriptComponents` / `render_components`.

The allowlist is **9 components** — the complete surface for a chat answer:

| Question shape | Component |
|---|---|
| Single value | `DynamicKPICard` |
| Category breakdown | `DynamicBarChart`, `DynamicPieChart` |
| Time series | `DynamicLineChart` |
| Correlation | `DynamicScatterChart` |
| Multi-dimensional comparison | `DynamicRadarChart` |
| Detail rows | `DynamicDataTable` |
| Narrative (mandatory in every response) | `DynamicMarkdownBlock` |
| Geo | `DynamicMapView` (Leaflet) |

Everything else in the catalog is excluded: `MultiComponentContainer` (the wrapper this flow
builds — it cannot also be a child), interaction components (`Form`, `FilterDropdown`,
`FilterTree`, `ApplyFiltersButton` — dashboard-only, and required there by
`create-filter.ts:45`), dashboard pages (`Home`, `DatabaseOverview`), `DebugPropsModal`, and
the UI primitives (`Card`, `Carousel`, `Tabs`, `Checkbox`, `FileUpload`, `Gallery`, `Input`,
`List`, `MarkdownPreview`, `RichTextEditor`).

> **Deliberately deferred: `DynamicWaterfallChart`.** It is registered
> (`superatom.ts:64`) and `validateAndRepairComponent` already handles it (`:179`), so
> adding it is a one-line allowlist change. It covers the one analytical shape the 9 cannot
> express — variance / bridge analysis ("how did we get from last quarter's margin to this
> quarter's", price build-up, contribution-to-change). Without it such questions fall back
> to a bar chart, which shows the parts but not the bridge. Add it if variance questions
> surface; this is an omission by choice, not oversight.

**Do not repurpose `isDisplayComp`.** It is *in use* at `user-prompt-suggestions.ts:119`,
and its current values (`true` only on map views) mean something else entirely — changing
them to express "is an answer component" would silently break suggestions. Either add a new
explicit flag (`answerComponent?: boolean` on `ComponentMetadata`) or keep the allowlist in
the SDK helper. The allowlist is the smaller change and needs no frontend rebuild; the flag
is more durable when someone adds a component. Decide before implementing.

**Also worth doing while here** (not blocking): delete the `GaugeChart` / `TreemapChart` /
`HeatmapChart` branches from `validateAndRepairComponent`, or re-register those components.
Repair logic for components that cannot be picked is dead code that reads as supported.

### 2.7 The render cap: disclose, never restrict

`storeScriptDatasetQuery` (`agent-user-response.ts:212`) caps **every** entry in
`executedQueries` at `MAX_ROWS_RENDERED` (250), emitted datasets included — not just detail
lists. Today that truncation is silent apart from a `logger.warn`, so a 300-row
`by_district` renders 250 districts beside a KPI computed over all 300, and the two disagree
in exactly the way symptom 1 describes.

**The cap stays at 250 and applies universally.** Beyond a couple of hundred rows a detail
list is unreadable, and the cap also bounds the in-memory `queryCache`. It is a deliberate
product decision, not a defect.

**No per-component cardinality limits.** We do *not* reject a pie chart for having too many
slices or a bar chart for having too many bars. The agent authoring the script knows the
question; if it warrants a top-25, the script returns 25. Hard-coded display thresholds
would be arbitrary, would fight the author, and would need re-tuning per client and per
question type.

**What changes is disclosure.** A truncated dataset must say so, on the component:

1. `buildScriptComponent` already holds the **uncapped** `targetQuery.data.length` and knows
   the cap, so it stamps the rendered and total counts onto props at build time — no
   fetch-path change and no response-envelope change.
2. The component renders it (e.g. a subtitle: *"Showing 250 of 300"*) whenever
   rendered < total.
3. V8 blocks the spec from *contradicting* it — a title claiming "All Districts" over a
   capped dataset is rejected.

Disclosure is injected deterministically rather than left to the model. The existing
count-word rule in `script-components/system.md` asks the LLM to get this right in prose,
and §1 documents it failing; a value the flow already knows should not be re-derived by an
LLM.

---

## 3. Paths and fallbacks

There are three paths that produce components. Only the first changes.

| Path | Today | After v2 |
|---|---|---|
| **Fresh authoring** — MainAgent writes + runs a script (`agent-user-response.ts:1198–1322`) | `generateScriptComponents` (separate LLM call, 3 sample rows) | `render_components` tool call inside MainAgent |
| **Recipe replay** — matched script, tier `high` (`:714`) | `assembleComponentsFromSpecs` — deterministic, no LLM | **Unchanged.** Still deterministic. The specs it replays are now agent-authored and validated. |
| **Fallback** — agent didn't call the tool, or specs drifted, or no script was authored | `generateScriptComponents` → `generateAgentComponents` | **Unchanged.** Both stay. |

`generateScriptComponents` is **not deleted**. It remains the fallback when MainAgent
doesn't call the tool, and the shared validation gate (§2.3) is factored so both paths run
it. Recipe replay never runs MainAgent at all, so removing the standalone generator would
leave the replay-drift case with nothing to fall back to.

Specs authored via the tool are persisted onto the recipe exactly as today
(`agent-user-response.ts:758`), so the next replay is deterministic and free.

---

## 4. Files

| File | Change |
|---|---|
| `sdk-nodejs/src/userResponse/scripts/component-validator.ts` *(new)* | V1–V8 + resolved-result computation. Pure, unit-testable, no LLM. Shared by the tool and the fallback generator |
| `sdk-nodejs/src/userResponse/component-catalog.ts` *(new)* | §2.6(a)+(e) — `answerComponents(components)`: filter to 9 **and** project each entry's description / drop `externalTool`+`query` for the tool catalog |
| `sdk-nodejs/src/userResponse/agents/main-agent.ts` | Register `render_components`; dispatch handler; gate on a prior successful `execute_script`; surface `executedQueries[].sourceId` in the tool description |
| `sdk-nodejs/src/userResponse/agents/types.ts` | `savedScript.componentSpecs` on the agent response |
| `sdk-nodejs/src/userResponse/agent-user-response.ts` | Prefer agent-authored specs, else `generateScriptComponents`; §2.6(e) apply `answerComponents()` once before any generator; §2.4 inject the markdown block from the final analysis after the turn |
| `sdk-nodejs/src/userResponse/scripts/script-component-generator.ts` | Replace `firstOfType` guessing with rejection; call the shared validator; §2.6(d) extend key coverage + MapView branch + `metricLabels` lockstep; partial DataTable column retention (C6); §2.7 stamp rendered/total counts in `buildScriptComponent` |
| `sdk-nodejs/src/userResponse/prompts.ts` | `SCRIPT_BODY_CONTRACT`: require one `ctx.emit` per non-detail component grain (KPI summary rows, pre-grouped chart datasets) |
| `backend/.prompts/agent-main/system.md` | Component-authoring section (short) |
| `frontend/src/types.ts` | §2.6(e) — `answerComponent?: boolean` on `ComponentMetadata`, **only** if the flag option is chosen over the SDK allowlist |
| `frontend/src/shared-modules/DynamicDataTable/index.tsx` | §2.6(c) declare `columns` in `Metadata`; hide `_`-prefixed columns |
| **The 8 data components** (all allowlisted except MarkdownBlock) | §2.7 — render the "Showing N of M" disclosure when rendered < total |
| `frontend/src/shared-modules/DynamicKPICard/index.tsx` | *(defence)* fix `avg` denominator and null coercion |
| `frontend/src/shared-modules/DynamicBarChart/index.tsx` | *(defence)* remove silent `count` default; error state on missing `yAxisKey` |

**Not touched:** `backend/src/collections/external-tools.ts`, `handlers/data-request.ts`
(no fetch-API or cache-key change), and the stored `Metadata` of any shared component
(§2.6a projects instead of rewriting, so dashComp/reportComp are unaffected).

Frontend changes require `pnpm build` + reload (built Vite bundle). SDK changes go live via
`pnpm build` in `sdk-nodejs/` + backend restart.

---

## 5. Guardrails

- **Retry bound.** Max 2 `render_components` retries per turn. On exhaustion, log the last
  validation errors and fall through to `generateScriptComponents` — never end a turn with
  no dashboard.
- **Prompt interference.** The system-prompt section stays short; detail lives in the tool
  description and error strings. If SQL-authoring quality regresses after this lands, that
  section is the first suspect.
- **Cache invalidation.** Adding a tool changes the `tools` array, which sits at prefix
  position 0 — a one-time cache invalidation for in-flight conversations at deploy. Expected,
  not a defect.
- **Streaming: the agent-authored path does not stream an answer component at all.**
  Answer-first streaming existed to mask a component-generation LLM call made *after* the
  analysis. This path makes no such call — the specs are authored inside MainAgent's turn,
  and assembly is deterministic binding — so the dashboard is ready when the text ends.
  `componentStreamCallback` is therefore left `undefined`, exactly as the replay path already
  does (`agent-user-response.ts:694`): `message.isAnswerComponent` stays false and the **full
  dashboard renders inline**, instead of one component with the rest behind "View more
  details".

  This also removes a live defect rather than papering over it. Each `__ANSWER_COMPONENT__`
  marker **replaces** `schema.ui` wholesale (`runtime-react/src/stores/promptResponseHandler.ts:234`),
  so the last marker wins. `assembleComponentsFromSpecs` streams the first data component
  (`script-component-generator.ts:834`) *and* the injected markdown (`:847`) — harmless while
  the replay path passed no callback, but with a live one the markdown would overwrite the
  answer component and the user would see narrative text where the chart belongs.

  **Keep streaming on the other paths.** `generateScriptComponents` and
  `generateAgentComponents` still run a real LLM call after the analysis, so early streaming
  still earns its place there. This is a per-path decision, not a removal — the
  answer-first / "View more" machinery in runtime-react stays.

  **One beat remains.** `summarizeToMarkdown` (~1–2s) condenses the analysis into the
  markdown block, so the dashboard lands just after the text rather than with it. Kept
  deliberately: the alternative is a block that repeats verbatim the answer the user has
  already read.

---

## 6. Build order

Each step is independently shippable and independently verifiable.

1. **`component-validator.ts` (V1–V8) + full key coverage (§2.6d), wired into the existing
   `generateScriptComponents`.** No agent changes. This alone answers whether a given bad
   dashboard was a bad spec or a frontend bug — the highest-value diagnostic we don't
   currently have. Coverage ships with it: validating 6 of 9 components is not a gate.
2. **Frontend silent-fallback fixes** (C1, C2, C4) + the §2.7 disclosure — convert wrong
   output into visible output. Needed before the rest, or later fixes are unmeasurable.
3. **Contract alignment** (§2.6a/b/c/e) — `component-catalog.ts` projecting and filtering to
   9, `columns` declared on DataTable, aggregation dropped from the *tool* catalog (the
   fallback prompt keeps it). Do this *before* step 4: the tool's catalog is what the agent
   authors against, so it must be trustworthy first.
4. **`render_components` tool + dispatch + prompt section** (§2.1–2.3), with the catalog
   from `answerComponents(sdk.getComponents())`.
5. **Emit-the-right-grain** (§2.5) — `SCRIPT_BODY_CONTRACT` update + V5 enforcement +
   DataTable column retention (C6).
6. ~~**Resolved-result feedback**~~ — **dropped, see the box in §2.4.** §2.5 prevents the
   analysis-vs-component mismatch rather than detecting it, and server-side render
   simulation would add a fourth source of truth. The markdown-injection half of this step
   shipped early, with step 4, because V7 rejects agent-authored markdown and something had
   to supply the narrative. Optional leftover: echo a one-row KPI's actual value in the tool
   result — a column read, not a simulation.

---

## 7. Reversal of a prior decision

`SCRIPT-COMPONENT-CONSISTENCY.md` §4 ruled the agent-authored approach out of scope, on two
grounds. Both are addressed rather than dismissed:

> *"it does not address the frontend-renders-columns reality"*

Correct, and still correct — which is why §2.5 changes what the frontend is asked to
render. The frontend does render columns, so the answer is to make the script emit a column
that *is* the number, at the grain the component needs. Moving the authoring into MainAgent
**without** that would not have fixed symptom 1, which is why §2.5 is part of this plan
rather than a follow-up.

> *"the hot path (tier-`high` replay) has no MainAgent at all"*

Also correct. Replay keeps the deterministic recipe path unchanged (§3). MainAgent authors
the specs once; replay rebinds them without an LLM. The two are complementary, not
competing.

What has changed since that doc: Phase 1 shipped and we can now see *how* its repair layer
fails — it guesses (Gap A) rather than rejecting, and it validates a spec in isolation
rather than against a rendered result. Those are not fixable by adding more rules to the
same one-shot pass; they need an author that can be told it was wrong.

---

## 8. Acceptance

1. **Symptom 1** — on a question whose underlying data exceeds `MAX_ROWS_RENDERED`, the
   headline number in the analysis equals the KPI card's value, because both read the same
   column of the same 1-row emitted summary.
2. **Symptom 2** — a bar chart bound to a measure column renders that measure. No chart
   ever silently displays row counts.
3. **Symptom 3** — a grouped bar chart over un-pre-aggregated detail rows is rejected at
   authoring (V4/V5) and re-authored against an emitted per-(series, category) dataset.
   Never last-row-wins.
4. **Symptom 4** — a curated DataTable keeps its curated columns when one key is bad;
   script-internal columns never appear unless asked for.
5. **Truncation is never silent** — any component bound to a dataset above the cap shows
   "Showing N of M", and no title claims completeness (§2.7, V8).
6. **No regression** — recipe replay still issues zero component-generation LLM calls; the
   fallback path still produces a dashboard when the tool is never called; dashboard and
   report generation are byte-identical (no shared `Metadata` was mutated).
7. **Diagnostics** — every rejected component appears in `superatom-sdk.log` with the
   validation error and the agent's retry, so failures are inspectable rather than silent.

---

## 9. Open questions

- **Where do the component-authoring rules live long-term?** Split across
  `agent-main/system.md` and the tool description is a compromise. If SQL quality regresses,
  the alternative is a dedicated second MainAgent turn with a swapped system prompt.
- **Dashboard filters against emitted datasets.** A filter widget re-executes with
  `filterParams` (`external-tools.ts:174`), and `computed:*` datasets regenerate by
  re-running the recipe. For the filtered KPI to be correct, the script must accept the
  filter as a parameter and recompute its summary. That works today via script params, but
  it means a filtered dashboard depends on the script declaring the right knobs. Fine for
  the chat flow; needs a decision before emitted datasets back filterable dashboards.
- **How many emits is too many?** A five-component dashboard implies several datasets, each
  taking a `queryCache` slot (cap 5000, TTL 10 min). Summary datasets are one row so the
  memory cost is trivial, but the cache-entry count grows per answer. Probably fine;
  worth measuring before it surprises us.
- **Prose-only figures are still unverified.** §2.5 guarantees that a number rendered by a
  component matches the analysis, because both read the same column. It says nothing about a
  figure the analysis states that NO component renders — a percentage computed in prose
  (`4,192 / 81,329 = 5.2%`), a ratio, a period-over-period delta. The dropped §2.4 mechanism
  would not have caught these either: with no component to compare against, there is nothing
  to check it against. Enforcing it needs the old Phase-2 policy made real — every number the
  analysis states must exist as a column in an emitted dataset. **Deferred to evaluation
  harnesses.**
- **Allowlist in the SDK, or a flag on `ComponentMetadata`?** §2.6(e) works either way. The
  SDK allowlist ships without a frontend rebuild and keeps the answer-flow policy next to
  the answer flow; a `answerComponent?: boolean` flag is more durable — a new component
  declares its own eligibility instead of waiting for someone to remember the allowlist.
  Repurposing `isDisplayComp` is **not** an option: it is live at
  `user-prompt-suggestions.ts:119`.
- **Do the six disabled components come back?** Gauge, Treemap, Heatmap, CandleStick, EMap
  and LocationFlow are commented out of `COMPONENTS`. If any return, they need `Metadata`
  that matches what they read — the same audit as Gap D — before the agent can author
  against them.
- **Multi-source dashboards.** Federation specs are already excluded from deterministic
  replay (`script-component-generator.ts:756`). Should `render_components` accept them at
  all, or force scripts to combine in JS first (current de-facto behavior)?
