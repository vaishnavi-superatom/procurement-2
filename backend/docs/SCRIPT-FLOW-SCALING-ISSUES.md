# Script Flow — Scaling & Reliability Issues

> Audit of what **breaks or degrades as users ask more and more questions over time**
> (store grows, concurrency rises, cache churns, disk fills).
>
> Scope: the scripts flow in `sdk-nodejs/src/userResponse/scripts/` and its entry point
> `sdk-nodejs/src/userResponse/agent-user-response.ts`, plus the query cache in
> `sdk-nodejs/src/utils/query-cache.ts`.
>
> Status legend: 🔴 not started · 🟡 in progress · ✅ done
>
> Work through these top-to-bottom (roughly priority order). Check off as fixed.

---

## Flow recap (one turn)

`get_agent_user_response()` on every turn:
1. Exact-prompt cache check.
2. `new ScriptStore()` — reads the **whole** `scripts-store/` dir from disk.
3. `ScriptMatcher.match()` — sends the script catalog to an LLM to pick a script.
4. If matched (`tier:'high'`) → `runScript()` spawns a `tsx` subprocess.
5. Component generator turns the result into chart components.
6. MainAgent may author + save a new script (draft → promote to verified).

The problems cluster in four areas: **matcher cost**, **store I/O & disk growth**,
**subprocess management**, **query-cache expiry**.

---

## Priority order

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| 1 | 🔴 Critical | Matcher sends entire catalog to the LLM every turn (O(N) tokens) | ✅ |
| 2 | 🔴 Critical | No subprocess concurrency cap (self-inflicted fork-bomb) | ✅ |
| 3 | 🟠 High | Full synchronous store reload every turn (blocks event loop) | ✅ |
| 4 | 🟠 High | Orphaned grandchild processes on timeout | ✅ |
| 5 | 🟠 High | Unbounded disk growth + orphan draft files never cleaned | 🟡 |
| 6 | 🟠 High | `script_dataset` components can't self-heal after cache expiry | ✅ |
| 7 | 🟡 Medium | No write locking — torn writes, TOCTOU promote race, lost-update counters | ✅ |
| 8 | 🟡 Medium | Full `process.env` (secrets) inherited by arbitrary user scripts | 🔴 |
| 9 | 🟡 Medium | Unbounded IPC/result buffering | ✅ |
| 10 | 🟢 Low | 5-min timeout (docs claim 30s); child-side query hangs never reject | ✅ |
| 11 | 🟢 Low | Global flat store dir — no per-project namespacing | ✅ |
| 12 | 🟢 Low | Fuzzy `includes()` tool-id matching can resolve to the wrong source | 🔴 |

> **Postgres-FTS metadata store landed** (2026-06-04) — resolves #1, #3, #7, #11 and
> partially #5. Script metadata moved out of flat files into the `script_recipes`
> Postgres table with full-text search; the executable body stays on disk as an
> editable `scripts-store/<file_base>.ts`. See **"Resolution: Postgres-FTS metadata store"**
> at the bottom of this doc for the design and the files touched.
>
> **Runner hardening cluster landed** (2026-06-04) — resolves #2, #4, #9, #10 (all in
> `script-runner.ts` / `script-ipc.ts` / `script-bootstrap.ts`): concurrency cap +
> bounded queue, process-group kill on timeout, IPC byte ceiling, and a sane
> 60s timeout + child-side hang rejection. Together these give the guarantee
> *"at most N script processes alive, each time-bounded, none leaking, none ballooning memory."*

---

## 1. ✅ Matcher sends the entire catalog to the LLM every turn

> **RESOLVED (2026-06-04).** Matching is now Postgres full-text search:
> `ScriptMatcher.match()` calls `store.search(prompt)` → `searchScriptRecipes`
> (`websearch_to_tsquery` + weighted `ts_rank`, GIN-indexed) which returns a ranked
> top-K shortlist (default 20). The LLM catalog is O(K), not O(all scripts). The
> embedding pre-filter the original note suggested was deliberately **not** used —
> lexical FTS gives the recall we need and reuses an existing in-house pattern
> (`kb_nodes`). See the resolution section at the bottom.


**Where:** `script-matcher.ts:45,60,153` — `match()` → `store.getAll()` →
`buildScriptCatalog()` serializes **every healthy verified recipe** (id, name, full
`intentDescription`, every parameter) into **one LLM prompt**, called on **every turn
that has ≥1 script** (`agent-user-response.ts:348`).

**Why it breaks with volume:**
- O(N) input tokens, unbounded. Cost + latency grow linearly with the number of scripts.
- Eventually exceeds the context window → JSON parse fails → caught → `match()` returns
  `null` → **script reuse silently stops working**.
- Match accuracy degrades well before the hard limit (LLM picks from a bigger haystack).

**Author already flagged it:** `script-matcher.ts:15` says *"When script library grows
past ~50, add an embedding pre-filter (ChromaDB narrows to top 10 → LLM picks from those
10)."* **The pre-filter is not implemented** — verified: no embedding/ChromaDB/topK call
in the matcher, only the comment.

**Fix:** Add the documented embedding pre-filter. Embed each recipe's intent at save time,
store in ChromaDB; at match time embed the prompt, retrieve top ~10, send only those to the
LLM. Cap catalog size sent to the LLM regardless. **Highest impact — do first.**

---

## 2. ✅ No subprocess concurrency cap

> **RESOLVED (2026-06-04).** Added a counting `Semaphore` with a bounded wait
> queue in `script-runner.ts`. `runScript` does `acquire()` before spawn and
> `release()` in a `finally` (every path — success/failure/timeout/crash).
> `MAX_CONCURRENT_SCRIPTS` defaults to `min(8, cpus-1)` (env `SCRIPT_MAX_CONCURRENCY`);
> past `MAX_SCRIPT_QUEUE` (default 100, env `SCRIPT_MAX_QUEUE`) it sheds — returns a
> failure ScriptResult so the caller falls through to the agent flow (no subprocess)
> instead of piling up. Live subprocess count is now bounded regardless of traffic.


**Where:** `script-runner.ts:162` — `spawn(process.execPath, [tsxBin, bootstrap,
scriptPath], …)`. One full `node → tsx → bootstrap → user-script` process per execution,
spawned on demand. **No pool, no queue, no semaphore anywhere** (verified across runner and
call sites).

**Why it breaks with volume:**
- N concurrent matching questions ⇒ N concurrent Node processes (tens of MB RSS each +
  tsx transpile cost per spawn).
- Effectively a **self-inflicted fork-bomb gated only by inbound request rate** — under
  load this exhausts memory / PIDs / CPU.
- Authoring amplifies it: a single turn can spawn up to `MAX_SCRIPT_ATTEMPTS` children
  sequentially (`main-agent.ts:370-383`).

**Fix:** Add a global semaphore/queue around `executeInSubprocess` (e.g. max N concurrent,
queue the rest, shed or 503 past a hard ceiling). **Do early — this is what takes the box
down under real load.**

---

## 3. ✅ Full synchronous store reload every turn

> **RESOLVED (2026-06-04).** No more per-turn flat-file scan. `ScriptStore` reads
> metadata from Postgres (`count`/`search`/`getById`) and loads only the **one**
> matched body file from disk — never the whole store. The `loadAllFromDisk` /
> `ensureLoaded` / in-memory `recipes` Map are gone.


**Where:** `new ScriptStore()` is constructed **per turn** (`agent-user-response.ts:326`);
`loadAllFromDisk` (`script-store.ts:431-490`) does **2×N `readFileSync` + N `JSON.parse`
synchronously**, including each script's full `.ts` body (`script-store.ts:454`), and two
`readdirSync` passes (lines 440, 469) — **all before matching can start**.

**Why it breaks with volume:**
- Blocks the Node event loop. At 1000 scripts that's ~2000 sync disk reads + 1000 JSON
  parses **per turn, every turn** — no cache across turns (the instance is thrown away).

**Fix:** Cache the loaded store across turns in a module-level singleton; invalidate on
write (or mtime check). Load `.ts` bodies lazily — only for matched candidates, not the
whole store. Make reads async.

---

## 4. ✅ Orphaned grandchild processes on timeout

> **RESOLVED (2026-06-04).** The child is spawned with `detached: true` (POSIX) so
> it leads its own process group, and `cleanup()` SIGKILLs the **whole group** via
> `process.kill(-pid, 'SIGKILL')` (falls back to a direct kill on Windows / when the
> group is already gone). Since tsx 4.x re-execs node, the user script is a
> grandchild — the group kill now takes the whole tree, so a runaway script can't
> outlive the timeout as an orphan. (Host-shutdown cleanup is intentionally left to
> the host process; only the per-execution timeout path is handled here.)


**Where:** `script-runner.ts:188` — `cleanup()` does `child.kill('SIGKILL')` with **no
`detached` flag and no process-group kill**. The spawned process is the `tsx` wrapper; the
actual user script runs as a **grandchild**.

**Why it breaks with volume:**
- SIGKILL hits the tsx wrapper, but a runaway user script (grandchild) can survive →
  lingering orphan process on every timeout. These accumulate on a long-lived host.

**Fix:** `spawn(..., { detached: true })` and kill the whole process group with
`process.kill(-child.pid, 'SIGKILL')`. Also add a shutdown hook to reap in-flight children.

---

## 5. 🟡 Unbounded disk growth + orphan draft files

> **PARTIAL (2026-06-04).** Two of three parts done:
> 1. Drafts are now DB rows (`status='draft'`), not orphan metadata files.
> 2. **Failed drafts are deleted immediately** — MainAgent discards the draft (row
>    + body) at end-of-turn when it never verified (no `savedScript`). They're
>    never matched (`status='verified'` only), so nothing of value is lost, and we
>    avoid unbounded draft accumulation + squatted `file_base` slug slots. (Runs
>    once at end-of-turn, not per `execute_script` failure — intra-turn retries
>    reuse the same draft.) This replaces the old "keep for inspection" policy.
>
> Still **open**: no eviction cap on the number of **verified** recipes. Planned to
> be handled by a future **consolidation step** (merge near-duplicate scripts into
> one), which also tightens the match candidate set. A simple age/usage retention
> sweep on `script_recipes` is the fallback if consolidation slips.


**Where:** `script-store.ts`.
- **No cap, no eviction, no TTL** on the number of recipes — grows monotonically forever.
- **Failed drafts are intentionally never deleted** (`script-store.ts:337-339`): every
  failed authoring attempt leaves orphan `slug-<turnId>.{ts,json}` files permanently.
- Those dead drafts are **still read + parsed on every load** even though they're filtered
  out of matching — permanent inflation of per-turn load cost (compounds #3).

**Fix:** Cap recipe count (LRU/age-based eviction keyed on `lastUsed` + success/failure
counts). GC failed drafts after a retention window (e.g. 24h) or on a sweep. Skip loading
draft bodies during the match path.

---

## 6. ✅ `script_dataset` components can't self-heal after cache expiry

> **RESOLVED (2026-06-04) — regenerate, don't persist.** A `script_dataset`
> queryId now encodes a regeneration descriptor `{ kind, recipeId, params,
> datasetRef }` (in the encrypted token) instead of a non-executable placeholder
> SQL. On a cache miss, the backend `executeByQueryId` re-runs the saved recipe
> (durable in Postgres + on disk, bounded by the #2 concurrency cap), picks the
> matching dataset, refreshes the cache under the same token, and returns FRESH
> data — making computed datasets self-heal exactly like SQL components already
> do. Persisting computed rows was deliberately rejected: the source data changes,
> so stored computed data would be stale. If the recipe was deleted or the source
> is unreachable, the user gets an honest "couldn't refresh" message, never stale
> numbers. Tokens minted before this shipped (placeholder SQL) still fall through
> to the old sentinel. Files: `agent-user-response.ts` (`storeScriptDatasetQuery`),
> `backend/src/collections/external-tools.ts` (`regenerateScriptDataset`),
> `backend/src/collections/script-recipes.ts` (`scriptRecipeStore` adapter), plus
> new SDK root exports of `ScriptStore`/`runScript`. See project memory
> `project_script_dataset_expiry_fix`. **Requires the SDK rebuild to take effect.**


**Where:** `query-cache.ts:26-27` (5000-entry LRU, 10-min TTL),
`agent-user-response.ts:62-141` (`hasExpiredScriptDataset`, `rehydrateCachedComponent`),
`backend/src/tools/index.ts:19-21` (the "expired" sentinel).

**Why it breaks with volume:**
- Post-JS computed (`script_dataset`) component data lives **only** in the 10-min data
  cache — the SQL is a non-executable placeholder, so these are deliberately excluded from
  `_queryMap`, and `rehydrateCachedComponent` (which only re-registers real SQL) can't
  restore them.
- After 10 min idle **or** LRU eviction, the component renders **"Script dataset expired.
  Re-ask the question."**
- As questions accumulate, more datasets compete for 5000 slots → older dashboards' script
  components evict sooner. The only recovery (`hasExpiredScriptDataset` re-running the whole
  script) fires **only on the exact-prompt replay path** — a filter interaction or
  non-exact follow-up on a still-open dashboard just shows the error.
- Cache cap is on **count, not bytes** — 5000 large result-sets can still be hundreds of MB
  resident.

**Fix:** Persist the computed dataset alongside the recipe (or in durable storage keyed by
queryId) so it's re-derivable without a full re-run; or extend `_queryMap`/rehydration to
cover script datasets. Consider a byte budget for the cache, not just an entry count.

---

## 7. ✅ No write locking — torn writes, TOCTOU, lost updates

> **RESOLVED (2026-06-04).** Metadata mutations are now atomic Postgres ops:
> counters use `UPDATE … success_count = success_count + 1` (no lost updates),
> promotion is a single `UPDATE … status='verified'` (no TOCTOU file-rename race),
> and `file_base` is unique per project. Body writes are atomic temp-file + `rename`.
> The two-file non-atomic write and the `turnId` filename-collision hack are gone.


**Where:** `script-store.ts`.
- **Non-atomic two-file writes** (`script-store.ts:514-515`): metadata and body written in
  separate `writeFileSync` calls, no temp-file-then-rename → readers can observe partial
  content; a half-written body is not detected on load.
- **TOCTOU slug race in `promoteToVerified`** (lines 286-320): two turns promoting drafts
  with the same slug can both see the canonical name free → last writer overwrites the
  other's verified body.
- **Lost-update counters** (`recordSuccess`/`recordFailure`, lines 366-387): read-modify-
  write on a per-turn snapshot; a concurrent turn's increment is clobbered.
- **No file locking anywhere** — no flock, no lockfile, no write queue.

**Fix:** Atomic writes (write temp + `rename`). Single-writer queue or lockfile per store.
Make counter updates a read-merge-write under the lock, or move counters to an append log.

---

## 8. 🟡 Full `process.env` inherited by arbitrary user scripts

**Where:** `script-runner.ts:167-171` — child spawned with `env: { ...process.env }`.
Scripts are arbitrary code (tsx `import` of a user `.ts`), so all host secrets are visible.

**Note:** The `ctx.query` allowlist (`resolveAuthorizedTool`, `script-runner.ts:408-431`)
guards the **IPC path** but is **not a security boundary** — a script can `import('pg')` /
`fetch()` / read files directly with the inherited credentials.

**Fix:** Pass a curated env allowlist to the child instead of the full `process.env`.
Longer term, consider a real sandbox (vm/isolate, seccomp, network namespace) — but at
minimum stop handing every secret to author-generated code.

---

## 9. ✅ Unbounded IPC / result buffering

> **RESOLVED (2026-06-04).** `LineSplitter` now takes a byte ceiling (default 64 MB,
> env `SCRIPT_MAX_IPC_BYTES`) and throws `LineOverflowError` when a partial line
> grows past it without a newline. The parent's stdout handler aborts + SIGKILLs the
> group on overflow; the child's stdin handler rejects pending queries, reports
> ERROR, and exits. This bounds both the giant-single-line case and total message
> size — a runaway/pathologically-large result can't balloon parent memory. (A
> hard row-count cap was deliberately *not* added, to avoid silently truncating
> legitimate results; the byte ceiling covers the OOM hazard.) stderr was already
> bounded (10 KB tail-trim).


**Where:** `script-ipc.ts` (`LineSplitter.buffer`) and `script-bootstrap.ts` /
`script-runner.ts` result handling.
- `LineSplitter.buffer` grows until a newline — a giant single-line JSON result (or a
  malformed flood with no `\n`) has no ceiling.
- Full result rows are buffered child → pipe → parent with **no row cap at this layer**
  (`executedQueries` holds entire `data` arrays on both sides).
- stderr **is** bounded (10 KB tail-trim, `script-runner.ts:229-231`) — good, keep.

**Fix:** Add a max-line / max-message byte guard in `LineSplitter` (kill the child if
exceeded). Cap rows returned through IPC; stream or paginate large datasets instead of one
giant message.

---

## 10. ✅ Timeout value + child-side hangs

> **RESOLVED (2026-06-04).** `SCRIPT_TIMEOUT_MS` default dropped from 5 min to **60s**
> (env `SCRIPT_TIMEOUT_MS`, still per-call via `RunScriptOptions.timeoutMs`) so slots
> free up quickly — which is what makes the #2 cap usable. Child-side: the `stdin
> 'end'`/`'error'` handlers now call `rejectAllPending()`, so an in-flight `ctx.query`
> whose reply can't arrive fails fast instead of hanging until the wall-clock kill.
> (A separate per-query child timer was unnecessary — the parent wall-clock already
> bounds total runtime and runs each tool's `fn`.)


**Where:** `script-runner.ts:25` — `SCRIPT_TIMEOUT_MS = 300_000` (5 min), despite doc
comments claiming "30s." No call site overrides it. Child-side (`script-bootstrap.ts`)
`ctx.query` awaits with **no internal timeout** — a reply that never arrives leaves the
pending promise unresolved until the 5-min parent kill.

**Fix:** Set a realistic timeout (verify intended value — 30s?). Add a child-side per-query
timeout and reject pending promises on stdin `end`.

---

## 11. ✅ Global flat store dir — no per-project namespacing

> **RESOLVED (2026-06-04).** `script_recipes` has a `project_id` column; all
> queries (`search`/`count`/`getById`/`fileBaseTaken`) are project-scoped, and
> `file_base` is unique per `(project_id, file_base)`. `ScriptStore` stamps
> `projectId` on every row.

---

## 12. 🟢 Fuzzy tool-id matching can resolve to the wrong source

**Where:** `script-runner.ts:420-428` — `resolveAuthorizedTool` uses `includes()`
substring matching, so a script's `toolId` can resolve to the **wrong** tool when source
IDs share substrings (correctness + authorization-precision hazard).

**Fix:** Exact-match the tool id; only fall back to fuzzy with an unambiguous single
candidate, else reject.

---

## Quick reference — key files

- `sdk-nodejs/src/userResponse/agent-user-response.ts` — entry point, per-turn orchestration
- `sdk-nodejs/src/userResponse/scripts/script-matcher.ts` — #1
- `sdk-nodejs/src/userResponse/scripts/script-runner.ts` — #2, #4, #8, #9, #10, #12
- `sdk-nodejs/src/userResponse/scripts/script-store.ts` — #3, #5, #7, #11
- `sdk-nodejs/src/userResponse/scripts/script-ipc.ts` — #9
- `sdk-nodejs/src/userResponse/scripts/script-bootstrap.ts` — #9, #10
- `sdk-nodejs/src/userResponse/scripts/script-component-generator.ts` — #6
- `sdk-nodejs/src/utils/query-cache.ts` — #6
- `backend/src/tools/index.ts` — #6 (expired sentinel)

---

## Resolution: Postgres-FTS metadata store (2026-06-04)

Resolves **#1, #3, #7, #11**; partially **#5**.

**Design.** Script *metadata* moved out of flat files into a Postgres table
(`script_recipes`) with full-text search. The executable *body* stays on disk as an
editable `scripts-store/<file_base>.ts` (slug-named, IDE-editable); a `body_hash`
(sha256) detects manual edits. Matching is lexical FTS (no embeddings): the matcher
gets a ranked top-K shortlist and the LLM still makes the final `high`/`near`/`none`
pick + parameter extraction.

**Injection.** The SDK is DB-free, so the backend exposes the store the same way as
every other collection — `sdk.addCollection('script-recipes', op, handler)` — and the
SDK consumes `collections['script-recipes'][op](params)` (mirrors
`collections['conversation-history']['exactMatch']`). When the collection isn't wired,
`ScriptStore` degrades to a safe no-op (script reuse disabled, no crash).

**Files.**
- `database/postgres/drizzle/schema.ts` — `scriptRecipes` table (FTS GIN indexes, tags
  array, `project_id`, `file_base`, `body_hash`, `status`, unique `(project_id, file_base)`).
- `database/postgres/src/project-data-db/script-recipes.ts` — `searchScriptRecipes`
  (`websearch_to_tsquery` + weighted `ts_rank` + SQL health filter + popularity safety-net),
  `getScriptRecipe`, `countScriptRecipes`, `upsertScriptRecipe`, atomic
  `updateScriptRecipeStats` / `promoteScriptRecipe` / `recordScriptDraftError`,
  `deleteScriptRecipe`, `fileBaseTaken`.
- `backend/src/collections/script-recipes.ts` + `collections/index.ts` — registrar wiring
  Postgres → `collections['script-recipes']`.
- `sdk-nodejs/.../scripts/script-metadata-store.ts` — injected `ScriptRecipeStore`
  interface + `resolveScriptRecipeStore`.
- `sdk-nodejs/.../scripts/script-store.ts` — rewritten: async, metadata via the injected
  store, body on disk with atomic temp+rename writes. (Removed `loadAllFromDisk`,
  `ensureLoaded`, the in-memory `recipes` Map, and the `turnId` filename hacks.)
- `sdk-nodejs/.../scripts/script-matcher.ts` — `getAll()` → `await store.search(prompt)`.
- `sdk-nodejs/.../scripts/types.ts` — `ScriptRecipe` gained `fileBase`/`bodyHash`/`projectId`.
- `agent-user-response.ts` + `agents/main-agent.ts` — `new ScriptStore({ collections, projectId })`
  + awaits threaded through the (now async) store calls.

**Activation.** `cd database/postgres && pnpm db:generate && pnpm db:migrate`, then rebuild
SDK + backend. Tuning knobs (search limit, failure-rate threshold, safety-net size) are at
the top of `script-recipes.ts`.

**Still open after this change:** #5 needs a retention/LRU eviction sweep on the table;
a one-time importer is required only if a *deployed* env already has on-disk
`scripts-store/metadata/*.json` recipes (none locally).
