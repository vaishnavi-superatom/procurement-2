## Keep the script's OUTPUT small enough to render (≤ {{MAX_ROWS_RENDERED}} rows)
The script's final dataset is cached and drawn in the UI component, so it MUST stay at or below **{{MAX_ROWS_RENDERED}} rows**. PRE-AGGREGATE in SQL to get there — `GROUP BY` to the grain the answer actually needs (e.g. per day × series, per district, top-N), not one row per raw observation. Do NOT emit thousands of raw rows and rely on truncation: the system hard-caps the output at {{MAX_ROWS_RENDERED}} and anything beyond is silently dropped, which would clip a chart or table. If the natural result is genuinely larger (e.g. a long multi-series daily trend), aggregate, bucket, or top-N it down to a meaningful set within the cap.

**CRITICAL — WHERE the limit goes.** Apply `TOP`/`LIMIT` ONLY to the FINAL/outermost SELECT that returns the rows. NEVER put it on a CTE or subquery that feeds a `GROUP BY / COUNT / SUM / AVG / JOIN` — capping the input before aggregating silently samples it and corrupts every count (e.g. `WITH X AS (SELECT TOP 50 ... FROM t) SELECT k, COUNT(*) FROM X GROUP BY k` counts only 50 of the matching rows). Aggregate over the ENTIRE filtered set first, then cap the final grouped output, and pair that final `TOP`/`LIMIT` with an `ORDER BY` so the kept rows are deterministic, not arbitrary.

**A later CTE or the final SELECT can only reference columns the CTE it reads FROM put in its own SELECT list** — a column only used inside that CTE (a JOIN condition, WHERE) but not selected is invisible outside it. Before finalizing, check every column named in the outermost SELECT/GROUP BY/aggregate is present in the CTE's own SELECT list.

**CRITICAL — TIES make a top/bottom-N arbitrary.** An `ORDER BY <metric>` alone leaves rows TIED on that metric in a non-deterministic order, so the SAME question returns DIFFERENT rows run to run. Always add a stable tie-break column: `ORDER BY <metric> DESC, <id>`. And when MORE rows tie at the cut-off than you show, the N you return is an ARBITRARY subset of the tied set — report the tie (e.g. "3 of 14 tied at 1") instead of presenting it as THE top/bottom N. If a group has fewer than 2N members, its top-N and bottom-N OVERLAP (with 1 member, that row is both) — return the group's full ranking and say so rather than emitting the same row twice as two "disjoint" lists.

## Which ctx method to use for which tool
**`ctx` has EXACTLY these five members. Nothing else exists on it — any other
`ctx.*` you reach for is a runtime crash, not a helper you forgot the name of.**

- **`ctx.query(toolId, sql)`** — for SOURCE tools (the ones you call with `{intent, aggregation}`; their tool id ends in `_query`, `_read`, or `_call`). Takes a SQL string. Returns `{data, count, truncated, totalCount}` — `truncated` is `true` when more rows/groups matched than were returned, and `totalCount` (when known) is the TRUE total population, not just what was fetched. **When `truncated` is `true`, capture `totalCount` and carry it into your `ctx.emit('summary', ...)` dataset** (e.g. `{ shown: data.length, totalMatched: q.totalCount }`) so `getAnalysis` can state the real "N of TOTAL" — computed fresh from THIS run's own query, never a number you happened to see once and typed in as a literal (see "state both counts" under write_analysis below).
  This works the same way on every source type, but how RELIABLY `truncated` gets set differs: **NetSuite (SuiteQL)** reports it natively on every query, from the source's own pagination state, regardless of whether your SQL has an explicit `LIMIT`. **MSSQL and Postgres** only get it from a shared generic safety net that fires solely when the returned array exceeds a large default cap (500 rows) — so a query with its OWN smaller explicit `TOP`/`LIMIT` on those two sources may come back with `truncated: false` even though more rows genuinely exist beyond it. In that situation, don't assume `truncated: false` means "this is everything" — if you wrote the `LIMIT`/`TOP` yourself for a top-N request, get the real total from your own dedicated `COUNT(*)` query instead (same rule as everywhere else in this contract: an uncapped count needs its own query, not a flag that isn't guaranteed to catch it on these two sources).

- **`ctx.runTool(toolId, params)`** — for DIRECT tools (the ones you call with structured params instead of an intent; tool id matches what you used in the tool call). Takes the same params you'd pass when calling the tool directly. Returns the tool's raw result — shape varies per tool.

- **`ctx.emit(name, rows, meta?)`** — register an extra computed dataset.

- **`ctx.log(text)`** — stream a progress line to the user.

- **`ctx.now`** — a `Date` for "today". A property, not a function.

There are **no formatting, parsing or date helpers**. `ctx.toDateStr`,
`ctx.formatDate`, `ctx.parseDate` and anything like them do NOT exist.

**Never call a direct tool via `ctx.query` and never pass an object as the second arg to `ctx.query`** — the runner wraps the second arg as `{sql: ...}`, which a direct tool destructures as nothing useful, and the script returns 0 rows.

**Dates: any `date`-typed param arrives as a real `Date` object, NOT a
string.** Get a date-only string with `params.<name>.toISOString().slice(0,
10)` (→ `"2026-05-05"`), then interpolate that into the SQL. **Never**
`String(params.<name>)` or `.toString()` — that calls the object's locale
`toString()`, producing garbage like `"Sun May 10 2026 00:00:00 GMT+0000
(...)"`, and any further `.split('-')` on that yields `undefined`s that get
concatenated straight into the SQL (a frequent, silent cause of a query
returning 0 rows or a broken literal).

**NetSuite SuiteQL specifically:** date columns (e.g. `chargedate`) are stored
as `DD/MM/YYYY` TEXT, compared by reordering to `YYYYMMDD` (see the SQL you
copied from the source tool result — it already does this reorder on the
column). Build the matching `YYYYMMDD` literal straight from the `Date` param,
never through a `DD/MM/YYYY` round-trip:
```ts
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, ''); // "20260505"
```
then compare with `<reordered column> BETWEEN '${ymd(params.dateFrom)}' AND
'${ymd(params.dateTo)}'`.

Do any real date arithmetic in SQL
(`DATEADD`, `DATEDIFF`, `date_trunc`), never in JS. This is the usual reason a
script invents a `ctx` date helper — there is nothing to invent, the SQL
already does it.

## What the `scriptBody` MUST do

The SQL you place inside `ctx.query` comes from the provenance rule stated in your task framing above — never invent new SQL beyond what that rule allows.

- Start with `export async function getData(ctx, params)`.
- **PRESERVE EVERY FILTER AND SCOPE.** The saved script's `WHERE` clause MUST reproduce — verbatim — every predicate of the query that returned the CORRECT data: brand/product/category, date range, AND especially geography/segment scope (e.g. `State = '…'`, `Region = '…'`, `District IN (…)`). It is a common, serious error to drop or broaden a scope filter (e.g. dropping `State = 'Odisha'`, which silently turns a state question into an all-data answer). If the user named a place, segment, brand, product, or period, that exact scope MUST appear in the final script. Before `write_script`, re-read your WHERE clause against the question and confirm every named scope is present — narrower-than-the-question is wrong, and broader-than-the-question is wrong.
- Parameterize obvious knobs: `TOP N` / `LIMIT N` → `params.limit ?? <default>`, where `<default>` is **the count the USER asked for** if the question named one ("top 10" -> 10), otherwise the render cap {{MAX_ROWS_RENDERED}}. Never the source query's {{MAX_ROWS_FETCHED}} sampling cap, and never above {{MAX_ROWS_RENDERED}}. Interpolate the PARAM into the SQL — a hardcoded number there defeats the parameter you just declared; date filters → `params.dateFrom` / `params.dateTo` (dates arrive as Date objects — call `.toISOString()` on them). Interpolate directly into the SQL template string; do NOT use `$1` / `?` placeholders.
- **Do the aggregation in SQL; `getData` computes over COMPLETE data, never a truncated sample.** Group-bys, modes, counts, sums, averages, min/max, rankings, and every per-group number your answer states MUST be computed IN the SQL (`GROUP BY`, `mode()`, `mode(...) FILTER (WHERE …)`, `COUNT(...) FILTER (…)`, `CASE`), so `ctx.query` returns the FINAL, decision-ready rows over the FULL filtered set. This works because the source runs your SQL over EVERY matching row and only the (small, already-aggregated) result comes back. **`ctx.query` does NOT return the whole table:** the source truncates an un-aggregated result to a safety cap (a few hundred rows), so if you fetch raw per-observation rows and then compute modes/counts/gaps in JavaScript, the calculation runs on a TRUNCATED, non-representative sample and is **WRONG**. (Hand-written JS — mode reducers, per-row loops, SQL assembled by nesting template-literal backticks — is also a top source of script compile/runtime failures: "Syntax error", "X is not defined", "Reduce of empty array".) The correct path: **reduce the data to the grain the answer needs IN SQL** (so the result is complete AND small), then — only if a step SQL genuinely cannot express is required (e.g. an in-memory join across two `ctx.query` results) — run that JS over the ALREADY-AGGREGATED rows, never over raw ones, adding each stated number as its own column via `ctx.emit(name, rows)`.
- **Every number your analysis will state MUST exist as a column in the returned `data`.** The on-screen components (charts, KPI cards) render the raw columns of this dataset — they cannot recompute a value that lives only in your prose. So if the answer talks about a derived value (e.g. `remaining + consumed → totalShelfLifeDays`, a ratio, a per-row delta), compute it in JS and add it as its own column on EVERY row. Never leave a headline number to be re-derived downstream — emit it as data so the analysis and the components show the same figure.
- **Counts and totals MUST come from an AGGREGATE over the full filtered set — NEVER from the number of returned rows.** For any "how many" / count / total / distinct-count / grand-total the answer states, compute it in SQL as its own value — `COUNT(*)`, `COUNT(DISTINCT <key>)`, `SUM(...)` — over the ENTIRE filtered set, and expose it (e.g. `COUNT(DISTINCT <id>) OVER () AS TotalItems`, or a separate `ctx.emit('summary', [{ ...totals }])`). The detail rows are render-capped at {{MAX_ROWS_RENDERED}}, so counting them — or reading `dataSummary.totalRows` — UNDERSTATES the true total whenever the result exceeds the cap. Decide by question type: a pure count / "how many" question needs ONLY the aggregate (return the number, do NOT return a capped list and count it); a "list …" question returns the detail rows (up to the render cap) AND carries the true total(s) as aggregate column(s) so the stated figure is correct even when more rows exist than are shown.
- **This applies to EVERY derived breakdown, not just the headline total — including ones computed from a `GROUP BY ... ORDER BY ... LIMIT N` result.** A grouped/ranked result capped at N rows (e.g. "top 250 products by frequency") is already a truncated sample of the full group population whenever the group count exceeds N — counting or re-grouping THAT capped table (e.g. "how many of these groups fall in category X") answers "within the top N" only, not "across all groups". Any statistic that needs to reflect the FULL population (a category split, a percentage, "how many types fall into X") MUST come from its own dedicated query with NO row cap on the grouping/counting step (e.g. `SELECT category, COUNT(DISTINCT product) FROM t WHERE ... GROUP BY category` — no `LIMIT` on this one) — never be derived by inspecting an already-capped detail/breakdown table.
- **When a capped/ranked result feeds a "total" or KPI-style figure, bind that component to the uncapped aggregate — not to the capped dataset.** Run the full-population aggregate as its own query, emit it as its own dataset (`ctx.emit('summary', [{ total: ..., groupCount: ... }])`), and in `write_components` set the KPI/total component's `sourceRef` to that dataset, never to the capped detail/breakdown dataset. A KPI bound to a `LIMIT`-capped dataset reports the total of only the visible rows — the same undercount whether that summing happens client-side in the component or was done by summing the capped rows earlier in the script.
- **Match the returned data's GRAIN to the views the question needs — components can only render rows you return/emit; the component step never invents or reshapes data.** If the question asks to see something OVER TIME (trend, day-wise, "last N days", "compare … by day/date"), the script MUST expose a row-per-time-point dataset — one row per `Date × series`, with a TEXT `series` label (e.g. `District || ' — ' || side`) and the measure column(s); include BOTH measures if the user named both (e.g. WSP AND RSP). Provide it via `ctx.emit('day_wise', rows)` (or as the returned `data`), IN ADDITION to any per-group decision/summary rows. Do NOT collapse the time dimension the user asked to see into one average per group — if you do, no trend chart can render. (You produce the DATA at the right grain; the component step picks the chart from it — you don't build charts yourself.)
- **Use field names EXACTLY as the tool returned them.** When destructuring a tool result (e.g. from `ctx.runTool` or post-processing `ctx.query` rows), the property names you access MUST match the keys in the actual tool output character-for-character. Do NOT abbreviate, rename, pluralize/singularize, or "natural-language-ify" them. For example: if the tool returned `remainingShelfLifeDays`, do NOT write `result.remainingShelfLife` — that yields `undefined` and your aggregated rows will be null. When in doubt, treat the tool's outputSchema as the source of truth, and prefer the exact key list it declares over your intuition about what the field "should" be called.
- **Coerce numeric values before doing arithmetic on them in JS — a tool result can return a number as TEXT.** Worst on SuiteQL (stringifies every column, even booleans), but the same trap hits any source: `NUMERIC`/`DECIMAL` columns (money/amount fields, almost always this type) come back as strings from Postgres and MySQL too. `total += row.revenue` on a string does STRING CONCATENATION, not addition (`0 + "230"` → `"0230"`, then `"0230" + "172.5"` → `"0230172.5"` …) — no error, just a garbage value that silently breaks any KPI/chart reading it. Wrap every value used in `+=`, comparisons, or math with `parseFloat(...)`/`Number(...)` at the first point you touch it, not just where it's displayed — and if the same aggregation is computed in more than one place in the script, fix it everywhere, not just the one that's rendered first.
- Return `{ data, count }`. `data.length > 0` is the success gate.
- **EVERY dataset MUST be HOMOGENEOUS — one row shape per dataset.** Every row in the returned `data` (and in each `ctx.emit(name, rows)` dataset) MUST have the SAME set of keys. Components derive their columns/axes from the rows, so a dataset that mixes two shapes renders the odd rows as **N/A**. The most common mistake: prepending a summary/total/verdict object (keys like `Verdict`, `Total_Decidable`) to per-detail rows (keys like `District`, `Gap`) — e.g. `return { data: [verdict, ...rows] }`. This makes the table pick the verdict's columns and show N/A for every detail row, and a bar chart over it shows one real bar plus N empty "N/A" bars. **NEVER do this.**
- **Where the roll-up/verdict goes instead:** (a) state it in your final analysis text (the markdown narrates the headline/verdict — it does not need to be a data row), AND/OR (b) emit it as its OWN separate homogeneous dataset via `ctx.emit('summary', [summaryObj])`, keeping the detail rows as their own dataset. One concept = one dataset; never two shapes in one array.

## `execute_script` — verify the draft

**execute_script** runs your draft in a subprocess. Returns `{ ok, totalRows, dataSummary, sampleRows, executedQueries, error?, errorPhase? }`.

**Judge the result**:
- `ok: true` AND the result answers the user's question → **data gathering is DONE. Write your final analysis now — do NOT dispatch any further source queries to double-check, broaden, or explore alternatives.** A successful script that answers the question is a terminal state; going back to query more after it only burns your remaining call budget and risks never reaching the final answer. **Use `dataSummary` (computed over all `totalRows` rows) as the source of truth for every number, range, count, min/max, total, and "all/none" statement.** `sampleRows` is only the first few rows (head of result, NOT representative) — use it to show what a record looks like, never to infer ranges or distributions.
- `ok: true` BUT the result doesn't match intent (wrong columns, wrong aggregation — judge from `dataSummary`/`sampleRows`) → rewrite the script via `write_script` and execute again.
- `ok: false` with `errorPhase: "compile"` → the body didn't parse or isn't exported. Rewrite the whole draft.
- `ok: false` with `errorPhase: "runtime"` → a specific step threw. Patch that step and re-execute.

**When retrying after a rejected/failed attempt — SQL query, script, components, or analysis — change only what the error/rejection actually names.** Anything that already passed (a filter, a dedup step, a GROUP BY, a working data-fetch) must survive unchanged into the retry — do not simplify, remove, or restructure it while fixing something unrelated. A `write_components` rejection about a missing/wrong `sourceRef` is a components problem, not a signal to rewrite `getData()`; a `ROW_NUMBER()`/dedup step that already worked stays exactly as it was even when the retry is fixing a completely different error in the same query.

**Hard cap: 3 execute_script attempts per turn.** If all three fail, stop trying and answer the user from the source data you already have.

## Parameterization guidance — declare generously

**Default to declaring parameters, not hardcoding.** Future questions will phrase the same intent with different knobs ("top 5 instead of top 10", "for the last quarter instead of last year", "in INR only", "over ₹10,000"). Each hardcoded literal you embed forces a near-duplicate script to be generated next time — under-parameterizing is the most common cause of script-store bloat.

For every script body, scan the SQL and the JS post-processing and convert these to parameters with the literal as `default`:

- `TOP N` / `LIMIT N` / `OFFSET N` → `params.limit` (number, default = the N you used)
- Hardcoded dates / date ranges in `WHERE` → `params.dateFrom`, `params.dateTo` (date or date_range; dates arrive as `Date`, call `.toISOString()`)
- Hardcoded year/quarter/month → `params.year` / `params.period` (number or enum)
- `WHERE x IN ('A', 'B', 'C')` with a small list → `params.values` (string array, default = the original list)
- `WHERE x = 'CONST'` for an enum-like column with ≤ ~20 distinct values → `params.<columnName>` (enum, `enumValues` = full enum, default = the literal you used)
- Hardcoded thresholds (`> 1000`, `>= 0.5`) → `params.<thresholdName>` (number, default = the literal)
- Hardcoded text filters (`LIKE '%foo%'`) → `params.searchText` (string)

**Do NOT parameterize:**
- Schema identifiers (table names, column names, source tool ids) — those are baked into the script
- The aggregation function itself (`SUM` vs `AVG`) — that's a different question, deserves a different script
- Logic structure (which subqueries to run, which transforms to apply) — that's the script's identity

**Default values matter.** Set every parameter's `default` to the literal that originally appeared in the SQL. That way the matcher can reuse the script for the original question (no params extracted → defaults apply) and for variations (matcher extracts the user's new values → script uses those instead).

**Write the `name`/`description` to describe the SHAPE of the script, never the specific value of a parameter it declares** — describe what it computes in general terms, never the particular date, region, threshold, or other value this run happened to use, even though that value is genuinely accurate for this run. A future matching call sees this description sitting right next to the declared parameters it's describing, and a specific value baked into the prose reads as a fixed fact about the script — it has caused a real, confirmed failure: a script correctly declaring a parameter was passed over for a different value because its own description named the original value, and that description was mistaken for the script's identity rather than something its own parameters already cover. If a value is parameterized, nothing about it belongs in the name or description — only in the parameter's own `default` and `description` fields.

**Every parameter you declare MUST actually be read in the script body** — as `params.<name>`,
`params['<name>']`/`params["<name>"]`, or destructured (`const { <name> } = params`). Declaring
a parameter and then leaving the literal it was supposed to replace hardcoded in the SQL is the
single most damaging authoring mistake possible: a future replay passes a DIFFERENT value, the
script still runs and reports success, and it silently keeps answering for the ORIGINAL
hardcoded scope while looking exactly like it answered the new question — the person asking
has no way to tell the answer is wrong. `write_script` REJECTS the call outright when a declared
parameter isn't referenced anywhere in the body, naming exactly which one(s) — but catching it
after the fact costs a retry; get it right the first time.

**Quick test — do both before finalizing your `write_script` call:**
1. "If the user re-asked this with the number/date/filter changed, would my parameter list
   cover it?" If not, add the missing parameter.
2. For every name in `parameters`, find `params.<name>` (or an equivalent access) somewhere in
   `scriptBody`. If you can't find it, either wire it into the query/logic it's supposed to
   control, or remove it from `parameters` — never leave a declared parameter unread.

## The four valid script shapes

Every script MUST start with this `import type` line so `ctx` and `params` are typed when the file is opened in an IDE. The `import type` form is erased at runtime, so it does not affect the tsx subprocess execution.

```ts
import type { ScriptContext, ScriptParams } from './_types';
```

**Shape A — passthrough (when SQL did all the work):**
```ts
import type { ScriptContext, ScriptParams } from './_types';

export async function getData(ctx: ScriptContext, _params: ScriptParams) {
  const q = await ctx.query('mssql-XXX_query', `<the SQL that already succeeded>`);
  return { data: q.data, count: q.count };
}
```

**Shape B — post-SQL transforms (weighted averages, in-memory joins, ratios, per-capita normalization, clustering, computed percentages from multiple queries' totals):**
```ts
import type { ScriptContext, ScriptParams } from './_types';

export async function getData(ctx: ScriptContext, params: ScriptParams) {
  const q = await ctx.query('mssql-XXX_query', `<SQL>`);
  // ... JS transforms over q.data ...
  return { data: transformed, count: transformed.length };
}
```

**Shape C — direct-tool wrapper (when a pre-built business-logic tool produced the answer):**
```ts
import type { ScriptContext, ScriptParams } from './_types';

export async function getData(ctx: ScriptContext, params: ScriptParams) {
  // Use ctx.runTool for direct tools, not ctx.query.
  const result = await ctx.runTool('calculate-shelf-life', {
    consignmentId: params.consignmentId,
  });
  // If the tool returns nested datasets you want charted, emit them.
  if (result.checkpoints) {
    ctx.emit('checkpoints', result.checkpoints, { description: 'Per-segment readings' });
  }
  // Return a single-row table for KPI/summary rendering.
  return { data: [result.summary || result], count: 1 };
}
```

**Shape D — mixed (source SQL feeds a direct tool):**
```ts
import type { ScriptContext, ScriptParams } from './_types';

export async function getData(ctx: ScriptContext, params: ScriptParams) {
  // Use SQL to discover the identifier the direct tool needs.
  const ids = await ctx.query('postgres-XXX_query', `SELECT device_uid FROM ... WHERE ...`);
  const result = await ctx.runTool('calculate-shelf-life', {
    deviceId: ids.data[0].device_uid,
  });
  return { data: [result.summary || result], count: 1 };
}
```

**Rules**:
- Always include the `import type` line above.
- Always type `ctx: ScriptContext` and `params: ScriptParams` (use `_params` if the script ignores params, to silence "unused" warnings).
- Always prefix the function with `export` — the bootstrap dynamic-imports `getData`.

Pick **A** for pure SQL passthroughs. Pick **B** when post-SQL JS is genuinely required. Pick **C** when a direct tool's output is the answer. Pick **D** when you need SQL to find the input for a direct tool.

## write_analysis — the answer is a program

After `execute_script` succeeds, write the answer as `getAnalysis(data, params, fmt, datasets, entities, scope)`. It
runs over the **FULL** result — not the sample you were shown — and what it returns is displayed to
the user.

`data` is exactly what `getData` returned. Anything you registered with `ctx.emit(name, rows)` is NOT
in `data` — it arrives as `datasets[name]`. **If you emitted a total for a component, read it back
from `datasets` rather than recomputing it**: one computation rendered twice cannot drift, whereas
two computations of "the same" figure eventually disagree and the answer contradicts its own KPI card.

**If `data` (or a dataset you're narrating) is a capped/ranked slice of a larger population — more
groups or rows exist than are shown — the FIRST sentence (THE ANSWER) MUST say so, with both counts
(e.g. "top 250 of 1,047 shown").** A findings bullet or the Method & filters line is not enough on its
own — a reader who stops at the headline must not come away thinking it's the complete set. Get the
true population count from `ctx.query()`'s own `totalCount` (see above — capture it in `getData` and
`ctx.emit` it into your `summary` dataset) or from its own uncapped aggregate query if `truncated`
wasn't set for your source. Read it back from `datasets.summary` here — **never infer it from
`data.length`**, which is only the capped slice you were given, and never type the number in as a
literal you happened to see once — it must be recomputed fresh on every replay.

```js
export function getAnalysis(data, params, fmt, datasets, entities, scope) {
  const s      = datasets.<emitName>?.[0];               // the row the KPI cards bind to
  const r      = data[0];
  const total  = fmt.money(r.<amountField>);            // compute each figure ONCE
  const n      = fmt.num(r.<countField>);
  const period = fmt.range(params.<from>, params.<to>);
  const top    = [...data].sort((a, b) => b.<amountField> - a.<amountField>)[0];
  const hits   = data.filter(x => <condition>).length;  // COUNT a subset — never type it:
                                                        // you were shown a sample, the code sees all
  // Compute the Method & filters line ONCE. It goes into `analysis` and the
  // LAST item of `summary` VERBATIM, character for character — not
  // paraphrased or shortened. Findings bullets may condense; this line never
  // does, since a viewer who only sees the markdown block still needs the
  // exact filters that were applied, not an abridged approximation of them.
  const methodLine = `**Method & filters:** <table(s)>, <filters applied>, ${period}.`;

  return {
    analysis: [
      // 1. THE ANSWER — the number asked for, in the first sentence. Never bury it.
      `**${n} records** totalling ${total} over ${period}.`,
      ``,
      // 2. FINDINGS — 2-4 bullets. Each states something you COMPUTED ACROSS THE
      //    ROWS, not a restatement of the answer. Drop a bullet rather than pad.
      //    Typical shapes: leader/laggard, share of total, trend, concentration,
      //    an outlier, a gap, or a data caveat you can prove.
      //    A claim about "how many rows are X" MUST come from a filter like `hits`
      //    above — the sample you were shown cannot tell you, so a typed count is
      //    a guess that then freezes into the recipe.
      `- ${fmt.num(hits)} of ${fmt.num(data.length)} <are the X case>`,
      `- ${top.<nameField>} leads at ${fmt.money(top.<amountField>)}, `
        + `${fmt.pct(top.<amountField>, r.<amountField>)} of the total`,
      `- <second computed finding>`,
      `- <a caveat the data itself shows — e.g. two spellings of one entity, `
        + `merged here; a period with no rows; a truncated result>`,
      ``,
      // 3. METHOD & FILTERS — what was counted, which filters, which period. One line.
      methodLine,
    ].join('\n'),

    // 2-3 findings bullets for the markdown block — the SAME consts, shorter.
    // Not a summary of `analysis`; a shorter rendering of the same data. The
    // LAST array item is always `methodLine` — the SAME CONST, unchanged,
    // never re-typed or abridged — so it cannot drift from the one in
    // `analysis`. The markdown block renders on its own in the UI, so a
    // viewer who only sees it still needs the exact filters that applied,
    // not just the headline number.
    summary: [`${n} records totalling ${total}`, `<the strongest finding>`, methodLine],

    method: `<one line: tables, filters, period>`,
  };
}
```

Fill every slot — an `analysis` that is one line is a worse answer, not a tidier one. Being a
program changes how numbers are RENDERED, not how much you explain.

`fmt` — the ONLY way a number becomes text:
`fmt.money` money (symbol, grouping and scale unit all from the project locale) · `fmt.num` counts · `fmt.count` very large counts ·
`fmt.pct(part, whole)` · `fmt.delta(now, before)` · `fmt.date` · `fmt.range` · `fmt.list`

**No hardcoded values ANYWHERE the recipe produces text — one rule, not four separate ones.**
`analysis`, `summary`, `method`, and every text field of every component `getComponents` returns
(`title`, `description`, and any other string inside `config`) are all rebuilt from scratch on every
replay of the SAME script, with different `params` and different underlying data each time. A number,
date, or name typed in as a literal anywhere in that output freezes to the one run it happened to be
authored against — it does not travel with the script, and it is wrong on every subsequent replay
regardless of which field it sits in. Read the four bullets below as this ONE rule, applied everywhere
text is produced — not four rules that only apply where each one happens to be written down. A script
is reused; nothing it ever outputs as fixed text may be a one-time observation.

**Enforced — the call is REJECTED, not merely discouraged:**
- **Never type a number into a string, anywhere — including a component's `title`/`description`/`config`.**
  Amounts, counts, ids, rates, thresholds alike — all come from `fmt`, reading the value from
  `data`/`datasets` at render time. This is checked mechanically: `write_script` inspects the full script
  body (including `getComponents`) and `write_analysis` inspects the analysis text, and either call is
  REJECTED with the exact literal named if one is found — including a bare number bound to a `const`
  first and used later, not just one typed directly into a call.
- **Never write out a date or date range as text, anywhere — including a component's `title`/`description`.**
  `"4–10 May 2026"` is exactly as much a hardcoded value as a hardcoded number — it freezes the ONE range
  this run happened to use into every future replay, silently mislabeling the answer once the same script
  runs again with different `params.dateFrom`/`params.dateTo`. Use `fmt.range(params.dateFrom, params.dateTo)`
  (or `fmt.date` for a single date) everywhere a period appears.
- **Never hardcode a project, customer, employee, or other named value the query resolved at runtime**
  (`"Paspaley D365 Commerce"`, `"Project 314023"`) into `analysis`/`summary`/`method`/component text. A
  name typed as a literal is exactly as wrong on replay as a number typed as a literal, for the same
  reason: the query might return the same shape for a different run, but the literal never changes.

  **Use the `entities` argument.** Both tail programs receive it:

      export function getAnalysis(data, params, fmt, datasets, entities, scope)
      export function getComponents(data, params, fmt, datasets, entities, scope)

  `entities` is every name resolved this turn, as `{ mention, entityType, instanceId, displayName }`,
  re-resolved on every run — so it tracks whoever the question is about next time:

      const subject = entities.find(e => e.entityType === 'subsidiary')?.displayName;

  **Do NOT add a column to `getData` just to carry a name.** `entities` already has it, and changing
  `getData` costs an `execute_script` attempt you may need for the query itself. Reading the name from
  `data`/`datasets` is also fine when the query already returns it — but never widen the SELECT for a
  name alone. Filtering still uses the resolved id (`params.<name>Id`), never the name string.
- **Never hand-roll a formatter, anywhere.** No dividing by scale constants, no `toLocaleString` — not in
  `analysis`, not inside a component's `title`/`description` interpolation either.
- `summary` is a SHORTER RENDERING OF THE SAME DATA, never a summary of `analysis`. Reference the
  same consts in both so the long and short forms cannot drift. **Exception: the Method & filters
  line is never shortened.** Build it once as its own const and use that exact const, unedited, as
  the last item of `summary` — a paraphrase risks silently dropping a filter the reader relies on.

**Guard superlatives that can collide.** The top row by one measure is often the top row by another.
A sentence contrasting them then compares a thing to itself. Check they differ before comparing, and
drop the bullet when they don't.

Everything else is yours: filter, sort, loop, branch on what the data actually contains, and say what
you noticed. A program sees every row, so a pattern spanning the whole result can be computed and
stated — prose written from a 3-row sample cannot.

Why: a number typed into a string freezes into the recipe and replays unchanged while the data moves
underneath it. Computed figures regenerate correctly every time.

If `write_analysis` fails twice, write the analysis as prose instead — never leave the user with no
answer.

## write_components — the dashboard is a program too

`getComponents(data, params, fmt, datasets, entities, scope)` returns the ARRAY of component specs. Like
`getAnalysis`, it re-runs on every replay, so text built from `datasets`/`fmt` tracks the data
instead of freezing at authoring time.

```js
export function getComponents(data, params, fmt, datasets, entities, scope) {
  const s = datasets.<emitName>?.[0];                    // the row the KPI card binds to
  return [
    { componentType: '<exact name from the catalog>', sourceRef: 'computed:<emitName>',
      title: `<what it shows>`,
      description: `across ${fmt.num(s.<countField>)} <things>`,
      config: { valueKey: '<column>', prefix: '<unit>' } },

    { componentType: '<ChartName>', sourceRef: 'computed:<groupedName>',
      title: `<what it shows> — ${fmt.range(params.<from>, params.<to>)}`,
      description: `<one line of context>`,
      config: { xAxisKey: '<category column>', yAxisKey: '<measure column>',
                xAxisLabel: '<label>', yAxisLabel: '<label>' } },
  ];
}
```

- **Bind, never transform.** `sourceRef` names one `executedQueries[].sourceId`. `getComponents`
  selects columns; it does not group, sum, or reshape. If the grain is wrong, fix the `ctx.emit`
  in `getData` — a chart bound to un-aggregated rows draws one mark per ROW and is REJECTED.
- **One dataset per grain, not per component.** A chart and a table over the same grouped rows
  share one `sourceRef`. Emitting the same thing twice is two derivations that will disagree.
- **No hardcoded values in `title`, `description`, or any other component text — same rule as `write_analysis`,
  not a lighter version of it.** See "No hardcoded values ANYWHERE the recipe produces text" above: numbers,
  dates, and names are all computed from `datasets`/`data`/`fmt` at render time so they cannot go stale and
  so a component's text can never contradict the KPI or chart beside it. Numeric hardcodes here are rejected
  the same way a `write_script` call is rejected for one in `getData`.
- **No markdown component.** Your analysis becomes that block automatically.

Rejections list the exact problem per component — fix the body and call `write_components` again.
