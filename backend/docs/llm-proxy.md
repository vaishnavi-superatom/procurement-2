# LLM Proxy (Cloudflare Worker in front of all LLM providers)

> **Status:** Design approved — implementation in progress.
> Track per-component status in the [Status](#status) table at the bottom.
> **Repos touched:** `llm-proxy` (new Cloudflare Worker, to build), `sdk-nodejs` (`src/llm.ts`).
> The **backend** needs **no logic change** — it only sets env vars per deployment.
> **Scope:** all providers, not just Anthropic — see [§3](#3-scope-all-providers).

---

## 1. The problem in one sentence

Anthropic banned our org because one API key is hit from client VMs all over the world (looks
like a leaked/resold key) — so we route **every** LLM call, for **every** provider, through one
Cloudflare Worker that holds the real keys, meters usage per client, and can cut a client off.

### Why it matters

We deploy this product per-client, into our AWS VMs **and** client-owned VMs anywhere on
earth. Today every provider's real key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`GROQ_API_KEY`, `OPENROUTER_API_KEY`) lives on every box, so each provider sees a single key
authenticating from dozens of countries — the pattern that got Anthropic to ban us, and which
any other provider could ban us for next.

After this change:

- Every real key lives in **exactly one place** — the Worker secret store.
- Client VMs hold only a **per-client proxy key**, useless outside our proxy.
- All provider traffic egresses from **Cloudflare's IP range**, not scattered VM IPs.
- Each client authenticates to the proxy with its own key, so we get **per-client metering
  across all providers** (total spend, not just Claude), cost attribution, and an instant
  **kill switch**.

> ⚠️ **The proxy does not lift the existing Anthropic ban.** That's on the org/account. We
> still need to (a) appeal to Anthropic explaining this architecture, and (b) stand up the new
> account *behind* the proxy from day one. See [§10 Operational notes](#10-operational-notes).
> Anthropic is **not urgent** in the meantime because the SDK falls back to OpenRouter when no
> Anthropic key is set (existing behaviour in `_parseModel`).

---

## 2. Vocabulary (read this first)

| Term | Meaning |
|------|---------|
| **Proxy key** | A per-client credential (e.g. `sk-prox-<clientid>-<random>`) shipped to one client deployment. The **same** proxy key is used for **all** providers — the Worker routes by URL path, not by key. **Not** a real provider key. |
| **Real key** | An actual provider key (`sk-ant-…`, `sk-…`, Gemini key, Groq key). Lives **only** as a Worker secret, one per provider. Never on a client VM. |
| **Worker** | The Cloudflare Worker. Authenticates the proxy key, routes by `/<provider>/…` path to the right upstream, swaps in that provider's real key, forwards (incl. SSE), meters, and enforces the kill switch. |
| **Provider** | One of `anthropic`, `openai`, `groq`, `gemini`, `openrouter`. Each maps to one upstream host + one real key in the Worker. |
| **Client** | One product deployment for one customer (e.g. `jsw`, `bluelinx`). One proxy key, one budget, one enabled/disabled flag — spanning all providers. |
| **KV** | Cloudflare KV. Holds proxy-key → client record (enabled flag, running spend). Read on **every** request. |
| **D1** | Cloudflare's SQLite. Append-only per-request usage ledger (client, provider, model, tokens, cost). |
| **Fail-open** | If the proxy is unreachable/refusing, the SDK retries through **OpenRouter** so a proxy incident doesn't take a client down. Applies to the Anthropic family (OpenRouter substitutes for Claude). |

---

## 3. Scope: all providers

`llm.ts` supports five providers across **four client SDKs**. We proxy all of them. They group
by SDK because the proxying mechanism (how you override the base URL) is per-SDK:

| Family | Providers | Client SDK | Key env var(s) | Base-URL override |
|--------|-----------|------------|----------------|-------------------|
| **Anthropic** | `anthropic` | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` | `new Anthropic({ baseURL })` |
| **OpenAI** | `openai`, **`openrouter`** | `openai` | `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | `new OpenAI({ baseURL })` — **already wired** (`options.baseURL`) |
| **Groq** | `groq` | `groq-sdk` | `GROQ_API_KEY` | `new Groq({ baseURL })` |
| **Gemini** | `gemini` | `@google/generative-ai` | `GEMINI_API_KEY` | `getGenerativeModel(model, { baseUrl })` (request option, not constructor) |

Notes:
- **OpenRouter shares the OpenAI SDK.** `_openrouterOptions` sets `options.baseURL` to
  OpenRouter's URL, so OpenRouter requests already carry an explicit base URL — our proxy
  injection must **not** clobber it (an explicit `options.baseURL` always wins). OpenRouter is
  also our fail-open path, so it can keep going direct initially and be brought behind the
  proxy later.
- **Gemini is the odd one** — the Google SDK takes the base URL as a *request option* on
  `getGenerativeModel`, not on the constructor. There are 3 `getGenerativeModel` call sites in
  `_geminiText` / `_geminiStream` / `_geminiStreamWithTools`.

---

## 4. Architecture

```
 backend (per client)               sdk-nodejs / llm.ts            Cloudflare Worker                 upstreams
 ─────────────────────              ───────────────────            ─────────────────                 ─────────
 env (all the SAME proxy key):      new Anthropic({ baseURL })  ┐  /anthropic/* ─ real ANTHROPIC key ─► api.anthropic.com
   ANTHROPIC_API_KEY  = <proxy>     new OpenAI({ baseURL })     │  /openai/*    ─ real OPENAI key    ─► api.openai.com
   OPENAI_API_KEY     = <proxy>     new Groq({ baseURL })       ├► /groq/*      ─ real GROQ key      ─► api.groq.com
   GEMINI_API_KEY     = <proxy>     getGenerativeModel({baseUrl})│ /gemini/*    ─ real GEMINI key    ─► generativelanguage…
   GROQ_API_KEY       = <proxy>                                 ┘  (per request, every family):
   SUPERATOM_LLM_PROXY_URL=<worker>                                1. authn proxy key  ──► KV
   OPENROUTER_API_KEY = <fallback>          ▲                      2. enabled? budget ok?
                                            │ on proxy failure     3. swap in REAL key for that provider
                                            └ fail-open ─────────► 4. forward + stream back
                                              OpenRouter           5. meter ──► D1 ledger + KV running spend
```

Three moving parts, deployed independently:

1. **SDK (`src/llm.ts`)** — the only code change. Each family's client gets a `baseURL`
   pointing at `${SUPERATOM_LLM_PROXY_URL}/<provider>`, gated on the env var (inert when unset).
   Plus fail-open to OpenRouter on the Anthropic family.
2. **Backend** — sets env vars per deployment. No logic change.
3. **Worker (`llm-proxy`)** — separate repo/deploy. Holds the real keys, routes, meters, kills.

---

## 5. The SDK change (`sdk-nodejs/src/llm.ts`)

`llm.ts` is the single chokepoint for every LLM call across the SDK, so the change is contained
to it. The pattern is the same per family: resolve `baseURL` from env, pass it to the client.

### 5.1 Shared base-URL helper

```ts
/**
 * Per-provider proxy base URL. Returns `${SUPERATOM_LLM_PROXY_URL}/<provider>`
 * when the proxy is configured, else undefined (→ talk to the provider directly).
 * An explicit options.baseURL (e.g. OpenRouter) always wins and is never overridden.
 */
private static _proxyBaseURL(provider: string, options: LLMOptions): string | undefined {
    if (options.baseURL) return options.baseURL;            // OpenRouter etc. — leave alone
    const root = process.env.SUPERATOM_LLM_PROXY_URL;
    return root ? `${root.replace(/\/$/, '')}/${provider}` : undefined;
}
```

### 5.2 Per-family injection

| Family | Construction today | After |
|--------|--------------------|-------|
| Anthropic (3 sites) | `new Anthropic({ apiKey })` | `new Anthropic({ apiKey, baseURL: this._proxyBaseURL('anthropic', options) })` (via an `_anthropicClient` helper) |
| OpenAI (3 sites) | `new OpenAI({ apiKey, baseURL: options.baseURL })` | `new OpenAI({ apiKey, baseURL: this._proxyBaseURL('openai', options) })` — keeps OpenRouter behaviour (explicit `options.baseURL` wins) |
| Groq (2 sites) | `new Groq({ apiKey })` | `new Groq({ apiKey, baseURL: this._proxyBaseURL('groq', options) })` |
| Gemini (3 sites) | `genAI.getGenerativeModel({ model, … })` | add `{ baseUrl }` request option: `getGenerativeModel({ model, … }, { baseUrl })` where `baseUrl = this._proxyBaseURL('gemini', options)` |

The Anthropic family additionally goes through `_anthropicClient(options)` so the base-URL +
fail-open logic lives in one place. `LLMOptions.baseURL` already exists.

### 5.3 Fail-open to OpenRouter (Anthropic family)

If a proxy/Anthropic call throws (Worker down, `403` disabled, `429` over budget), the SDK
retries the same prompt through OpenRouter (`OPENROUTER_API_KEY`), remapping the model via the
existing `_toOpenRouterSlug`. Safety rules so we never double-emit or replay side effects:

| Method | Fail-open when |
|--------|----------------|
| `_anthropicText` | Any error — nothing emitted yet. **Safe.** |
| `_anthropicStream` | Error **before** the first `options.partial` chunk. After → rethrow. |
| `_anthropicStreamWithTools` | Error on the **first** request, before any text streamed or any tool ran. After a tool ran → rethrow (replaying could re-run `write_script` / re-execute queries). |

Fail-open for the OpenAI/Groq/Gemini families is **out of scope** for now — OpenRouter is a
Claude substitute, not a drop-in for those, and those providers aren't banned. A proxy outage
on those paths surfaces as an error (acceptable; revisit if needed).

This runtime retry is distinct from the existing **parse-time** OpenRouter fallback in
`_parseModel` (routes to OpenRouter when **no** `ANTHROPIC_API_KEY` is set at all). Both coexist.

---

## 6. The Worker (`llm-proxy`)

### 6.1 Request flow (same for every provider)

1. **Route** — match `/<provider>/<rest…>`; `provider` ∈ {anthropic, openai, groq, gemini,
   openrouter}. Unknown provider → `404`.
2. **Authenticate** — extract the proxy key from where that protocol carries it (see 6.2),
   look it up in KV. Unknown → `401`.
3. **Authorize** — KV record carries `enabled` + `spentCents`/`budgetCents`. `!enabled` →
   `403`; over budget → `429`. (Kill switch + credit cap, across all providers.)
4. **Forward** — rewrite to `https://<upstream-host>/<rest…>` (path preserved verbatim after
   the prefix), replacing the inbound auth with that provider's **real key**, streaming the
   response back unchanged.
5. **Meter** — parse usage, write a D1 row, bump the KV running total (`ctx.waitUntil`, off the
   hot path).

**Transparent path forwarding** (preserve everything after `/<provider>`) means the Worker
doesn't need to know each SDK's exact route layout — it just swaps host + key.

### 6.2 Per-protocol auth extraction + usage parsing

The auth location and the usage shape differ per family — this is the per-provider work:

| Provider | Proxy key arrives in | Real key injected as | Usage parsed from |
|----------|----------------------|----------------------|-------------------|
| anthropic | `x-api-key` header | `x-api-key` | SSE: `message_start` (input/cache), `message_delta` (output, **cumulative — take last**) |
| openai / openrouter | `Authorization: Bearer` | `Authorization: Bearer` | SSE final `usage` chunk — **requires `stream_options.include_usage=true`** on the request (inject it if absent), else estimate |
| groq | `Authorization: Bearer` | `Authorization: Bearer` | same as OpenAI (`x_groq.usage` / `usage`) |
| gemini | `?key=` query param | `?key=` | non-stream: `usageMetadata`; stream: last chunk's `usageMetadata` |

### 6.3 Storage split — KV (hot path) + D1 (ledger)

| Store | Holds | Why |
|-------|-------|-----|
| **KV** | proxy-key → `{ clientId, enabled, budgetCents, spentCents }` | Read on **every** request — edge-fast. Hot path + kill switch. |
| **D1** | one row per request: `clientId, provider, ts, model, in_tok, out_tok, cache_tok, cents` | Append-only ledger; reporting + reconciliation. |

### 6.4 Admin surface

Separate endpoint (own secret, **not** a proxy key): create/rotate proxy keys, flip `enabled`
(kill switch), set `budgetCents`, read per-client spend (or query D1).

---

## 7. Configuration

### Per client deployment (backend env)

| Var | Value | Notes |
|-----|-------|-------|
| `ANTHROPIC_API_KEY` | the client's **proxy key** | All four `*_API_KEY` vars carry the **same** proxy key. |
| `OPENAI_API_KEY` | same proxy key | |
| `GEMINI_API_KEY` | same proxy key | |
| `GROQ_API_KEY` | same proxy key | |
| `SUPERATOM_LLM_PROXY_URL` | the Worker base URL | Unset → SDK talks to providers directly (legacy). SDK appends `/<provider>`. |
| `OPENROUTER_API_KEY` | real OpenRouter key | Fail-open path; stays direct initially. |

### Worker (secrets / bindings)

| Name | Type | Value |
|------|------|-------|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` | secrets | the **real** per-provider keys |
| `ADMIN_SECRET` | secret | gates the admin endpoint |
| `CLIENTS` | KV namespace | proxy-key → client record |
| `DB` | D1 database | usage ledger |

---

## 8. Security

- **Real keys isolated** — every real key exists only as a Worker secret; never returned to a
  client, never on a client VM.
- **Proxy keys per-client, revocable** — leaking one exposes only that client's quota (across
  all providers); disable it in KV instantly.
- **Admin endpoint** uses a distinct secret from proxy keys.
- **No new public attack surface** beyond the Worker URL, which only accepts valid proxy keys.

---

## 9. Testing & rollout

1. Deploy the Worker; create a test client (proxy key, generous budget, `enabled: true`).
2. Point a **dev** backend at it. For each family in use, run text / stream / tool-calling and
   confirm responses are identical and D1 logs a row per request with correct provider + tokens.
3. **Kill-switch test** — flip `enabled: false`; next call `403`s; Anthropic family fails open
   to OpenRouter (if configured), others error cleanly.
4. **Budget test** — tiny `budgetCents`; confirm `429` after exceeded (any provider).
5. **Reconcile** — compare D1 per-provider totals against each provider's dashboard; fix the
   usage parser if they diverge (esp. OpenAI streaming `include_usage`).
6. Roll out per client by setting env vars; remove real keys from each VM as it migrates.

**Rollout order (not urgent, but suggested):** Anthropic + OpenAI family (covers OpenRouter)
first → Groq → Gemini. Each is independent — a family is "live" once its parser + env var are in.

### Rollback

Unset `SUPERATOM_LLM_PROXY_URL` → all families talk to providers directly again (real keys must
be back on the box). The SDK change is inert with the var unset.

---

## 10. Operational notes

- **Single point of failure** — every client depends on the Worker. Fail-open to OpenRouter
  mitigates the Anthropic path; keep an OpenRouter key everywhere.
- **Shared rate limits** — all clients draw on one org's limit per provider. Per-client rate
  limiting in the Worker (KV counter / Durable Object) is a follow-up.
- **The Anthropic ban** — appeal describing this architecture; confirm the use case fits the
  commercial terms (serving our own product to clients is fine; not reselling raw API access).
- **Cost formula** — keep the Worker's per-model pricing + cache math in sync with
  `sdk-nodejs/src/utils/llm-usage-logger.ts` (which already parses usage the same way).
  **OpenRouter is exact**: the Worker injects `usage:{include:true}` and reads the returned
  `usage.cost` (USD), so OpenRouter `cost_cents` matches the OpenRouter bill; the pricing table
  is only a fallback (anthropic/openai/groq/gemini, or OpenRouter when no cost is returned).
- **OpenAI streaming usage** — the OpenAI/Groq/OpenRouter SSE `usage` chunk only appears when
  `stream_options.include_usage=true`; the Worker injects it into streaming requests for those
  providers (`proxy.ts → injectIncludeUsage`, which buffers the JSON body to add the flag), so
  streamed calls are metered. Anthropic/Gemini stay stream-passthrough.
- **Cache tokens** (Anthropic) — `cache_read_input_tokens` (~0.1×) and
  `cache_creation_input_tokens` (~1.25×) bill differently from plain input; fold into cost.

---

## 11. Alternatives considered

| Option | Verdict |
|--------|---------|
| **Anthropic-only proxy** | Solves the ban but leaves the other providers' keys distributed and unmetered — incomplete for the credits/kill-switch goal. **Rejected: do all providers.** |
| **Env-var only** (`ANTHROPIC_BASE_URL`, no code change) | Works for Anthropic but implicit, and doesn't generalize to the Gemini request-option override. Rejected. |
| **LiteLLM / Cloudflare AI Gateway** (off-the-shelf) | Per-key spend + disable out of the box, multi-provider. **Rejected: we want full control over the proxy.** |
| **Lean on OpenRouter as the only route** | No per-client metering or kill switch, OpenRouter pricing. Kept only as the fail-open fallback. |

---

## Status

| Component | Status |
|-----------|--------|
| Design doc (all providers) | ✅ this doc |
| SDK: `_proxyBaseURL` helper | ✅ done (`tsc` clean) |
| SDK: Anthropic baseURL + fail-open | ✅ done — `_anthropicClient` + fail-open in text/stream/streamWithTools |
| SDK: OpenAI/OpenRouter baseURL | ✅ done — `_proxyBaseURL('openai')` at 3 `new OpenAI` sites; OpenRouter base URL preserved |
| SDK: Groq baseURL | ✅ done — `_proxyBaseURL('groq')` at 2 `new Groq` sites |
| SDK: Gemini baseUrl request-option | ✅ done — `_geminiRequestOptions` as 2nd arg at 5 `getGenerativeModel` sites |
| Worker: routing + per-provider real-key swap | ✅ code done (`~/superatom/llm-proxy`, `tsc` clean) — not yet deployed |
| Worker: per-family usage metering → D1 | ✅ code done — tee + SSE/JSON parsers per family; OpenAI/Groq/OpenRouter stream usage via `include_usage`; OpenRouter records **exact** cost via `usage:{include:true}` → `usage.cost`, else pricing-table estimate |
| Worker: KV client records + kill switch + budget | ✅ code done — hashed proxy keys, enabled/budget gate |
| Worker: admin endpoint (key/enable/budget) | ✅ code done — create/list/get/enable/disable/budget/reset-spend/rotate |
| Worker: admin UI (`GET /admin`) | ✅ code done — self-contained page (`src/ui.ts`) calling the admin API; secret in sessionStorage. Harden with Cloudflare Access in prod. |
| Worker: deploy (KV+D1+secrets create, `wrangler deploy`) | ✅ deployed — custom domain `https://ai.superatom.ai` (health 200; KV `77afdfdf…`, D1 `f158b74f…`) |
| Backend: per-client env wiring | ☐ not started — `SUPERATOM_LLM_PROXY_URL=https://ai.superatom.ai` + per-client proxy keys |
| Anthropic ban appeal | ☐ not started |
