# Script Flow — Fork-and-Adapt Design

Companion to `SCRIPT-FLOW-IMPLEMENTATION.md`. Covers the **fork-and-adapt** mechanism that handles "near match" questions — variations that an existing script almost answers but where the body needs modification.

---

## Problem

The current matcher is binary: a question either matches an existing script (replay with params) or it doesn't (full agent flow + fresh script). Two failure modes:

1. **Parametric variations** ("top 5 instead of top 10", "last quarter instead of last year") — solved by Option 1 (declare parameters generously, see `agent-main/system.md` "Parameterization guidance"). The matcher binds new values to existing params, no new script is saved.
2. **Structural variations** ("same domain, different metric/dimension/table") — NOT solved by parameterization. Today this falls through to a full agent flow that re-discovers schema and re-authors a near-duplicate. Wastes the parent script's proven SQL.

Concrete examples of structural variations against the current store:

| User question | Existing script | What's structurally different |
|---|---|---|
| "For each AIRLINE, what's the AVERAGE airway bill weight?" | `airline-hhi-calculation` | Different metric (`AVG(weight)` instead of `COUNT`); HHI math drops |
| "For each branch, ratio of IMPORT bills to invoices" | `branch-sb-to-invoice-ratio-analysis` | Same shape, different table (`IMP` instead of `SB`) |
| "Volume-weighted EXCHANGE-RATE STDDEV per currency" | `volume-weighted-avg-exchange-rate-by-currency` | Same SQL skeleton, additional aggregation in JS |

For these, regenerating from scratch costs ~25s and ~6 LLM calls. Forking the parent and patching it costs ~12s and ~2 LLM calls.

---

## Design — three-tier matcher + fork-on-near

The matcher classifies each question into one of three tiers:

```
ScriptMatcher.match()
  ├─ tier "high"  → replay existing script with extracted params  (~12s, ~3 LLM calls)
  ├─ tier "near"  → fork parent + LLM adapts body                  (~12s, ~2 LLM calls + 1 subprocess)
  └─ tier "none"  → full agent flow + fresh write_script           (~25s, ~6 LLM calls)
```

**Cost ladder is monotonic**: high < near < none. The matcher always prefers cheaper tiers when the question fits.

### Tier definitions

- **high**: same intent, same structure, only parameter values differ. The script's declared parameters cover any variation.
- **near**: same domain and ~70–90% structural overlap, but the body needs modification (different metric, dimension, table swap, additional column). The runtime forks the parent.
- **none**: no script is structurally close enough.

### Fork mechanics — no new tool, just a head start for `write_script`

The cleanest implementation does **NOT** add a `fork_script` tool. Instead, when the matcher returns `tier: 'near'`:

1. `agent-user-response.ts` stashes a `forkContext = { parentRecipeId, parentBody, gaps, modificationHint }` on the request.
2. The existing `MainAgent.handleQuestion()` runs with two additions to its user message:
   ```
   ## Parent Script to Adapt
   <parentBody>

   ## What needs to change
   <gaps + modificationHint>
   ```
3. MainAgent's existing `write_script` and `execute_script` tools handle authoring + verification — no new tools, no new fix-loop. The same 3-attempt cap applies.
4. On `ScriptStore.save()`, the store reads `forkContext.parentRecipeId` and sets `recipe.parentId` automatically.

**Why this is good**: same primitives the system already trusts. Fork mode is just "regular authoring with a head start" plus parentage tracking on save.

### What fork mode skips (and what it doesn't)

| Step | Fresh authoring | Fork mode |
|---|---|---|
| ConversationSearch | runs | runs |
| KnowledgeBase fetch | runs | runs |
| ScriptMatcher | runs | runs (returned `tier: 'near'`) |
| **MainAgent dispatch SourceAgent** | **runs** (~10s) | **SKIPPED** — parent's `ctx.query` SQL is already proven |
| Schema embedding pre-resolve | runs | not needed |
| `write_script` (new body) | runs | runs (LLM modifies parent body) |
| `execute_script` (verify) | runs | runs |
| 3-attempt fix-loop | runs | runs |
| Analysis LLM call | runs | runs |
| Component generation (lightweight) | runs | runs |
| `ScriptStore.save()` with `parentId` | n/a (parentId=undefined) | parentId set from forkContext |

The big win is skipping SourceAgent and schema discovery. Everything else (analysis, components, save) is unchanged.

### Fallback when fork attempts exhaust

If `execute_script` fails 3 times in fork mode (e.g., the parent's SQL doesn't accept the modification, or the LLM can't construct a working body from the head start), the runtime **falls back to fresh authoring within the same turn** — dispatch SourceAgents, re-author from scratch. The user always gets an answer.

---

## Recipe lineage fields

Add to `ScriptRecipe`:

```ts
interface ScriptRecipe {
  // ... existing fields ...

  /** recipe.id of the parent fork; undefined for root scripts */
  parentId?: string;

  /** 0 for root scripts; parent.forkDepth + 1 for forks */
  forkDepth: number;

  /** Brief description of what this fork changed vs its parent (from matcher's modificationHint) */
  forkReason?: string;
}
```

Backwards compatible — existing recipes default to `forkDepth: 0`, `parentId: undefined`.

### Lineage uses

- **Bug propagation**: when `parent.failureCount/successCount > 0.2`, flag descendants for review.
- **Pruning**: prefer pruning leaves before parents; never prune a parent with live descendants.
- **Match boost** (future): future near-matches against root or any descendant pick the closest one in the family.
- **Admin UI** (future): tree view of lineage, prune subtree, see family-wide failure rates.

---

## Guardrails

| Guardrail | Why | Where it lives |
|---|---|---|
| **Fork depth cap (≤ 3)** | Prevent drift through long chains of forks-of-forks | Check at `ScriptStore.save()`; if `parent.forkDepth >= 3`, fall back to fresh authoring (no parentId) |
| **Cycle prevention** | Self-referencing parentId | Trivial check at save: walk parent chain, fail if id reappears |
| **3-attempt cap on fork** | Same as fresh authoring | Already in MainAgent (`MAX_SCRIPT_ATTEMPTS = 3`) |
| **Fallback to fresh authoring** | Avoid total failure when fork can't adapt | When all 3 fork attempts fail, drop forkContext and re-enter MainAgent's normal path |
| **Bug inheritance flag** | Buggy parent → buggy children | When parent's failure rate exceeds threshold, mark descendants `needsReview: true` (don't auto-disable) |
| **Orphaned children policy** | Parent deleted, children continue working | Children's `parentId` becomes a dangling reference; their `.ts` files are independent and continue to run |
| **Concurrent forks** | Two requests forking same parent | No shared mutable state — each fork is a separate `.ts` file |

---

## High-match failure recovery — repair-on-fail (reuses fork machinery)

**Status: PENDING — implement after the component-consistency work (`SCRIPT-COMPONENT-CONSISTENCY.md` Phases 1–3).**

### Current behavior

A `tier: 'high'` match replays the saved script directly in the subprocess — it does **not** go through the MainAgent (that's the cost win: ~2 LLM calls vs ~6). If the replay fails or returns no data (`agent-user-response.ts:591`), the runtime calls `recordFailure()` and **falls through to the MainAgent in fresh / author-from-scratch mode** — no `forkContext` is set.

### The gap

Falling through to *fresh* authoring on a high-match failure is wasteful and risky:

1. **Throws away a correct-structure script.** A high match means this was the *right* script; it merely broke (usually schema drift, a transient tool error, or a bad param). Re-discovering schema and re-authoring from scratch costs ~25s / ~6 LLM calls to rebuild something that was 95% correct.
2. **Duplicate-script risk.** Fresh authoring can save a *second* script for the same intent → matcher ambiguity on the next question and store bloat.
3. **Health-score damage.** `recordFailure()` fires even for transient errors. The matcher filters out scripts whose failure rate exceeds 20% (`successCount`/`failureCount` health gate), so a string of transient hiccups can demote a perfectly good canonical script.

### Design — repair the failed script instead of authoring blank

On high-match failure, do **not** restructure `high` to always run inside the MainAgent (that would tax every successful replay with the MainAgent's prompt overhead, defeating the fast path). Instead, route the *failure* into the MainAgent using the **existing fork-context machinery**, but as a **repair** rather than a fork:

1. Set a `forkContext`-shaped payload with `parentBody` = the **failed script's body** and `gaps`/`modificationHint` = the **execution error** (`ScriptResult.error` + `errorPhase`). The user message gets the same `## Parent Script to Adapt` block — the MainAgent already knows how to read it (Phase 2B).
2. The MainAgent patches the body via its normal `write_script` → `execute_script` loop (same `MAX_SCRIPT_ATTEMPTS = 3`).
3. **Save back to the SAME recipe** — this is the key difference from a normal fork. A fork creates a new child (new intent); a repair fixes the canonical script in place:
   - keep `recipe.id`, bump `recipe.version`,
   - **do not** set `parentId` / increment `forkDepth` (it's not a new lineage node, it's a new version of the same node),
   - clear `lastError` on success.

The MainAgent gets the head start (proven SQL skeleton + the exact error to fix) without the system paying for it on the success path.

### Error-type handling — not every failure is structural

`ScriptResult.errorPhase` already distinguishes `compile` / `runtime` / `timeout` / `ipc`. Treat them differently:

| `errorPhase` | Likely cause | Action |
|---|---|---|
| `timeout`, `ipc` | Transient (tool/DB hiccup, subprocess flake) | **Retry the replay once** before any repair. **Do NOT `recordFailure()`** — don't demote a healthy script for a transient blip. |
| `compile`, `runtime` | Structural (schema drift, invalid column/object, bad param coercion) | Enter MainAgent **repair mode** (above). `recordFailure()` is appropriate here. |

### Guardrails

- **Bounded attempts.** Repair reuses `MAX_SCRIPT_ATTEMPTS = 3`. If repair exhausts, fall back to today's behavior — fresh authoring (and only then may a new root recipe be saved).
- **No version thrash.** Only bump `version` + persist when `execute_script` actually succeeds; a failed repair leaves the original recipe untouched (its `lastError` may be updated for visibility).
- **Repair vs fork is decided by intent identity.** Same question, broken script → repair in place. A genuinely different question that happened to high-match the wrong script is a matcher-calibration issue, not a repair case.

### Why not just move `high` into the MainAgent

Considered and rejected: running every high replay through the MainAgent would pay the MainAgent's large system prompt (source summaries, tool defs, routing) on the **common success case** for zero benefit — the script flow's headline cost win disappears. The recovery we want is needed only on the *rare failure*, so it belongs on the failure edge, not the hot path.

---

## Implementation phases

### Phase 1 — Generous parameterization (DONE)

- File: `backend/.prompts/agent-main/system.md` — "Parameterization guidance — declare generously" section.
- Effect: new scripts authored under this policy declare parameters for limits, dates, IN-lists, enum filters, thresholds.
- Result: many "near" matches collapse into "high" (param-only) variations.

### Phase 2A — Matcher tier extension (DONE)

**Files**:
- `sdk-nodejs/src/userResponse/scripts/types.ts` — added `MatchTier = 'high' | 'near' | 'none'`; extended `ScriptMatch` with `tier`, `gaps`, `modificationHint`, `reasoning`.
- `sdk-nodejs/src/userResponse/scripts/script-matcher.ts` — parses `tier` from LLM response with backwards-compatible fallback. *Originally Phase 2A returned `null` for `tier: 'near'` (logged-only behavior); Phase 2B replaced this with a full `ScriptMatch` return so the fork path can act on it.*
- `backend/.prompts/script-match/system.md` — rewritten to ask for tier classification with decision rules and per-tier output fields.

**Telemetry payoff**: log lines now expose how often "near" actually fires. Roll out Phase 2B once we see the rate is non-trivial (suggested threshold: ≥10% of agent-flow turns).

### Phase 2B — Fork-context plumbing (DONE)

The actual implementation chose a slightly leaner shape than the original plan: rather than threading `forkContext` through MainAgent's signature, the parent block is **prepended to the user prompt** and MainAgent reads it via the static "Fork-and-Adapt Mode" section in its system prompt. This keeps `MainAgent.handleQuestion()` unchanged and centralizes lineage tracking in `agent-user-response.ts`.

**Files changed**:

1. `sdk-nodejs/src/userResponse/scripts/types.ts`
   - Added `parentId?`, `forkDepth?`, `forkReason?` to `ScriptRecipe`.
   - Migration handled in `script-store.ts` (defaults `forkDepth: 0` for legacy recipes).

2. `sdk-nodejs/src/userResponse/scripts/script-store.ts`
   - `loadAllFromDisk` defaults missing `forkDepth` to `0` for both metadata-format and legacy-format recipes.
   - `save()` itself is unchanged — it just persists whatever lineage fields are on the recipe; the caller sets them.

3. `sdk-nodejs/src/userResponse/scripts/script-matcher.ts`
   - For `tier: 'near'`, returns a full `ScriptMatch` (with `gaps`, `modificationHint`, `confidence: 'medium'`) instead of `null`.

4. `sdk-nodejs/src/userResponse/agent-user-response.ts`
   - New `forkContext` local: set when matcher returns `tier: 'near'` AND `parent.forkDepth < FORK_DEPTH_CAP` (3).
   - Builds `effectivePrompt = forkPreamble + originalPrompt` and passes it to `MainAgent.handleQuestion()`. The original `prompt` stays untouched for analysis/components/save metadata.
   - Lineage applied at save: when `forkContext` is set, the saved recipe records `parentId`, `forkDepth = parent.forkDepth + 1`, and `forkReason = matcher.modificationHint`.
   - Depth-cap log line: `[AgentFlow] Fork-mode skipped: parent ... at fork depth N (cap=3)`.

5. `backend/.prompts/agent-main/system.md`
   - Added "Fork-and-Adapt Mode" subsection documenting how to read the `## Parent Script to Adapt (FORK MODE)` block in the user message and how to adapt the parent body.

6. `MainAgent.handleQuestion()` — **no signature change**. The parent block lives in the user message; the system prompt's static section handles the rest.

**What fork mode skips at runtime**: SourceAgent dispatch is the *default* skip — the parent's `ctx.query` SQL is already proven. Component generation and analysis still run unchanged.

**When fork mode MUST dispatch a source tool** (Phase 2B+, refined after the AABGRWT incident):

1. **Up-front schema discovery** — the user's question references a column or table the parent does NOT query. The LLM has no way to verify the column exists by reading the parent body alone, so it must look it up before writing the script. Example: parent queries `AE_AIRWAYBILL.AABAIRLINENOCODE`; user asks for `AVG(AABGRWT)`. The LLM should dispatch a source tool with a focused intent like *"list columns in AE_AIRWAYBILL containing weight/grwt"* BEFORE `write_script`.

2. **Schema-error recovery** — `execute_script` fails with `Invalid column name` or `Invalid object name`. The LLM must dispatch a source tool to discover the correct name, then `write_script` again with the corrected body. Asking the user is reserved for genuinely ambiguous cases (mystery codes, unclear entity references) — NOT for missing columns the database can answer authoritatively.

The `agent-main/system.md` "Fork-and-Adapt Mode" section now explicitly lists these two situations with the AABGRWT example baked in, so the LLM has a concrete trigger for each escape clause rather than a vague "unless absolutely necessary".

**Cycle prevention**: implicit — the depth cap (3) bounds chain length. Cycles would require a buggy save path that points an existing recipe's `parentId` at one of its descendants; not constructible by the matcher.

**Fallback when fork attempts fail**: MainAgent's existing `MAX_SCRIPT_ATTEMPTS=3` cap applies. If all 3 fail, MainAgent answers from raw `executedQueries` (or empty if it never dispatched) — `savedScript` is `undefined` and nothing is persisted. The user still gets an answer; no orphan recipe lands in the store.

**Component generation in fork mode** (added after the first successful fork run, A3):

When MainAgent runs in fork mode and never dispatches a source tool, `agentResponse.executedTools` is empty — even though the script's `ctx.query` did execute and return rows. Without intervention, `agent-user-response.ts` falls into the "general question" branch and renders a `DynamicMarkdownBlock` (text only) instead of charts.

The fix: a fork-mode adapter just before the `hasExecutedTools` check. When `executedTools.length === 0` AND `savedScript.executedQueries.length > 0`, the adapter pushes the script's queries onto both `executedTools` and `sourceResults`, so the existing component-generation path produces charts the same way as the high-tier replay or fresh-authoring paths. See `agent-user-response.ts:STEP 3` and the log line `[AgentFlow] Fork-mode adapter: surfaced N script query result(s)` for verification.

**`federation_query` not found error after Shape B scripts** (added after a fresh HHI re-author):

Symptom: components render with `Tool 'federation_query' not found` errors at the frontend.

Root cause: the lightweight component generator (`script-component-generator.ts`) only sees the RAW columns returned by `ctx.query` calls, NOT the post-JS columns the script computes (`MarketShareSquared`, `MarketSharePercent`, etc.). When the user asks for those computed columns and they aren't visible in the column list, the LLM falls back to writing a federation SQL with `POWER(...) OVER()` window functions — which works against DuckDB internally but produces components with `toolId: 'federation_query'` that the frontend can't resolve for single-source projects.

Fixes applied:
- **`script-component-generator.ts`** — added a guard that gates the federation path on `isMultiSource && federationTool`. When either condition fails, the component falls back to single-source with a `[ScriptComponentGen] Component "..." requested federation, but ... — falling back to single-source` warning. Better than a hard frontend error.
- **`backend/.prompts/script-components/system.md`** — added explicit rule: *"Never use federation for column re-computation on a single source. Federation is ONLY for combining ROWS from multiple sources, not for adding derived COLUMNS to a single source."*

Phase 3 hardening item: surface the script's post-JS final data (`scriptResult.data`, not just `executedQueries[].data`) to the component generator so the LLM sees the full computed column list and never reaches for federation in the first place. Until that's wired, the gate prevents the user-visible error but charts will render the raw columns instead of the computed ones for these cases.

### Phase 3 — Hardening (PENDING)

- Fork-depth cap enforcement (loud log when triggered).
- Bug-inheritance flag on descendants when parent failure rate spikes.
- Telemetry: track per-tier latency, success rate, fork attempts needed.
- Lineage-aware pruning policy.

### Phase 3B — High-match repair-on-fail (PENDING — after component-consistency work)

Sequenced **after** `SCRIPT-COMPONENT-CONSISTENCY.md` Phases 1–3 land. See the "High-match failure recovery" section above for the full design. Summary of changes:

- `agent-user-response.ts` — on `tier: 'high'` execution failure, branch on `errorPhase`: retry once for `timeout`/`ipc` (no `recordFailure`); for `compile`/`runtime`, build a repair `forkContext` (`parentBody` = failed body, hint = error) and enter the MainAgent.
- `script-store.ts` — repair save path: same `id`, `version++`, no `parentId`/`forkDepth` change, clear `lastError`.
- Fall back to fresh authoring only when repair exhausts `MAX_SCRIPT_ATTEMPTS`.

### Phase 4 — Optimization (DEFERRED)

- Embedding-tier hint: ChromaDB similarity 0.6–0.8 pre-biases the matcher toward `near`.
- Auto-merge suggestion: when ≥3 forks of the same root differ only by params, suggest a parameterized rewrite.
- Lineage admin UI / endpoint: list, disable, prune subtree, family failure rates.

---

## Test scenarios for Phase 2B

These tests are tailored to the three currently-saved scripts:

- **`airline-hhi-calculation`** — counts airway bills per `AABAIRLINENOCODE` from `dbo.AE_AIRWAYBILL`, computes HHI in JS (Shape B).
- **`volume-weighted-avg-exchange-rate-by-currency`** — `SUM(INVTOTAL*INVEXRATE)/SUM(INVTOTAL)` per `INVCURRENCY` from `dbo.INV_DETAILS` (Shape A passthrough).
- **`branch-sb-to-invoice-ratio-analysis`** — `FULL OUTER JOIN` of `SB` and `INVOICE` aggregates by `MAOOFFICEID`, classifies branches as SB-Heavy / Invoice-Heavy / Balanced (Shape A).

If you regenerate these under the Phase 1 generous-parameterization policy, expected matches may shift slightly (some "near" cases collapse into "high" with a parameter binding). Test outcomes below assume the scripts as currently saved.

### What to verify per test

For every test, after the run completes:

1. **Logs**: confirm the expected `[ScriptMatcher]` line and downstream `[AgentFlow]` / `[MainAgent]` markers.
2. **`metadata/<name>.json`**: for fork mode, `parentId` should equal the parent recipe's id and `forkDepth` should be `parent.forkDepth + 1`. For fresh mode, `parentId` should be absent and `forkDepth: 0`.
3. **`<name>.ts` body**: for fork mode, confirm the LLM's modification is small and targeted (preserves the parent's working SQL skeleton, changes only what the gaps demanded).
4. **Time + LLM cost**: fork mode should run in ~12–18s with no `[SourceAgent] Starting` line. Fresh authoring runs in ~25–35s with full SourceAgent dispatch.

---

### Test set A — `airline-hhi-calculation` lineage

**A1. HIGH (replay)**

> *"How concentrated is the airline market for airway bills based on HHI?"*

Expected:
```
[ScriptMatcher] Matched "Airline HHI Calculation" (tier: high). Reason: ...
[ScriptRunner] Executing "Airline HHI Calculation" with params: {}
[AgentFlow] Script flow complete | ... ~12s
```
No `[MainAgent] Starting`, no fork log, no new script saved.

**A2. NEAR (fork — metric swap)**

> *"For each airline, what's the average airway bill weight (AABGRWT)?"*

This swaps `COUNT(*)` for `AVG(AABGRWT)` and drops the HHI math. Same table, same dimension, different metric. Expected:
```
[ScriptMatcher] Near match "Airline HHI Calculation". Gaps: ...; Hint: replace COUNT with AVG(AABGRWT) and drop HHI math
[AgentFlow] Fork mode: parent "Airline HHI Calculation" (depth=0) — MainAgent will adapt the body
[MainAgent] Starting | prompt: "## Parent Script to Adapt (FORK MODE)..."
[MainAgent] write_script: draft "..." saved
[MainAgent] execute_script: ok — N rows
[MainAgent] Script authored: "..."
[ScriptStore] Saved script "..."
[AgentFlow] Fork persisted: "..." → parent "Airline HHI Calculation" (depth 1)
```
**No `[SourceAgent] Starting` line.** The new script's `parentId` should equal `airline-hhi-calculation`'s id; `forkDepth: 1`.

**A3. NEAR (fork — dimension swap)**

> *"Calculate HHI for shipper concentration in airway bills, using AABSHIPPERID."*

Same table + same metric + same HHI math, just swap `AABAIRLINENOCODE` → `AABSHIPPERID`. Should fork. Watch the new `.ts` body — only the `GROUP BY` column should change.

**A4. NONE (fresh)**

> *"Top 5 IEC exporters by shipping bill count."*

Different table (`dbo.SB`), different domain. Expected:
```
[ScriptMatcher] No match. Reason: ...
[MainAgent] Starting | prompt: "Top 5 IEC exporters..."
[MainAgent] Dispatching SourceAgent for "Query Microsoft SQL Server Connection"
... full agent flow ...
[AgentFlow] Fork persisted: "..." → parent "..." (depth N)   ← MUST NOT appear
```
The saved metadata should have `parentId: undefined` and `forkDepth: 0`.

---

### Test set B — `volume-weighted-avg-exchange-rate-by-currency` lineage

**B1. HIGH (replay)**

> *"Show me the weighted average exchange rate per currency, weighted by invoice total."*

Already known to match. Expect tier=high, replay path, ~12s.

**B2. NEAR (fork — dimension swap)**

> *"Volume-weighted average exchange rate per branch (INVBRANCHID), weighted by invoice total."*

Same table + same weighting + different dimension. The fork should swap `GROUP BY INVCURRENCY` → `GROUP BY INVBRANCHID` and adjust column aliases. No SourceAgent dispatch.

**B3. NEAR (fork — aggregation swap)**

> *"For each invoice currency, what's the maximum and minimum exchange rate observed?"*

Same table + same dimension + different aggregation (`MAX`/`MIN` instead of weighted avg). Should fork. The fork's SQL should keep the `WHERE INVEXRATE IS NOT NULL ...` clauses and `GROUP BY INVCURRENCY`, only change the aggregate functions.

**B4. NONE (fresh)**

> *"List top 5 IEC exporters by total shipping bill count."*

Same negative test as A4 — different table. Should not match either of the existing scripts.

---

### Test set C — `branch-sb-to-invoice-ratio-analysis` lineage

**C1. HIGH (replay)**

> *"Per branch, ratio of shipping bills to invoices issued — which branches are SB-heavy?"*

Already tested earlier — matched as high.

**C2. NEAR (fork — aggregation swap, ratio → difference)**

> *"For each branch, what's the absolute difference in count between shipping bills and invoices?"*

Same `FULL OUTER JOIN` skeleton, different final calculation (`SB_Count - Invoice_Count` instead of the ratio + classification). Should fork. The fork should keep the JOIN and `COALESCE` logic, replace only the ratio expression.

**C3. NEAR (fork — table swap)**

> *"For each branch, ratio of import bills (table `dbo.IMP`) to invoices issued."*

Same shape, table swap on the SB side. The fork needs to verify `dbo.IMP.MAOOFFICEID` exists (it might not — see caveat below). If the LLM's `execute_script` fails due to a non-existent column, watch the 3-attempt fix-loop in action.

> ⚠️ **Caveat for C3**: if `dbo.IMP` does not have `MAOOFFICEID`, the LLM may need 2–3 fix-loop attempts to find a valid join column (`IMPBRANCHID`?) — or fail entirely and answer from no data. This is a useful test of fork-mode robustness regardless of which path it takes.

**C4. NONE (fresh)**

> *"What's the most frequent voucher type in transactions (ACTVOUCHERTYPE)?"*

Different table (`dbo.ACC_TRANSACTION`), different domain. Should not match.

---

### Test set D — Synthetic depth-cap probe (run after A2 has produced a depth-1 fork)

**D1.** Re-run A2 to ensure a depth-1 fork exists (the avg-airway-bill-weight script).

**D2.** Fork the depth-1 fork:

> *"For each shipper (AABSHIPPERID), what's the average airway bill weight?"*

If this matches the depth-1 fork as `near` (rather than the original HHI), expect a depth-2 save. Confirm `forkDepth: 2` in metadata.

**D3.** Fork the depth-2 fork:

> *"For each consignee (AABCONSIGNEEID), what's the average airway bill weight?"*

Should produce a depth-3 fork.

**D4.** Attempt one more fork from the depth-3 child:

> *"For each branch (AABBRANCHID), what's the average airway bill weight?"*

Expected log:
```
[ScriptMatcher] Near match "..."
[AgentFlow] Fork-mode skipped: parent "..." is at fork depth 3 (cap=3). Falling through to fresh authoring.
[MainAgent] Starting | prompt: "For each branch..."   ← no parent block, no fork mode
... full agent flow runs ...
```
The resulting save should have `parentId: undefined` and `forkDepth: 0` — it's a root, NOT a depth-4 fork.

> Note: D2/D3 only work if the matcher consistently picks the closest fork (not the original root) at each step. If the matcher picks an earlier ancestor, depth growth stalls. That's not a bug — it's a calibration question for Phase 4 (lineage-aware tier hinting).

---

### Calibration heuristics — what to do if outcomes don't match expectations

| Symptom | Likely cause | Fix |
|---|---|---|
| Near-match question goes to `none` | Matcher prompt's "near" definition too strict | Lower the structural-overlap threshold in the matcher prompt's decision rules (currently "70–90%") to "60–90%" |
| Near-match question goes to `high` and replays the wrong script | Matcher prompt prefers `high` too eagerly | Tighten "high" definition to require both intent + parameters match — not just intent |
| Fork mode dispatches a SourceAgent for trivial reasons | LLM is over-using the schema-discovery escape clause | Tighten the "schema discovery" trigger so it requires the user to name an unknown column/table — not just any uncertainty |
| Fork mode does NOT dispatch when it should (column hallucination, asks user instead) | LLM treated "do not dispatch" too literally — ignored escape clauses | Verify "Source-tool dispatch in fork mode" subsection in `agent-main/system.md` is loaded and concrete (the AABGRWT example helps); also confirm the prompt says asking the user is the LAST resort for missing-column errors |
| Fork mode produces a body identical to the parent | LLM didn't actually modify | Check that the user message correctly contains the gaps + hint; if those are missing or vague, matcher prompt needs sharper gap-detection guidance |
| Depth cap fires when it shouldn't (parent at depth < 3) | `forkDepth` migration didn't run for legacy recipes | Verify `metadata/*.json` files all have `forkDepth: 0` after first load; otherwise inspect `loadAllFromDisk` migration |

---

## Open decisions for Phase 2B

1. **Fork-mode source-tool access** — should fork mode **forbid** SourceAgent dispatch, or just **discourage** it? Forbidding is cleaner but breaks cases where the fork legitimately needs a column the parent didn't query. **Lean: discourage.** Let MainAgent dispatch SourceAgent if it's genuinely necessary; log it loudly so we can see if forks are leaking into full agent flow.
2. **Save when fork attempts fail** — when fork mode falls back to fresh authoring, the eventual saved recipe should have `parentId: undefined` (it's a from-scratch script that just happened to start as a fork attempt). The forkContext is discarded on fallback.
3. **Telemetry shape** — minimum to log per turn: `{ tier, parentId?, attempts, totalMs, fellBackToFresh: boolean }`. Aggregate later.
4. **Naming collisions** — fork-author picks a new name; let the LLM differentiate (it sees the parent's name as context). Auto-suffix `-fork-N` only on actual kebab-name collision (separate issue from doc's Issue #5).

---

## Cross-references

- `backend/docs/SCRIPT-FLOW-IMPLEMENTATION.md` — overall script flow architecture, current implementation status, known issues.
- `backend/docs/SCRIPT-COMPONENT-CONSISTENCY.md` — analysis↔component consistency + component recipe; Phase 3B (high-match repair-on-fail) is sequenced after this work lands.
- `backend/.prompts/script-match/system.md` — matcher prompt (Phase 2A: tier classification).
- `backend/.prompts/agent-main/system.md` — MainAgent prompt (Phase 1: parameterization; Phase 2C will add fork-mode authoring section).
- `sdk-nodejs/src/userResponse/scripts/script-matcher.ts` — matcher entry point.
- `sdk-nodejs/src/userResponse/scripts/types.ts` — `MatchTier`, `ScriptMatch`, `ScriptRecipe` (parentId/forkDepth fields land here in Phase 2B).
