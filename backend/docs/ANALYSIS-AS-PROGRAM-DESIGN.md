# Analysis as a Program

**Status:** proposed
**Date:** 2026-08-18
**Scope:** `sdk-nodejs/src/userResponse/` (MainAgent, script runner, component generator) + `backend/.prompts/agent-main/system.md`

Replace the LLM-written analysis narrative with a generated program that computes its own
numbers, so the prose can never disagree with the data or with the components beside it.

---

## 1. The problem

A single answer to *"give me total bookings"* reported the same figure two ways:

| surface | shown | produced by |
|---|---|---|
| KPI card | ₹629.35 Crore | code |
| summary table | ₹629.35 C | code |
| analysis prose | **₹62.94 Cr** | LLM |
| markdown block | **₹62.94 Cr** | LLM (summary of the prose) |

The raw value was `6,293,543,723.93`. One crore is 10^7, so 629.35 Cr is correct; the model
divided by 10^8.

The same answer also disagreed with itself on digit grouping:

```
prose:     "119,991 GCNs"     Western grouping (3-3-3)
KPI card:  "1,19,991"         Indian grouping (2-2-3)
```

Both divergences are between a **code path** and a **language path**, in one response, over one
dataset. Nothing was lost in transit — `formatResultAsString` is `JSON.stringify`, so the model
received `6293543723.93` verbatim.

## 2. Why more prompting will not fix it

`backend/.prompts/agent-main/system.md` already carries a four-step procedure for Indian currency
formatting, including a magnitude self-check written for exactly this failure:

> *"a 10-digit value is always 100.00–999.99 Cr"*

`6293543723` is ten digits. The rule, the worked example, and the verification step were all
present and all ignored. A fifth instruction is not the lever.

## 3. Root cause of the propagation

The markdown block has **no data source**. In `script-component-generator.ts`:

```ts
if (spec.sourceRef === 'markdown') {
  const summary = await summarizeToMarkdown(analysisText, ...) || spec.content || analysisText;
```

It is an LLM summarising the LLM's prose — two generations of language, zero contact with the
numbers. There is no point at which `62.94` could be checked against `6293543723.93`.

The same chain breaks replay. On a deterministic replay there is no new analysis, so the fallback
serves `spec.content` — **authoring-time text**. The components re-run against fresh data while
the narrative stays frozen, so after a parameter change the two actively contradict each other.

## 4. Design

### 4.1 Author the analysis after execution

The model writes the analysis program **after** it has seen the result, not before. This is the
decision that makes the design viable: a template authored in advance cannot react to what the
data turned out to contain.

```
SourceAgent query   →  model sees sample rows
write_script        →  getData(ctx, params)
execute_script      →  data + dataSummary + sampleRows
write_analysis      →  getAnalysis(...)          ← NEW; model has seen the data
runtime             →  runs getAnalysis over the FULL cached dataset
```

Emergent observations survive, and improve. From a real run:

> *"Brahmaputra Cracker appears as two variants — combined ₹32.24 lakh — likely a data-quality
> issue."*

As prose that was inferred from three sample rows. As a program it is computed over all rows:

```js
const dupes = data.filter(r => r.name.startsWith('BRAHMAPUTRA'));
const combined = dupes.reduce((s, r) => s + r.loss, 0);
```

### 4.2 `getAnalysis` is pure

Signature: `(data, params, fmt) → AnalysisOutput`. No `ctx.query` access.

It inherits none of the database failure modes, runs in microseconds, and is unit-testable. If a
number is needed, `getData` should already have returned it.

### 4.3 Structured return: the markdown is a sibling, not a derivative

The analysis is long; the markdown block is short. That does **not** make the markdown a summary
*of the analysis text*. Summarising prose in code is truncation, and it breaks whenever the prose
is reworded.

Instead one function emits several renderings of the same data, at different lengths:

```js
export function getAnalysis(data, params, fmt) {
  const r = data[0];

  // computed ONCE — every rendering references the same strings
  const total  = fmt.inr(r.TotalFreightAmount);
  const count  = fmt.num(r.TotalBookingCount);
  const avg    = fmt.inr(r.AvgFreightPerBooking);
  const period = fmt.range(params.from, params.to);

  return {
    analysis: `**Total Bookings:** ${count} GCNs (${period}) …full narrative…`,
    summary: [
      `${count} bookings generated ${total} in freight revenue over ${period}`,
      `Averaging ${avg} per booking across ${fmt.num(r.UniqueCustomers)} customers`,
    ],
    method: `Count of distinct BookingIds … ${period}`,
  };
}
```

The answer component binds to `analysis`, the markdown block to `summary`, both to `method`.
`sourceRef: 'markdown'` becomes data-bound like every other component and `summarizeToMarkdown` is
deleted — one fewer LLM call per answer, and the long and short forms cannot disagree because
there is only one value behind each figure.

**Hoist the formatted strings**, as above. If each rendering called `fmt.inr(...)` independently
they would still agree, but hoisting makes it structurally impossible for one function to format
the same figure two ways — which is exactly the failure observed across the prose and the KPI card.

A longer analysis contains more numbers, so it carries more drift surface. Program-generation
matters more as the narrative grows, not less.

### 4.4 The `fmt` library

`sdk-nodejs/src/userResponse/scripts/fmt.ts`, injected into the script sandbox.

**There is no existing shared formatter to reuse.** `frontend/src/utils/formatNumber.ts` does
en-IN grouping only, with no Cr/L scaling. The KPI card is correct for a different reason: it
carries `autoScaleIndianCurrency`, a defensive heuristic that ignores the intended scale and
recomputes it from the value's own magnitude —

```ts
const RAW_VALUE_THRESHOLD = 100000;
const looksRaw = abs >= RAW_VALUE_THRESHOLD;
```

— because, as its own comment records, the model's choice of pre-divided field and matching
suffix "can come apart". That is a last-mile patch with a real hole: a genuinely pre-scaled value
of 100,000+ in its unit gets divided a second time. `fmt` is the canonical implementation upstream;
the heuristic stays as a safety net for recipes authored before it.

| helper | output | replaces |
|---|---|---|
| `fmt.inr(n)` | `₹629.35 Cr` | the four-step prompt procedure |
| `fmt.num(n)` | `1,19,991` | ad-hoc grouping (`toLocaleString('en-IN')`) |
| `fmt.pct(a, b)` | `61.2%` | mental division |
| `fmt.delta(a, b)` | `+12.4%` | signed comparisons |
| `fmt.date(d)` | `30 Jul 2026` | `toDateString()` misuse |
| `fmt.range(a, b)` | `1 Feb – 31 Jul 2026` | hand-written period strings |
| `fmt.list(items)` | `A, B and C` | manual joins |

`fmt.date` is worth having beyond the analysis: a real script failure this week emitted
`WHERE ds.DocumentDate >= 'Thu Jan 01'` — `toDateString().slice(0,10)` where `toISOString()` was
meant. A helper removes that class from all generated code.

It is deliberately **strict** about input. `new Date('Thu Jan 01')` parses happily to
31 Dec 2000, so a lenient helper would have rendered that exact broken string as a plausible wrong
date instead of flagging it. Only `Date` objects, epoch numbers, and ISO-shaped strings are
accepted; anything else returns `—`.

### 4.5 The lint is where the guarantee comes from

A program does not by itself prevent a wrong number:

```js
return { headline: `Freight revenue of ₹62.94 Cr` };   // hardcoded literal
```

This is worse than today: the wrong figure is now a string constant that survives replay unchanged
while the data moves underneath it.

**Reject an analysis body whose string literals contain `₹`, `Cr`, `L`, or digit groups.** Every
number must arrive through `fmt.*(field)`. Without this check the design is a convention; with it,
an invariant.

## 5. What this buys

1. **Numbers cannot drift.** Formatting is a tested function, not a re-derived procedure.
2. **Replay is correct by construction.** Both exports persist in the recipe file (`fileBase`,
   `bodyHash`); a replay regenerates the narrative from fresh data.
3. **The narrative sees all rows.** Today the model writes from `dataSummary` plus at most three
   sample rows. The program computes over the full result.
4. **One fewer LLM call.** `summarizeToMarkdown` disappears.
5. **Reviewable.** The analysis body is inspectable and testable; a prompt is neither.

## 6. Costs and risks

| risk | mitigation |
|---|---|
| Hardcoded numeric literals in the template | the § 4.5 lint |
| Program throws → no narrative at all | fall back to today's LLM prose, so a bad template degrades rather than blanks |
| Wrong field selected (`fmt.inr(r.Avg…)` for `r.Total…`) | not solved; but now visible in reviewable code rather than buried in prose |
| One extra round trip (~2–4s) | partly repaid by deleting `summarizeToMarkdown` |
| Streaming lost — text arrives at once | product call; wall-clock is roughly neutral |
| +1 against the iteration budget | the prompt already warns that hitting the cap returns no answer at all |

## 7. Prerequisite: script robustness

This design puts the narrative on the script path. In three observed runs that path failed twice,
and both times the error message misdiagnosed the fault so the retries could not converge:

| failure | real cause | message said |
|---|---|---|
| `WHERE bi.InvoiceNo = 'undefined'` | 2 params declared, `execute_script` called with `{}` | *"use search_schema to look up column names"* |
| `WHERE ds.DocumentDate >= 'Thu Jan 01'` | `toDateString()` where `toISOString()` was meant | *"check calendar dates, use EOMONTH"* |

Both retries regenerated byte-identical SQL. **Fix this first** — otherwise the design trades a
wrong number for a missing answer.

Required:
- reject `execute_script` when a declared required parameter is missing, before any SQL runs
- teach the SQL error classifier to recognise `'undefined'` and JS-formatted dates, and name the
  real fault

## 8. Sequencing

1. **Script robustness** (§ 7) — worth doing regardless; currently costing whole answers.
2. **`fmt` library + lint** — self-contained, testable, no behavioural change until used.
3. **`write_analysis` tool + `getAnalysis` execution**, with prose fallback.
4. **Bind the markdown block to `summary`.** `summarizeToMarkdown` is NOT deleted: every recipe
   authored before `getAnalysis` existed still needs it, and removing it would strip their
   narrative entirely. It becomes the fallback — taken only when no `summary` is present — so the
   extra LLM call disappears for new recipes and survives for old ones.

## 9. Out of scope

- **KPI prefix/suffix detachment** — a component config issue (`prefix: "₹"` on the spec), not part
  of this path. Tracked separately so it is not assumed fixed by this work.
- **Wrong-column selection** by the model (e.g. grouping by `Consignor Name` where the question
  meant `Billing Party`). A semantic-model concern.
