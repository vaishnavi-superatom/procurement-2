# Cross-Machine Data Sources (via the WebSocket Durable Object)

> **Status:** Design approved (revised per feedback) — implementation in progress.
> Track per-component status in the [Status](#status) table at the bottom.
> **Repos touched:** `do-websocket` (Cloudflare DO), `scripts-flow/backend`, `db-bridge`.
> The SDK (`sdk-nodejs`) needs **no change** — the script subprocess already calls the HTTP bridge.

---

## 1. The problem in one sentence

A script running on **machine A** can only read data sources connected on **machine A**.
We want a script on machine A to transparently read a data source that lives on **machine B**.

### Why it matters
Deploy a project on an **EC2** box and add an **Excel** data source there (the `.xlsx` is on
EC2's disk). From a **laptop** running the same project, ask a question that needs that Excel
data. Today: impossible — the laptop has no file, so the data source doesn't exist there.
Goal: the laptop asks for the data source **by id**, and the routing layer delivers the rows —
the laptop never needs to know the data source lives on EC2.

---

## 2. Vocabulary (read this first)

The infrastructure layer has exactly **three nouns**. ("Tool" is an LLM/agent concept and does
**not** appear here.)

| Term | Meaning |
|------|---------|
| **Data Source ID** | Stable id of a data source in a project (e.g. `financial_postgres`), from `project_sources`. The *only* thing a consumer specifies to query. |
| **Proxy ID** | Stable id for a proxy deployment. Survives restarts. |
| **WebSocket ID** | The per-connection id the Durable Object assigns. Changes on every reconnect. *(In the existing `broadcaster.ts` code this is the variable `clientId` — same thing; we did not rename the existing internals.)* |
| **Proxy** | Any deployment that (a) manages connections to one or more data sources and (b) holds one WebSocket to the DO. The proxy **is** the Data Source Manager — the PostgreSQL/MSSQL/Excel/… connection templates live inside it. The old "db-bridge" is just a proxy that happens to manage only SQL sources. |
| **SuperAtom Engine** | Orchestrates the overall system (runs sources, the script bridge, the agent flow). It does **not** talk to the DO directly. |
| **Proxy Connection System** | The component that owns the DO WebSocket and performs proxy registration + request routing. Registration is its job, **not** the Engine's. |
| **Durable Object (DO)** | A Cloudflare object — **one per project** — that all of a project's WebSocket connections attach to. It holds the data-source→proxy registry and **routes requests**. |
| **Script (HTTP) bridge** | A tiny HTTP server (`127.0.0.1:4001`) inside the Engine. A running script does `POST /query {toolId, sql}`. `toolId` is the agent-level name (`${dataSourceId}_query`); the bridge strips it to a **Data Source ID** before handing off to the Proxy Connection System. |

---

## 3. Architecture: the DO owns routing

The requester is **dumb about location**. It sends a Data Source ID to the DO; the DO knows
who owns it and forwards. The requester never learns which proxy/machine answered.

```
                         ┌────────────────────────────────────────────┐
                         │   Durable Object  (project = P)              │
                         │   registry (keyed by Data Source ID):        │
                         │     financial_postgres → { proxyId, wsId }   │
                         │     excel_sales        → { proxyId, wsId }   │
                         │   routes requests by Data Source ID          │
                         └────────────────────────────────────────────┘
              DS_QUERY(excel_sales) ▲   │ forward to owner (wsId)   ▲ register
                       (no target)  │   ▼                           │
        WebSocket                   │   ┌───────────────────────────┴───┐
   ┌───────────────────┐           │   │   EC2 proxy                    │
   │ Laptop proxy      │───────────┘   │   manages excel_sales (DuckDB) │
   │ (no excel_sales)  │ ◀── DS_ACK ───│   1. exists? connected?        │
   │ awaits requestId  │ ◀── DS_RESULT │   2. ack, then query, reply    │
   └───────────────────┘               └───────────────────────────────┘
```

Every proxy plays **two roles** on its one WebSocket:
- **Requester** — "I don't have this data source" → send its id to the DO, await the reply.
- **Responder** — a request the DO forwarded to me → check I own it & it's connected →
  ack, query my local Data Source Manager, reply.

The DO is the *only* component that knows the data-source→proxy mapping.

---

## 4. The wire protocol

Messages use the DO envelope `{ id, type, from:{type,id}, to:{type?,id?}, payload }`, where
`id` is the **Request ID** used to correlate replies. New types:

| Message | Direction | Payload | What happens |
|---------|-----------|---------|--------------|
| `REGISTER_PROXY` | proxy → DO | `{ proxyId, dataSourceIds: string[] }` | DO upserts, keyed by **Data Source ID**: `dataSourceId → { proxyId, wsId, lastSeen }` (wsId = this connection). Re-sent on every (re)connect and whenever the owned set changes. |
| `UNREGISTER_PROXY` | (implicit on disconnect) | — | On `webSocketClose`, the DO drops every record whose `wsId` matches the closing connection. |
| `DS_QUERY` | requester → DO → owner | `{ dataSourceId, sql, params? }` | Requester sends with **no `to`**. DO looks up the owner; if none/offline → `DS_ERROR` back to requester. Else DO forwards to the owner's `wsId`, stamping `from.id` = requester's wsId so the owner can reply. |
| `DS_ACK` | owner → DO → requester | — | Owner has the data source and it's connected; querying has begun. Lets the requester know it isn't lost. |
| `DS_RESULT` | owner → DO → requester | `{ data, count }` | Query rows. |
| `DS_ERROR` | DO or owner → requester | `{ error }` | No owner / owner offline / data source missing / not connected / query failed. Sent **immediately** — the requester never waits indefinitely. |

`DS_ACK` / `DS_RESULT` / `DS_ERROR` carry `to:{ id: <requester wsId> }` and the original
Request ID, so they ride the DO's existing point-to-point relay straight back to the requester.
Only `REGISTER_PROXY`, `UNREGISTER_PROXY`, and `DS_QUERY` need new DO-side handling.

---

## 5. How each requirement is done

### Req 1 — register Proxy ID + its Data Source IDs in the DO
The **Proxy Connection System** (not the Engine) opens the WebSocket and, on connect, sends
`REGISTER_PROXY { proxyId, dataSourceIds }` where `dataSourceIds` are the sources currently
connected locally (`SourceManager.getStatus()`). The DO persists records **keyed by Data
Source ID** in `state.storage` (survives hibernation). Project scoping is automatic — one DO
per project (`idFromName(projectId)`).

Stability: `proxyId` is stable across restarts (`SA_PROXY_ID` env, else generated once and
persisted to `backend/.proxy-id`). The `wsId` is *not* stable, so we re-register on every
reconnect to refresh it in the records.

### Req 2 — the db-bridge is just another proxy
Same registration. The db-bridge advertises its `PROXY_ID` + `SOURCE_IDS` via the same
`REGISTER_PROXY`. No special "db-bridge" concept in the routing layer — it's a proxy that
manages SQL sources.

### Req 3 — local first, otherwise route through the DO
The script bridge keeps its agent-facing contract (`toolId`), but at the boundary it derives
the **Data Source ID** (strip the `_query` suffix) and the flow becomes:

```
POST /query { toolId: "excel_sales_query", sql }
   │  dataSourceId = "excel_sales"
   ├─ SourceManager has it locally & connected?  ─► yes ─► execute locally (today's path)
   └─ no ─► Proxy Connection System: send DS_QUERY{dataSourceId, sql} to the DO  (no target)
            DO looks up the owner and forwards; owner acks, queries, returns DS_RESULT
            └─ return {data, count} to the script — identical envelope as a local hit
```

The **responder** resolves the data source through the **Data Source Manager**
(`getSourceManager().getInstance(dataSourceId)`), **not** through tools. It:
1. checks the data source **exists** here, and
2. checks the connection is **currently active** (`isConnected()`),
3. if yes → send `DS_ACK`, run `instance.execute({sql, params})`, send `DS_RESULT`,
4. if no → send `DS_ERROR` immediately.

No re-resolution on the responder side → a request can never loop between machines.

### Req 4 — read EC2's Excel from the laptop
Req 1 + Req 3 together: EC2 registers `excel_sales`; the laptop lacks it, sends
`DS_QUERY{excel_sales}` to the DO; the DO forwards to EC2; EC2 acks, runs DuckDB, returns
rows. Works for any source type because the responder uses the uniform
`instance.execute({sql})` contract and both ends speak the same DuckDB SQL for file sources.

### Authentication (v1)
A proxy must present the **project API key** when connecting to the DO. If it's missing/invalid
the connection is rejected and the proxy **cannot register or serve** any data source. Enforced
for **proxy connections** (existing UI/agent client types are left as-is for now). Per-proxy JWT
(`generate-proxy-token`) is a **later** enhancement, explicitly out of scope for v1.

---

## 6. Components & files

| Repo / file | Role |
|-------------|------|
| `do-websocket/.../broadcaster/types.ts` | `DataSourceRecord` + new message types. |
| `do-websocket/.../broadcaster/broadcaster.ts` | `dataSources` storage **keyed by Data Source ID**; handle `REGISTER_PROXY` / `DS_QUERY` (lookup + forward) / cleanup on close; `/registry` + `/status` show the registry. |
| `do-websocket/.../src/index.ts` | Enforce the project API key for proxy connections. |
| `backend/src/services/source-proxy.ts` | **Proxy Connection System**: one WS to the DO. Registrar (`REGISTER_PROXY`), Requester (`remoteQuery(dataSourceId, sql)` → `DS_QUERY`), Responder (via `SourceManager`, ack + execute). |
| `backend/src/sa.ts` | Engine starts the Proxy Connection System after `startScriptBridge()` (gated by `SA_PROXY_ENABLED`). |
| `backend/src/services/script-bridge.ts` | On local miss, derive Data Source ID and call the Proxy Connection System. |
| `backend/.env.example`, `setup.sh`, `.gitignore` | `SA_PROXY_ENABLED`, `SA_PROXY_ID`; reuse `SA_WEBSOCKET_URL` + `SUPERATOM_API_KEY` (the project key); gitignore `.proxy-id`. |
| `db-bridge` (`types.ts`/`index.ts`/`bridge.ts`/`.env.example`) | Register via `REGISTER_PROXY` using `PROXY_ID` + `SOURCE_IDS`. |

**Reused, not rebuilt:** the request/reply-by-id RPC pattern (`ws-client.ts`),
`SourceManager.getInstance()/isConnected()/getStatus()`, the DO's point-to-point relay.

**Explicitly dropped (per founder):** `RESOLVE_SOURCE`/`SOURCE_LOCATION` (the requester no
longer resolves location); remote `/run-tool` + `getDirectToolSourceMap` (tools are
agent-level — infra routes data-source queries only); any "find tool" in the infra path.

---

## 7. Known limitations & decisions

- **Cross-machine federation (JOINs) is NOT supported.** A SQL JOIN across two sources needs
  both in one DuckDB. Routing serves *single-data-source* queries.
- **Large result sets** are sent whole over the WebSocket with the existing per-call timeout —
  no streaming/chunking yet. `DS_ACK` at least tells the requester the query is in progress.
- **Trust model (v1):** project API key required for proxy connections; project isolation comes
  from the one-DO-per-project boundary. Deferred (noted, not built): per-proxy JWT, verifying a
  proxy's *claimed* data source ids against `project_sources`, heartbeat/TTL of stale records.
- **Ambiguity:** if two proxies advertise the same Data Source ID, the DO keeps the most recent
  registration. Local-always-wins holds because the requester only routes after a *local* miss.
- **Generation only sees LOCAL sources (execution-by-ID only).** This feature makes remote
  *execution* work — `ctx.query(dataSourceId, sql)` is routed to whichever proxy owns the source.
  It does **not** make the agent aware of remote sources. Script/SQL **generation** uses
  `getAllTools()`, which lists only the sources connected on *this* machine, so the agent won't
  author a query against a source that lives on another proxy. Cross-machine works when the
  caller already knows the Data Source ID; natural-language → generation for a remote source
  would require registry-driven schema federation (the agent pulling remote schemas from the DO),
  which is **future work**.

---

## 8. Verification (the EC2 ↔ laptop test)

1. Deploy DO changes (`wrangler deploy`).
2. Start EC2 proxy (project P, Excel present) → logs show `REGISTER_PROXY`; the DO's
   `/registry?projectId=P` lists `excel_sales → { proxyId, wsId }`.
3. Start laptop (project P, file absent) → confirm `excel_sales` is not in its local sources.
4. On the laptop: `curl 127.0.0.1:4001/query -d '{"toolId":"excel_sales_query","sql":"select * from … limit 5"}'`
   → expect rows (served from EC2). Or ask a question that needs that data.
5. Trace logs: laptop `DS_QUERY`; DO forward; EC2 `DS_ACK → DuckDB → DS_RESULT`; laptop result.
6. Negative: stop EC2 → DO replies `DS_ERROR` (no owner) immediately, no hang. Query for a data
   source nobody owns → `DS_ERROR` → bridge 404.
7. `tsc --noEmit` / build each repo.

---

## Status

| Component | Status |
|-----------|--------|
| DO: registry keyed by Data Source ID + `DS_QUERY` forwarding + proxy auth | ✅ done & **deployed** (`wrangler deploy`); api-key admin auth live. |
| Proxy Connection System: register + requester (`DS_QUERY`) + responder (via SourceManager) | ✅ done — `services/source-proxy.ts`, ACK-then-result; pushed on `script-bridge`. |
| Script bridge: local-first, else `DS_QUERY`; remote run-tool dropped | ✅ done — `script-bridge.ts`; `getDirectToolSourceMap` removed. |
| Config/env (`SA_PROXY_*`); auth via `SUPERATOM_API_KEY` (single key) | ✅ done |
| db-bridge as a proxy: `REGISTER_PROXY` (`dataSourceIds`) + `DS_QUERY` handler | ✅ done — `db-bridge` types/index/bridge; typechecks. |
| SDK published as `0.0.1-dsp`; backend dependency bumped | ✅ done |
| **End-to-end verified** against the deployed DO | ✅ real backend registered its Excel source → `/registry` showed it → remote requester pulled real rows via the DO → registry self-cleaned on disconnect. |
| Registry-driven schema federation (generation-aware remote sources) | ☐ future work (see Known limitations) |
