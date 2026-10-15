# Script Flow — User-Directed Script Editing

Companion to `SCRIPT-FLOW-IMPLEMENTATION.md`. Covers the **edit** path: letting a user correct an existing script recipe by stating the change in natural language, instead of hoping a re-phrased question produces a better fresh generation.

---

## Problem

The script flow is binary today (`script-match/system.md`):

- **high** → replay the existing script unchanged with new parameter values
- **none** → run the full agent flow and author a fresh script

Neither handles the case the user actually hits most often: *the saved script is wrong*. An LLM-authored recipe can use the wrong aggregation (mean where the domain standard is mode), miss a dimension, carry an over-broad filter, or select the wrong column. Today the only recourse is to re-ask the question differently and hope for a better generation — and meanwhile:

1. The bad script **stays in the store** and keeps winning FTS matches for similar questions.
2. Every cached conversation bound to it keeps replaying the wrong answer.
3. The user has no way to express what they already know: *"this is nearly right, just use mode instead of mean."*

### What we want

```
User: "day-wise WSP vs RSP for Odisha districts"
  → script authored, answer rendered   (tier: none)

User: "this should use mode, not mean"
  → the SAME recipe is corrected, re-run, and the answer re-rendered
  → every future replay of that recipe is fixed too
```

The correction is retroactive by construction, because the recipe id stays stable.

---

## Why this is safe now, when fork/near was not

The retired `near` (fork-and-adapt) tier failed twice, for two **different** reasons. Only one of them is relevant here.

| Failure | Cause | Status |
|---|---|---|
| Fork turns emitted a bare-markdown preamble with **0 tool calls** | Prompt control — the model didn't treat the fork preamble as a call to act | **Fixed.** `firstIterationToolChoice: {type:'any'}` + the BEGIN-NOW block (`agent-user-response.ts:870`). Still in the code. |
| Mis-reused scripts produced **wrong answers** | Matcher precision — an LLM judging "is this script ~close enough to adapt?" | **Retired.** `script-match/system.md`: *"a mis-reused script produces wrong answers, which is far worse than the cost of regenerating."* |

The second failure is **structurally absent** from edit mode: the matcher is not inferring that a script is close enough to modify. The user is naming the modification. The classification collapses from a judgement call ("how similar is this?") to a much easier one ("is the user telling me to change the script that just ran?").

The first failure's fix is already in the tree and gets reused verbatim.

---

## Design overview

Three additions, no new subsystems:

1. An **active-script binding** on the turn — which recipe produced the previous answer.
2. A third matcher outcome **`edit`**, only reachable when that binding exists.
3. **Edit mode on `MainAgent`** — the same harness (same tools, same loop, same `write_script`/`execute_script` verification), with a **different system prompt**.

Plus a commit path that lands the change **in place as version N+1** on the same recipe id.

```
prompt
  ├─ exact-match cache hit ──────────────────────────► replay cached UIBlock
  │
  ├─ ScriptMatcher (1 LLM call, catalog + ACTIVE SCRIPT)
  │     ├─ tier "high"  → runScript, unchanged                  (~2 LLM calls)
  │     ├─ tier "edit"  → MainAgent[editMode] ──┐               (~3 LLM calls)
  │     └─ tier "none"  → MainAgent[generate]   │               (~4+ LLM calls)
  │                                             │
  └─────────────────────────────────────────────┘
                     │
        write_script → shadow draft (new id, parentId = original)
                     │
        execute_script → verify (max 3 attempts, existing loop)
                     │
              ok ────┴──── fail → discard shadow, original untouched
               │
        commitEdit(originalId, shadow) → version N+1, same id
               │
        script-analysis → components  (existing tier-high tail)
```

Cost note: an edit is **cheaper than a regeneration** — it skips schema discovery in the common case and starts from proven SQL.

---

## Decision record

Recorded because each was contested; future readers will re-ask.

### D1 — Detect edit intent inside the existing matcher call

**Decision:** extend `script-match` with a third tier rather than adding a classifier.

**Why:** the matcher call already happens on every turn with a non-empty store, and it is already the "which script, if any" decision point. Zero added latency.

**Rejected:** a separate pre-classifier (an extra LLM call on every turn to catch a minority case); regex/heuristic detection of edit phrasing (false positives on ordinary questions that happen to contain "change" or "instead").

### D2 — Run edits through the `MainAgent` harness, not a single-shot transformer

**Decision:** edits execute in `MainAgent` with source tools available.

**Why:** most real edit instructions **add** something — a dimension, a join, a filter value, an excluded category. Adding requires exact column names, join keys and valid filter values, which means schema access and sometimes an exploratory query. A body-only transformer would have to guess column names — the precise failure `agent-source-query/system.md` spends half its length preventing.

**Rejected:** a dedicated single-shot `script-edit` prompt as the *primary* path. It handles "mean → mode" beautifully and nothing else. Revisit as a **fast path** only if telemetry (see Validation) shows most edit turns never dispatch a source tool.

### D3 — Separate system prompts, shared body contract

**Decision:** two framings (`agent-main`, `agent-main-edit`), one shared `{{SCRIPT_BODY_CONTRACT}}`.

**Why:** the two framings **contradict** on the single most consequential decision of the turn.

| `agent-main` (generate) | `agent-main-edit` |
|---|---|
| "Every answer that uses source data MUST come from an executed script: query the source tool → `write_script`" | "Start from this proven body. Query the source **only** if the change needs data the body doesn't already have." |

If both are resident in one rendered prompt the model must classify its own regime before acting, and the failure is silent and asymmetric: it dispatches a source query on an edit, re-authors the SQL from scratch, and drops a predicate nobody asked it to remove. That is exactly the regression `agent-main/system.md:141` (the PRESERVE-EVERY-FILTER paragraph) exists to fight.

Supporting reasons: conditional instructions (`if you were given a parent body…`) follow worse than unconditional ones; `agent-main` is already 319 lines and visibly strained — it contains a section literally titled *"Mandatory ordering — resolves the conflict with the rules above"*; and clients tune these prompts per deployment, so a merged file makes every edit-mode tweak a live change to the generation path.

**What must NOT diverge:** the rules that define what a valid script *is* — `ctx` API, render cap, LIMIT placement, ties/stable sort, aggregate-in-SQL, counts-from-aggregates, grain matching, exact field names, homogeneous datasets, parameterization, the four script shapes. If generation and edition each carry their own copy, an edited script drifts from the generated shape and downstream replay/component binding becomes inconsistent. Hence the shared contract.

**Filing note:** "two `.md` files" vs "one skeleton file with a swapped `{{MODE_FRAMING}}` block" is a packaging choice — functionally identical. The invariant is **one framing per rendered prompt**.

### D4 — Commit in place as version N+1, same recipe id

**Decision:** the edited body replaces the original under a stable id; prior versions are archived.

**Why:** every cached conversation, every `script_dataset` regeneration descriptor, and every persisted component spec already points at that id. Keeping it stable makes the fix **retroactive** — replays of the old answer pick up the corrected script automatically, which is what a user correcting a bad script expects.

**Rejected:** fork-to-new-recipe. It bloats the catalog with near-duplicates — precisely what the binary reuse policy exists to prevent — and the matcher then has two similar candidates to choose between. Revisit only if per-user divergent variants become a real requirement (see Open Decisions).

### D5 — Verify on a shadow draft before committing

**Decision:** the edited body is written as a **separate draft recipe** (new id, `parentId` = original), executed, and only merged back on success.

**Why:** never break a working script while trying to improve it. If the edit fails all attempts, the original is untouched and the shadow is discarded — the existing end-of-turn draft cleanup (`main-agent.ts:376`) already does this.

---

## Component 1 — Active-script binding

**The one hard prerequisite.** Everything else depends on knowing which recipe produced the previous answer.

### What to store

```ts
interface ScriptBinding {
  recipeId: string;
  params: Record<string, any>;
  /** name at bind time — used in the matcher catalog + user-facing confirmations */
  name: string;
}
```

### Where it gets set

| Path | Location |
|---|---|
| Tier-high replay | `agent-user-response.ts:820` (script-flow return) |
| Fresh authoring | `agent-user-response.ts:1353` (after `promoteToVerified`) |
| Edit | the commit path (Component 5) |

### Where it gets persisted

- **In-session:** on the `UIBlock` registered in the thread (`user-prompt-request.ts:202`), so the next turn in the same thread can read it without a DB round-trip.
- **Across sessions:** inside the saved conversation `response` JSON, so a follow-up after a page reload still resolves. `userConversations.response` is JSONB — a `response->'uiblock'->>'scriptRecipeId'` path works with no migration, but a dedicated indexed column is preferable because Component 5 needs to query *by recipeId* for cache invalidation.

> **Note the synergy:** this single binding serves both the follow-up detection (Component 2) *and* the cache-invalidation key (Component 5). Build it once, properly.

### Fallback

`extractBoundRecipe` (`agent-user-response.ts:99`) already recovers a `recipeId` by decrypting a cached component's `script_dataset` token. Keep it as a fallback for conversations saved before this ships, but do not rely on it — it only works for virtual datasets.

### Durability and disambiguation (learned in testing)

Two problems surfaced only once the feature ran end to end. Both are fixed; both are easy to regress.

**1. The binding must survive the process.** `ThreadManager` is an in-memory Map. A backend restart re-creates the thread with the same id and **zero UIBlocks**, so `getScriptBindings()` returns nothing, the matcher correctly coerces `edit` → `none`, and the edit silently degrades into a general question ("what data are you working with?"). This is not an edge case — it hits every restart and every returning user.

The binding was already persisted; only the read was missing. `user-prompt-request.ts` now tries memory first (no round-trip) and falls back to `conversation-history.threadScriptBindings`.

**2. "Most recent" is a guess, and a wrong guess is silent.** Returning only the newest binding forces every edit onto the latest script. In a thread that ran several, an instruction meant for an earlier one silently edits the wrong recipe — committing a version, superseding caches and renaming a file the user never mentioned. Nothing catches it, because the newest *is* a legitimate binding.

Fix: hand the matcher up to `MAX_EDIT_CANDIDATES = 5` recent bindings (deduped by recipeId, each labelled with the question that produced it) and let the instruction pick its target. The guard tightens rather than loosens — from *"must equal the one active binding"* to *"must be one of this thread's candidates"* — so the matcher still cannot reach into the wider catalog.

**Scoped to one thread on purpose.** An edit is a conversational act: it refers to something the user is looking at. Widening the candidate set across threads would turn it back into the full catalog and reintroduce exactly the loose-inference failure that retired the `near` tier. Editing a script from another conversation is the cold-reference case (Phase 5), where the user names it explicitly.

**Tie-break:** a bare instruction ("use the mode instead") takes candidate #1, the most recent. Additional candidates only come into play when the instruction names something.

---

## Component 2 — Matcher `edit` tier

### Catalog change

Inject the active recipe as a distinguished block, **regardless of FTS rank** (a follow-up like "use mode instead" shares no keywords with the script name and will never rank):

```
## ACTIVE SCRIPT — produced the previous answer in this conversation
[script_1721_a3f9] "Day-wise WSP vs RSP by district"
   Retrieves day-wise wholesale and retail prices per district for a state and date window.
   Parameters:
     - state (string, default: "Odisha") — state to filter
     - dateFrom (date) …
   Returns columns: Date, District, series, WSP, RSP

## Other candidate scripts
1. [script_...] …
```

### Prompt additions to `script-match/system.md`

- A third tier `edit`, defined as: *the user is instructing a change to the ACTIVE SCRIPT, rather than asking a new question.*
- Explicit **gate**: `edit` is only valid when an ACTIVE SCRIPT block is present. Without one, the two-tier policy is unchanged.
- Explicit **anti-gate**: a new question about the same topic is **`none`**, not `edit`. Only an instruction to modify counts.

### Response shape

```json
{
  "tier": "edit",
  "scriptId": "script_1721_a3f9",
  "editInstruction": "compute WSP and RSP as the mode of daily observations rather than the mean",
  "params": { },
  "reasoning": "User is correcting the aggregation used by the active script."
}
```

`editInstruction` must be **self-contained** — a full restatement of the change, with pronouns and deixis resolved ("this", "it", "that column"). Downstream never sees the conversation history, so an unresolved instruction is unusable.

### Runtime guard

Mirror the existing `near` coercion (`script-matcher.ts:106`) so a prompt regression cannot re-enable a loose path:

```ts
if (tier === 'edit' && !activeBinding) {
  logger.info(`[ScriptMatcher] 'edit' coerced to 'none' (no active script binding)`);
  tier = 'none';
}
```

Also verify the returned `scriptId` **equals the active binding's recipeId** — the matcher must not be allowed to redirect an edit onto a different script it happened to like better.

---

## Component 3 — Prompt layer

### 3a. Extract the shared contract

Move the script-body rules out of `agent-main/system.md` (roughly the span from *"Keep the script's OUTPUT small enough to render"* through the four script shapes, ~lines 111–252) into:

```
backend/.prompts/script-rules/body-contract.md
```

This must be a **pure move**: not one word changed that governs generation. The diff should be `agent-main/system.md` losing that span and gaining `{{SCRIPT_BODY_CONTRACT}}` in its place, plus the new file.

Contents (unchanged): render cap, RAISE-the-limit rule, where the LIMIT goes, ties/stable tie-break, `ctx.query` vs `ctx.runTool`, aggregate-in-SQL, every-stated-number-is-a-column, counts-from-aggregates, derived-breakdown rule, grain matching, exact field names, homogeneous datasets, roll-up placement, parameterization guidance, shapes A–D.

### 3b. Loader support

Add to `prompt-loader.ts`, mirroring `loadDatabaseRulesForType`:

```ts
async loadScriptBodyContract(vars: Record<string, string>): Promise<string>
```

> **Gotcha — nested placeholders.** Variable substitution is **single-pass and non-recursive** by design (`prompt-loader.ts:110`, to prevent value-injection). The contract contains `{{MAX_ROWS_RENDERED}}` and `{{MAX_ROWS_FETCHED}}`. If injected raw they will **not** be filled. Render the contract's own placeholders first, then inject the rendered text as `{{SCRIPT_BODY_CONTRACT}}`.

### 3c. `agent-main-edit/system.md`

New prompt. Structure:

```
framing(edit)
{{PARENT_SCRIPT_BODY}}
{{EDIT_INSTRUCTION}}
{{LAST_RESULT_COLUMNS}}
{{SCRIPT_BODY_CONTRACT}}
{{SOURCE_SUMMARIES}}   ← recipe's sources first, others available
{{DIRECT_TOOLS}}
{{GLOBAL_KNOWLEDGE_BASE}} / {{KNOWLEDGE_BASE_CONTEXT}} / {{CONVERSATION_HISTORY}}
```

What the framing says, versus `agent-main`:

| `agent-main` | `agent-main-edit` |
|---|---|
| Query the source, then wrap the proven SQL | Start from the parent body; go straight to `write_script` unless the change needs data the body lacks |
| Complexity classification + `MAX_SOURCE_CALLS` budget | Source calls are the exception; state why one was needed |
| Intent faithfulness vs. the user's question | Faithfulness vs. **the instruction** |
| Full source summaries for routing | Recipe's sources first; others available for genuine additions |

**The load-bearing rule** — state it prominently and repeat it in the final-check section:

> Change ONLY what the instruction names. Every other predicate, JOIN, GROUP BY, column, ordering and parameter stays **byte-identical**. If the instruction does not mention it, do not touch it. Rewriting the body wholesale is a failure even if the result runs.

Collateral damage — not compile errors — is the dominant failure mode of an edit.

Also required in the output: a one-line `changeSummary` (surfaced to the user), and a re-emitted `parameters` array (an edit may add or remove knobs).

### 3d. Fallback registration

`loadPromptTemplate` throws when a name exists in neither the filesystem nor the hardcoded map (`prompt-loader.ts:58`), and `initialize()` iterates `Object.keys(PROMPTS)`. Add an `agent-main-edit` entry to `prompts.ts` — the `.md` files alone are not sufficient.

---

## Component 4 — `MainAgent` edit mode

Additive; no change to the generation path.

```ts
interface EditContext {
  recipeId: string;
  parentName: string;
  parentBody: string;
  instruction: string;
  lastResultColumns?: string[];
  sourceIds: string[];
}
```

- Constructor takes `editContext?: EditContext` alongside the existing `forkMode` flag.
- `buildSystemPrompt` selects `agent-main-edit` when it is set, and fills the extra placeholders.
- `firstIterationToolChoice: {type:'any'}` applies in edit mode too (`main-agent.ts:328`) — there is no legitimate "answer with bare prose" outcome, and `any` lets the model pick `write_script` for a body-only change *or* a source tool for schema discovery.
- `handleWriteScript` is unchanged: it saves a **draft under a fresh recipeId**, which is exactly the shadow draft D5 wants. Set `parentId = editContext.recipeId` at save time.
- `execute_script`, the 3-attempt cap, error phases, and end-of-turn draft cleanup are all unchanged.

`agentResponse.savedScript` therefore arrives at the caller identically to a fresh authoring turn — the only difference is what the caller does with it (Component 5).

---

## Component 5 — Commit and housekeeping

`ScriptStore.commitEdit(originalId, verifiedDraft, meta)` replaces `promoteToVerified` on the edit path.

| Step | Detail | Why |
|---|---|---|
| Archive prior body | `scripts-store/.versions/<fileBase>.v<n>.ts` + a `history` JSONB entry (`version`, `at`, `by`, `instruction`, `changeSummary`, `bodyHash`) | rollback; the disk body is already the source of truth. Archives go in a **dot-prefixed subdirectory**, not beside the live file — `scripts-store/` is browsed and hand-edited in an IDE, and one archive per edit would bury the live scripts. Deleting a recipe removes its archives too. |
| Write new body | to the original `fileBase`, atomically (`script-store.ts:477`) | id and filename stay stable |
| `version++` | the column already exists and is currently never bumped | free field |
| Copy metadata | `parameters`, and `name`/`intentDescription` if the edit changed the script's purpose | matcher catalog must reflect reality |
| **Reset health counters** | reuse `resetScriptRecipeStats(id)` | already exists for exactly this case — *"admin fixed the body, its success/failure history is stale"*. Do not let a pre-edit failure streak keep the corrected script invisible. |
| **Clear `components` specs** | set to `null` | stored specs were validated against the old shape. `assembleComponentsFromSpecs` catches *column* drift, but an edit that keeps the columns and changes their meaning (mean → mode) sails straight through and replays a stale title. Force regeneration; it backfills next run. |
| **Supersede bound conversations** | flip `status` to `'superseded'` on `userConversations` rows whose binding matches `recipeId` — do **not** delete | **highest-risk omission.** The exact-match cache is gate 0 and short-circuits *before* the matcher, so re-asking the original question replays the pre-edit answer and the user concludes the edit did nothing. See "Why supersede, not delete" below. |
| Delete the shadow draft | row + body file | no litter |
| Record provenance | `editedBy` (userId), `editedFrom` (the instruction) | audit trail; multi-user blast radius |

Then continue into the **existing tier-high tail** — `script-analysis` → `generateScriptComponents` — using the `ScriptResult` already produced during verification. Prepend one streamed line so the change is visible:

> ✏️ **Updated "Day-wise WSP vs RSP by district"** — now uses mode instead of mean.

---

### Why supersede, not delete

Three cached artefacts go stale when a recipe's body changes, and only one of them recovers on its own:

| Cached artefact | Self-heals after the edit? |
|---|---|
| The stored `analysis` text | **Never** — `cachedTextResponse` is returned verbatim from the row. |
| Real-SQL components (`_queryMap`) | **Never** — rehydration re-registers the SQL captured at *authoring* time, not the edited script's SQL. |
| Computed (`script_dataset`) datasets | Eventually — once the queryCache entry evicts, `directReplay` re-runs the now-corrected recipe. |

So doing nothing leaves two of three permanently wrong, on the exact question the user was trying to fix.

But **deleting** the rows is the wrong remedy: it destroys real conversation history to solve a cache problem — edit a script, and past conversations disappear from the sidebar.

`status` is consulted in exactly one place: `getConversationByUserPrompt(..., 'success')`, which only `conversation-history.exactMatch` passes. Nothing else — thread listing, history, search — filters on it. So flipping `status` to `'superseded'` disables replay while leaving the row completely intact. The next identical ask falls through to the matcher, which replays the corrected recipe and writes a fresh row.

## Data model changes

`script_recipes`:

| Column | Type | Purpose |
|---|---|---|
| `edited_by` | text, null | who last edited |
| `edited_from` | text, null | the instruction that produced this version |
| `history` | jsonb, null | array of prior-version records |

`user_conversations`: a `script_recipe_id` column (indexed) — otherwise invalidation is a JSONB path scan over the whole table.

`version` already exists on `script_recipes` and needs no migration, only use.

---

## Phasing

| Phase | Scope | Ships |
|---|---|---|
| **1** | Active-script binding (Component 1) — set, persist in-session and in the conversation row | nothing user-visible; unblocks everything |
| **2** | Contract extraction + `agent-main-edit` (Component 3) | prompts only; generation path must be byte-identical after the move |
| **3** | Matcher `edit` tier + `MainAgent` edit mode + commit (Components 2, 4, 5) | feature works end-to-end |
| **4** | Housekeeping hardening: versioning/rollback UI, cache invalidation, admin-path consolidation | correctness at scale |
| **5** | Cold reference ("edit the day-wise script to…") — matching a script the conversation didn't just run | lower reliability; only if asked for |

Phase 2 is independently verifiable: extract the contract, change nothing else, confirm generated scripts are unchanged on a fixture set. Do not bundle it with Phase 3.

### Consolidate with the admin path

There is already a manual script-body editor (`scripts-admin` collection + the sa-platform-ui Scripts page). Both paths must call **one** `updateScriptBody()` service performing normalize → verify → version → reset stats → clear specs → invalidate cache. Two independent edit paths will drift, and the conversational one will be the one missing invalidation.

---

## Risks and open decisions

**Blast radius (needs a product decision).** Recipes are project-scoped, not user-scoped. One user's "fix" silently changes everyone's answers. In-place versioning is right for a *correction*; if divergent per-user preferences turn out to be real, that needs fork-to-new-recipe instead, with the catalog-bloat cost that implies. Minimum for v1: `edited_by` + `edited_from` + a rollback path. Consider a role gate.

**"It ran" ≠ "it's right."** The only success gate is `data.length > 0`. An edit that quietly drops a filter still passes verification. Mitigations, cheapest first:
1. Show `changeSummary` plus the new headline numbers so the user can judge — this is the whole point of the feature.
2. A deterministic **collateral-damage check** at commit: extract string literals and WHERE predicates from the old and new bodies; flag any that vanished without being named in the instruction. Cheap, mechanical, and it targets the dominant failure mode directly.

**Edit-of-an-edit.** Iterating ("now also exclude damaged branches") must rebind to the *new* version, not the original. Falls out naturally if the binding is refreshed on commit — but test it explicitly.

**Matcher redirection.** Guard that the returned `scriptId` matches the active binding (Component 2) — an edit landing on the wrong recipe silently corrupts a script the user never mentioned.

**Prompt-cache placement.** Inject `{{PARENT_SCRIPT_BODY}}` / `{{EDIT_INSTRUCTION}}` after the static contract, not before, so the cacheable prefix stays intact across turns.

---

## Implementation notes — deltas found while building

Two things the design above did not anticipate. Both are fixed in the code; recorded here because they are easy to reintroduce.

### 1. A shadow draft can collide with its parent's on-disk filename

The edit prompt tells the agent to keep the parent's `name` unless the purpose changed — so the shadow draft slugs to the **same** `fileBase`. `computeFileBase` normally disambiguates via `fileBaseTaken`, but that check swallows store errors and falls through to the bare slug (`script-store.ts` `computeFileBase`). On collision the shadow **overwrites the parent's live body**, and `commitEdit`'s shadow cleanup then unlinks it — destroying the working script.

Fixed at both ends:
- `saveDraft` forces a suffixed `fileBase` (`<slug>-<id6>`) whenever `parentId` is set, so a shadow can never share a file with its parent regardless of what `fileBaseTaken` returns.
- `commitEdit` re-checks before deleting the shadow: if the two still share a `fileBase`, it removes the metadata row only and leaves the body file alone.

Caught by the runtime test; it would have been a silent data-loss bug in production.

### 2. The conversation row is a FLAT `DBUIBlock`, not a nested uiblock

`user_conversations.response` stores `transformUIBlockForDB` output — `{id, component, analysis, user_prompt, error}` — not `uiBlock.toJSON()`. Two consequences:

- `transformUIBlockForDB` had to be extended to carry `scriptBinding` through, or the binding never reaches the DB and a follow-up edit breaks after a page reload.
- The invalidation predicate and its index are `response->'scriptBinding'->>'recipeId'`, **not** `response->'uiblock'->...`.

### Migration

`0016_script_edit_provenance.sql` — adds `script_recipes.edited_by / edited_from / history` and the
`idx_user_conversations_script_recipe` expression index. Registered in `drizzle/meta/_journal.json`.

---

## Validation

**Phase 2 gate — contract extraction is lossless.** Run a fixture set of generation prompts before and after the move; the authored script bodies should be materially identical. Any difference means the extraction changed wording it shouldn't have.

**Phase 3 gate — edit accuracy.** Assemble ~20 real edit instructions, split between body-only ("use mode", "top 20") and needs-new-data ("also break down by district", "join in customer region"). Measure:

| Metric | How | Target |
|---|---|---|
| **Predicate preservation** | diff string literals / WHERE clauses out of old vs new body; every one not named in the instruction must survive byte-identical | 100% — this is the correctness metric |
| **Unnecessary source dispatch** | did the turn dispatch a source tool when the body already contained the needed data | low; also the input to the D2 fast-path decision |
| Verification pass rate | `execute_script` ok within 3 attempts | ≥ 90% |
| Instruction satisfaction | manual review: did the change actually happen | ≥ 90% |

The first metric is mechanically checkable with no human in the loop and should be wired into CI as a regression guard once the feature lands.

**Telemetry to keep after launch:** edit-turn count, source-dispatch rate on edit turns, attempts-to-verify distribution, escalation-to-regeneration rate, and post-edit failure counters (did the corrected script start failing).
