# User Prompt Request — Full Flow

How one question travels from the frontend to a saved answer. Traced directly from
`sdk-nodejs` source (`handlers/user-prompt-request.ts`, `userResponse/agent-user-response.ts`,
`userResponse/scripts/script-matcher.ts`, `userResponse/agents/main-agent.ts`) — not a design
doc, a record of what the code actually does.

## Step 0 — Request setup (`handlers/user-prompt-request.ts`)

- Get-or-create the `Thread` for this `threadId` (`ThreadManager`, **in-memory only** — see
  the caveat at the bottom).
- Build `conversationHistory` — `thread.getConversationContext(MAX_CONVERSATION_CONTEXT_BLOCKS, ...)`.
  Up to 3 prior turns, each rendered as the user's question plus the assistant's
  `programAnswer` (the clean, final script-generated analysis text) if one exists,
  falling back to a cleaned raw stream buffer for older/non-scripted answers.
- Build `activeScriptBindings` — the `recipeId`+`params` behind recent answers in this
  thread (`thread.getScriptBindings`), falling back to a Postgres-persisted lookup if the
  thread was just recreated by a restart. This is what makes the ScriptMatcher's `edit`
  tier reachable.
- Register an early, empty `UIBlock` in the thread immediately — so an `ACTIONS_REQ` that
  arrives while the agent is still streaming doesn't 404.
- Register an `AbortController` keyed by `uiBlockId`, for the frontend's Stop button.
- Call `get_agent_user_response(...)`.

## Step 1 — Exact prompt match (`agent-user-response.ts`, `ConversationSearch.findExactMatch`)

A byte-for-byte identical previous prompt → return the cached answer straight from the DB.
**No LLM call.** Any non-identical prompt (even near-identical) falls straight through.

Exception: if the cached component's `script_dataset` queryId has expired, the bound
`recipeId` is recovered (`directReplay`) so Step 2 can re-run that exact recipe directly,
skipping the ScriptMatcher LLM call.

## Step 2 — ScriptMatcher (`scripts/script-matcher.ts`, one LLM call)

Given `activeBindings` + `conversationHistory` + an FTS-shortlisted catalog of other saved
scripts, returns one of:

- **`tier: 'high'`** — an unrelated-but-matching saved script fits as-is.
- **`tier: 'edit'`** — an instruction to modify the thread's own recent script. Double-gated:
  requires an active binding to target, AND the LLM's chosen target must actually be one of
  them (never redirected onto an unrelated catalog script). Splits into
  `editTarget: 'data'` vs `'display'`.
- **`tier: 'none'`** — nothing fits, generate fresh.

(`'near'` / fork-and-adapt is dead code — always coerced to `'none'`.)

**`tier: 'high'` does NOT go through MainAgent.** It's a separate branch in
`agent-user-response.ts`: `runScript()` on the matched recipe directly, then component
generation, done.

**A `display`-target edit also skips MainAgent** — it re-authors just `getComponents()` via
`authorComponentsProgram()`, staying in the same replay path (only the chart type changed,
not the data).

Only `tier: 'none'` and a **`data`**-target `edit` reach MainAgent.

## Step 3 — MainAgent (`agents/main-agent.ts`)

`new MainAgent(...)` → `mainAgent.handleQuestion()`. A tool-calling loop:

1. **Iteration 1 (forced):** `resolve_entities` — mentions/entityType → resolved ids +
   automatic `entityMap` join/formula text for every resolved type.
   **As of `be8652b` (sdk-nodejs `dev`, 0.0.47-dsp):** `resolve_entities` also takes a
   `concepts` argument and resolves both halves — named things and computed things — in
   this ONE pinned call. See "Concepts-in-resolve_entities" below.
2. Dispatch to **SourceAgent** per data source: `preResolveSchema()` (embedding search over
   columns — a HINT, not a lock) + the resolved-entities/concepts block appended to the
   intent. SourceAgent writes and runs the SQL, with its own `search_schema` fallback if the
   hint was wrong.
3. Back in MainAgent: **write_script → execute_script** (mandatory — every data answer must
   come from an executed script; SQL is copied verbatim from the proven SourceAgent query,
   only the row limit changes), 3-attempt cap.
4. **write_components**, then **write_analysis** — both authored as programs
   (`getComponents`/`getAnalysis`), re-run against `data`/`datasets`/`fmt` on every replay
   rather than hand-typed.

If `editContext` was set (data edit), MainAgent runs under the `agent-main-edit` system
prompt instead — minimal-diff discipline, skips straight to `write_script` unless it
genuinely needs to query something new.

## Step 4 — Save (`handlers/user-prompt-request.ts`)

On the success path, the `UIBlock` gets its component metadata, full text, `scriptBinding`
(`recipeId`+`params`, read back next turn as `activeBindings`), and `programAnswer` (the clean
analysis text — what `getConversationContext()` uses for the next turn).

Aborted and no-data answers are **not** skipped — both still get saved to Postgres, just tagged
with a distinct `status` (`'aborted'` / `'general'`) instead of getting the component-metadata/
scriptBinding/programAnswer enrichment above. The only case that actually skips the save is
`isExactMatch` (Step 1's cache replay, `responseMethod.includes('semantic-match') &&
semanticSimilarity >= 0.99`) — that answer was already saved on the turn it was first generated,
so replaying it doesn't write a second row.

---

## Concepts-in-resolve_entities (`be8652b`, sdk-nodejs `dev`, pulled 2026-08-27)

Fixes the gap this session spent a while diagnosing: `resolve_concepts` was reachable only
by prompt instruction while `resolve_entities` held the single forced-tool slot, so the
model routinely skipped it — confirmed live on a question containing the literal words
"revenue forecast": `resolve_concepts` was never called, the model used a shorter/incomplete
formula copy from the knowledge base instead, and the resulting query filtered a customer id
against a project column — zero rows, five queries in a row, no error.

What changed:

- `resolve_entities` now takes a `concepts` argument. Being the pinned call, it cannot be
  skipped — one call resolves both mentions→ids and computed-value definitions.
- **Server-side floor**, not just a forced call: pinning only guarantees the model *calls*
  `resolve_entities`, not that it fills in `concepts` with anything. So
  `resolveConceptsForTurn()` (MainAgent, private) independently scans the raw question text
  for catalog concept names/aliases (word-boundary match, longest label first — "revenue
  forecast" beats "revenue") and force-includes any it finds, even when the model asked for
  nothing.
- `entityMap` is no longer a separate requested field — comes back automatically for every
  type a mention resolved to.
- The old top-level `entityTypes` field on `resolve_entities` is gone. Scoping now happens
  per-mention (`mentions[].entityType`), and only when the question itself states what the
  value is — never a guess. A wrong guessed scope was silently hiding the correct record
  (the unscoped fallback only fires on zero hits, so a weak wrong-type match wins silently).
- `resolve_concepts` (still separately callable, for a concept discovered mid-turn) and the
  new merged path both now surface `corrected` (a fixed misspelling, e.g. `"revenu
  forcast"` → `"revenue forecast"`) and `suggestions`/`didYouMean` (when a name is too close
  to several catalog entries — e.g. `"project"` against `project name` / `project budget` /
  `project type` — nothing is silently bound; candidates come back instead, and the caller
  must pick and re-ask).

Verified end to end per the commit message: the question that previously produced zero rows
now carries the join, both invariants, the dedup, and the milestone override into the intent,
and reproduces the correct figure.

### Known gap: our backend doesn't implement the fuzzy-match half yet

Checked directly — `database/postgres/src/project-data-db/concepts.ts`'s `resolveConcepts()`
is **exact-match only** (name or alias, case-insensitive). A name that doesn't match exactly
falls straight into `unmatched`; there is no `corrected` or `suggestions`/`didYouMean` logic
anywhere in `ResolveConceptsResult` or the function body.

Confirmed this isn't something to pull in either — `origin/fusion-5` has no diff on this file
and no `corrected`/`suggestions`/`didYouMean`/fuzzy-matching code anywhere in its copy. This
half needs to be built, not pulled.

Practically: the concepts-in-`resolve_entities` merge and the server-side floor-scan both
work fine today (they only call our existing `concepts.catalog`/`concepts.resolve`
collections). What doesn't work yet is graceful handling of a misspelled or ambiguous concept
name — it still just lands in `unmatched`, same as before this SDK change, instead of getting
corrected or offered as a pick-one candidate list.

---

## Known caveat: `ThreadManager` is in-memory only

`ThreadManager` (`sdk-nodejs/src/threads/thread-manager.ts`) is a pure in-memory singleton —
`getThread(id)` is `this.threads.get(id)`, nothing else. No database read anywhere in it. A
backend restart loses every thread's `Thread`/`UIBlock` objects — including
`conversationHistory` and `activeScriptBindings` — even though `user_conversations` in
Postgres still has the full history. `activeScriptBindings` has a Postgres fallback for this
specific case (Step 0 above); `conversationHistory` does not. Logged in
`backend/docs/identified-bugs.csv` ("Thread state durability").
