# Request Context — carrying identity to the data seam

How a verified user identity reaches `BaseSource.prepareSql()`, so the SQL rewriter has a policy to
inject. Prerequisite for Phase 2 of `SQL-AUTHORIZATION-DESIGN.md`; useless on its own, and everything
in that document is unenforceable without it.

> **Status: built, and carrying nothing.** All six work items are implemented. Identity now travels
> from the relay to the data seam on every path. It restricts nothing yet — no policies are resolved,
> and two gaps remain before the identity itself is trustworthy. See
> [Status: plumbing, not enforcement](#status-plumbing-not-enforcement) before turning any switch on.

---

## Problem

*(The situation this was designed against. Kept because the reasoning is what a future port or
review needs, not the diff.)*

The rewriter was in place with its policy argument hardcoded empty:

```ts
// base-source.ts — BaseSource.prepareSql()
policies: [],        // Phase 2 — resolved from the verified user identity
```

Identity arrives in `sdk-nodejs/src/handlers/user-prompt-request.ts`. The seam is
`backend/src/sources/core/base-source.ts`. Between them sit the agents, the tool wrapper, and — for
one flow — an OS process boundary and an HTTP hop. Nothing connected the two.

The naive fix is to add a parameter. `execute()` is called directly from eight places with nothing
but `{sql, params}`:

```
sa.ts:209 (alert scheduler)        source-proxy.ts:264 (cross-machine DS_QUERY)
alert-metric-resolver.ts:247       report-alerts.ts:323
project-sources.ts:1864, 1905, 2092 (admin sampling)   base-source.ts:263 (tool.fn)
```

…plus ten `execute()` implementations to thread it through. That is invasive, and **a call site
someone forgets is a silent bypass** — the query runs with no policy and looks fine.

---

## Where the context actually survives

The decisive question is not "is `AsyncLocalStorage` nice", it is "which of our paths keep an
unbroken async chain from identity to `execute()`". Checked, not assumed:

| Path | Route to `execute()` | Chain intact? |
|---|---|---|
| Chat agents | SDK handler → MainAgent/SourceAgent → `tool.fn` → `execute()` | **yes** |
| Dashboard components | SDK `dashComp` handler → native in-process tools | **yes** |
| Report components | SDK `reportComp` handler → same | **yes** |
| **Script flow** | SDK handler → **child process** → **HTTP** → `script-bridge.ts:141` → `tool.fn` | **NO** |
| Scheduled alerts | backend cron → `sa.ts:209` | no user exists |
| Report alerts | backend cron → `report-alerts.ts:323` | no user exists |
| Cross-machine proxy | `DS_QUERY` over WS → `source-proxy.ts:264` | identity is on another machine |
| Admin sampling | `project-sources.ts` | an admin action, not a user query |

### The script flow breaks it twice

Scripts execute in a separate OS process (`script-runner.ts` → `executeInSubprocess`). That child
cannot reach in-process tools, so `script-bootstrap.ts:112` fetches
`${SCRIPT_BRIDGE_URL}/query` — a loopback `http.Server` in the backend (`script-bridge.ts:231`,
bound to `127.0.0.1`) which then calls `tool.fn`.

Two context-destroying boundaries, and the HTTP handler is a **fresh async chain** with no
relationship to the request that started the script. The only header sent is `content-type`
(`script-bootstrap.ts:114`); the bridge has no authentication and no notion of who is asking.

**So no single ambient mechanism covers every path.** A design that assumes one is wrong.

---

## Design

### The principal

```ts
type Principal =
  | { kind: 'user';   userId: string; orgId?: string; role?: string }
  | { kind: 'system'; reason: string };   // must name itself, e.g. 'alert-scheduler'

interface RequestContext {
  principal: Principal;
  projectId?: string;
  /** Resolved once per request, not per query. */
  policies?: SourcePolicy[];
}
```

**Absence is not `system`.** A missing context means we do not know who is asking, which is a
different thing from knowing it is a trusted job. Conflating them is how every call site anyone
forgets becomes an unpoliced one. `system` has to be written down, by name, at the call site.

### Three carriers, because there are three kinds of boundary

**1. `AsyncLocalStorage` — in-process paths.** Covers chat, dashboards, reports: the majority of
traffic and every agent-authored query. Established once where identity arrives, read inside
`prepareSql()`.

**2. An explicit context token — the script bridge.** Nothing ambient crosses a process boundary, so
this one has to be threaded by hand:

- the parent mints a short-lived opaque token bound to the current context before spawning
- it reaches the child by env var, alongside the `SCRIPT_BRIDGE_URL` it already gets
- `ctx.query` sends it as an `x-sa-context` header
- the bridge resolves token → context and runs `tool.fn` inside it

This also gives the bridge the authentication it currently lacks. It is loopback-only today, so this
is not an exposure fix; it is what makes the bridge able to answer "on whose behalf?".

**3. `runAsSystem(reason, fn)` — cron, admin, proxy.** An explicit wrapper at each non-user entry
point: seven call sites across four categories (two schedulers, the cross-machine proxy, three admin
browse/sample paths). Grep-able, and each names itself in the audit log.

### The singleton trap

`AsyncLocalStorage` only works if every participant shares **one instance of the module**. The
backend imports the SDK, sometimes from an absolute local path rather than `node_modules`, so two
copies can be loaded and each would get its own storage — with no error, just a context that is
always empty at the read site.

Pin it on `globalThis` behind a symbol so duplicate module instances resolve to the same storage:

```ts
const KEY = Symbol.for('superatom.requestContext.v1');   // as built
const g = globalThis as any;
export const store: AsyncLocalStorage<RequestContext> =
  g[KEY] ?? (g[KEY] = new AsyncLocalStorage<RequestContext>());
```

It lives in the SDK, because the backend already imports the SDK and not the reverse. The context
tokens (carrier 2) use a second pinned registry, `Symbol.for('superatom.contextTokens.v1')`, for the
same reason.

Both keys carry a version suffix: they are a cross-package contract, so a change to the stored shape
needs a new key rather than a silent reinterpretation of the old one.

### Reading it

```ts
// BaseSource.prepareSql()
const ctx = getRequestContext();
const policies = ctx?.policies ?? [];
```

with the enforcement rule below deciding what a missing `ctx` means.

---

## Fail-closed, but phased

Turning "no context → refuse" on everywhere at once breaks reports, alerts and admin sampling on day
one. Same discipline as the rewriter's shadow mode:

| `SA_SQL_REWRITE_MODE` | No context present | Context is `system` | Context is `user` |
|---|---|---|---|
| `off` / `shadow` (default) | log once per call site, run unpoliced | run unpoliced | policies logged, not applied |
| `enforce` | **refuse** | run unpoliced, audited by `reason` | apply policies |

The `shadow` phase is not a security posture, it is a **discovery tool**: the log names every path that
reaches a source without a context, which is the list of `runAsSystem()` wrappers still to write.
Flip to `enforce` when that log goes quiet.

The important property: with `enforce`, a call site nobody instrumented **breaks loudly** instead of
querying unfiltered. That is what makes an ambient mechanism acceptable here — the cost of a missed
path is a visible failure, not a silent leak.

---

## The cache that would bypass all of this

Found while mapping the script path, and it has to be fixed in the same change or the rest is
theatre.

`script-bridge.ts` caches query results for 10 minutes, keyed on `(toolId, sql, limit)`
(`queryCacheKey`). Two problems, both fatal once policies exist:

1. **No principal in the key.** Two users running the same script get the same cache entry.
2. **The key is computed on the PRE-rewrite SQL.** Policy injection happens later, inside
   `execute()`. So the key is identical for every user while the cached *rows* are whatever the first
   caller's policy allowed.

Net effect: user A runs a script, user B runs the same script within 10 minutes, and B is served A's
filtered rows. The rewriter never gets a chance to be wrong — it is simply not consulted.

**Fix:** mix a scope key into the cache key — a hash of the resolved policies (`[]` hashing to a
stable "unpoliced" value, so behaviour is unchanged until Phase 2 populates them). Not the raw
`userId`: two users with identical policies *should* share a cache entry, and keying on identity
throws that away for nothing.

The same question applies to `sdk-nodejs`'s `queryCache`, which returns stored rows with no
re-execution. Tracked in `SQL-AUTHORIZATION-DESIGN.md` under *Out of scope* → cache and reuse
scoping; this design does not close it.

---

## Alternative considered: explicit parameter threading

Add `ctx` to `execute(params, signal, ctx)` and pass it everywhere.

**For:** every call site is visible to the compiler; nothing is ambient; no singleton trap.

**Against:** eight call sites plus ten implementations plus `tool.fn`, and it still cannot cross the
script bridge — that path needs the token regardless. So the invasive option buys type-safety on the
paths that were already the easy ones, and leaves the hard boundary exactly as hard.

**Chosen:** ALS for in-process, token for the bridge, explicit wrappers for system paths, and
fail-closed so the ambient mechanism cannot fail silently. The type-safety argument is real, and
`SA_SQL_REWRITE_MODE=enforce` is what replaces it.

---

## Work items — all six built

| # | Item | Where |
|---|---|---|
| 1 | The ALS primitive | `sdk-nodejs/src/utils/request-context.ts` |
| 2 | Context established in the three handlers | `user-prompt-request.ts`, `dashComp/index.ts`, `reportComp/index.ts` (+ `handlers/request-identity.ts`) |
| 3 | Bridge token across the process boundary | `sdk-nodejs/src/utils/context-token.ts`, `script-runner.ts`, `script-bootstrap.ts`, `backend/src/services/script-bridge.ts` |
| 4 | `runAsSystem()` at the non-user entry points | 7 call sites, 4 reasons |
| 5 | Read at the seam + enforcement switch | `backend/src/sources/core/policy-gate.ts`, `base-source.ts` |
| 6 | Policy scope in the bridge cache key | `script-bridge.ts` |

Tests: `sdk-nodejs/test-request-context.ts` (32), `backend/sqlrewrite/_test-policy-gate.ts` (10),
`backend/sqlrewrite/_test-bridge-scope.ts` (7).

### Deviations from the design above

**The backend does not have its own copy of the context module.** It imports `getRequestContext` /
`runAsSystem` from `@superatomai/sdk-node`, like the twelve other backend files that already import
from the SDK. A duplicate was written first and removed: the argument for it — that an older
installed SDK would make the seam *silently* read `undefined` — was simply wrong. A typed import
against an SDK that lacks the export fails at `tsc`, loudly, at build time.

The `globalThis` pinning stays and still earns its place: it is what lets the source module and a
built bundle of the same module share one storage inside a single process, which is what the
`dist`-vs-`src` test exercises.

**Consequence for porting:** the backend now requires an SDK build exporting `getRequestContext`,
`runAsSystem` and `resolveContextToken`. A port to a client branch has to carry an SDK bump with it,
or that branch fails to compile. Noted at the top of `policy-gate.ts` too.

**Item 5 grew its own module.** The read is one line, but deciding what a *missing* context means is
not, so `policy-gate.ts` holds it: `resolvePolicies()` returns the policies for a user, empty for a
named `system` job, and either logs or refuses for an anonymous one depending on
`SA_SQL_REWRITE_MODE`. The non-enforcing log is keyed on the caller's first few in-repo stack frames,
so it enumerates *call paths* rather than sources — two paths into one source are two separate things
to instrument.

**Minting returns `undefined` outside a context** (item 3). An unidentified script run stays
unidentified rather than being handed a token that vouches for nothing.

**The cache scope hashes `JSON.stringify(policies)`**, so reordering the same policies fragments the
cache. Acceptable while a single resolver builds them; `_test-bridge-scope.ts` pins the behaviour and
says to sort before hashing if that ever changes.

---

## Status: plumbing, not enforcement

Everything above moves identity around. None of it restricts anything yet, for two independent
reasons:

1. **Policies are empty for everyone.** Nothing populates `ctx.policies`; that is the remaining half
   of Phase 2 in `SQL-AUTHORIZATION-DESIGN.md`.
2. **The identity is only as good as its source.** See below.

### What the relay now does, and what it still does not

The DO stamps `authContext` (`userId`/`orgId`/`role`) onto every relayed message, read from the
socket attachment, and only when the worker actually verified a session at handshake.
`request-identity.ts` prefers it and falls back to the client-supplied `payload.userId`, warning once
per process when it does.

Two gaps remain between this and a security boundary:

- **A client-supplied `authContext` is not stripped.** When the sender IS verified the DO overwrites
  it, so a forgery cannot survive that path — but an unverified sender's own `authContext` passes
  through untouched. This is deliberate and currently harmless: `payload.userId` is equally
  client-controlled and equally trusted, so nothing is worse than before. **It becomes a real hole
  the moment anything treats `authContext` as authoritative.** Delete the field unconditionally at
  the stamping site before enabling enforcement — the same discipline `index.ts` already applies to
  `INTERNAL_IDENTITY_HEADERS`.
- **`WS_AUTH_ENFORCE` gates whether any of it is present.** With it off, unverified browsers connect
  and no `authContext` is stamped, so every request falls back to the untrusted payload.

### Do not switch to `enforce` yet

Under `enforce`, any path reaching a source without a context is refused. Run `shadow` first and read the
`[policy-gate] anonymous query` lines — that log is the list of paths still needing instrumentation,
and it is the only way to find ones this design did not anticipate before they become outages.

---

## Findings from the implementation

Recorded because each was a wrong assumption caught by a test rather than by review.

**`EventEmitter` context propagation is the opposite of the folklore.** Context propagates through
async *resource creation*; `emit` is an ordinary synchronous call. So a listener runs in the
**emit-time** context, whatever it was registered inside — and a handler registered during a request
and fired later from another chain sees nothing at all. `bindContext()` is for the second case. Both
directions are pinned by tests.

**Zod strips undeclared fields rather than rejecting them.** `z.object()` accepted a message carrying
`authContext` and silently dropped it from `safeParse(...).data`. The handlers read the *raw*
message, so it worked by accident; declaring `MessageAuthContextSchema` on the three request schemas
makes it deliberate. A later "tidy-up" to read the parsed object would otherwise have removed
authorization with no error anywhere.

**Identity must be read from the socket attachment, never from the DO's `clients` map.**
`syncClientsFromWebSockets()` rebuilds that map after hibernation and keeps only `userAgent`/`origin`.
Identity read from it would be present on a fresh connection and missing after a hibernation cycle —
intermittent, load-dependent, and failing open.
