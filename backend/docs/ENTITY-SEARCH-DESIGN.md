# Entity Search Engine — Implementation Design

**Status:** proposed — awaiting sign-off · **Scope:** Total Group first, built client-agnostic · **Owner:** backend

---

## 1. Why

The agent fails at *resolving what the user named*, not at reasoning. Two failures, both reproduced against the live DB:

| asked | agent answered | truth |
|---|---|---|
| booking amount of **FDC limited**, glenmark, sumitomo | "FDC Limited was not found in the customer master database" | Stored as **`F D C LIMITED`** — `PartyId 10141`, `Code C000163`. `LIKE '%FDC%'` returns 0 rows. |
| find **CHL/895/26-27** for Chandresh Cables | "does NOT exist in the system... the CHL series does not exist at all" | Exact literal in `trp_trn_bookinginvoice.InvoiceNo` — `BookingId 837159`, GCN `1020139859`. The agent searched only Total Group's internal numbering; `CHL/...` is the *customer's own* invoice number. |

Both burned 3–6 iterations probing, then answered with a confident false negative. **A wrong answer delivered with citations is worse than a slow one.**

The two cases fail differently, and both must be fixed:
- **FDC = matching.** The value is there; the pattern can't reach it.
- **CHL = coverage.** No matching needed at all — the right column was never searched.

Why existing machinery doesn't help:

| | why not |
|---|---|
| Semantic model | Describes *tables*, not *values*. Cannot know `F D C LIMITED` exists. |
| `valueVocabulary` | `PartyName` has **145,677** distinct values; its vocabulary is 8 arbitrary driver names. |
| Chroma / vectors | Wrong tool for exact identifiers. MiniLM will never usefully embed `CHL/895/26-27`. |
| KB nodes | Node 42 *mandates* "find the id first" — correct, but the agent has no reliable way to do it. |

---

## 2. What we build

A search service in the client VM, backed by Postgres, holding two stores.

**Value index** — what did the user name? **Bounded master data only.**

```
entity_type  instance_id  value                value_kind  attrs
customer     10141        F D C LIMITED        name        {code: C000163}
customer     10141        C000163              code        {code: C000163}
branch       19           VADODARA             name        {code: 513}
servicenetwork 1042       BANGLORE             name        {controlling: HYDERABAD}
```

Given `FDC` it returns `instance_id 10141`. The agent writes `WHERE BillingPartyId = 10141` — it never guesses a `LIKE` pattern again.

Codes are indexed alongside names: `C000163` is the same bounded master data as `F D C LIMITED`, and users paste codes.

**Entity map** — how do I reach a concept? One row per **user-facing concept**, not per table. `customer` is an entity; `com_mst_party` is an implementation detail stored inside it. Covers `customer`, `lane`, `invoice`, `outstanding-booking`, …

### 2.1 The scoping rule: bounded vs unbounded

**We do not index transaction data.** Doing so would mirror their database.

| | goes in | why |
|---|---|---|
| **Bounded** — customer/branch/vehicle/service-network names and codes | **value index** | ~a few hundred thousand rows total, slow-changing. Resolvable with **no query against the source DB**. |
| **Unbounded** — invoice numbers, GCN numbers, e-way bills, any per-transaction identifier | **entity map** | Grows forever, one row per transaction. The map tells the agent *where and how* to look; it runs one targeted query. |

The two failures in §1 are therefore fixed by two different halves:

- **FDC** → value index. Resolved to `PartyId 10141` with zero source queries.
- **CHL/895/26-27** → entity map. The agent is told invoice numbers live in `trp_trn_bookinginvoice.InvoiceNo` and runs **one correct query** instead of six failing probes.

**Requirement this places on the entity map:** for unbounded identifiers, `resolution` must carry the **match pattern**, not just the table and column.

Not for typos — users copy-paste identifiers, they don't misspell them. It is because **the stored data is irregular**. Actual values in `trp_trn_bookinginvoice.InvoiceNo`:

```
CHL/499/23-24                 ← canonical
CHL2144/23-24                 ← no slash after CHL
CHL/1962/61/64/23-24          ← extra segments
CHL/2475/23-24,CHL/2476/23    ← two invoice numbers in one field
```

A user typing the natural `CHL/2144/23-24` gets zero rows from `InvoiceNo = '...'` because that row has no slash; the comma row cannot be found by equality at all.

So the pattern is **squash both sides, then contains** — still exact and deterministic, no fuzzy matching:

```sql
REPLACE(REPLACE(REPLACE(UPPER(InvoiceNo),' ',''),'/',''),'-','')
  LIKE '%' + :squashed_input + '%'
```

Without this the bug moves rather than disappears. Note this is the *same squash rule* as the value index — one normalization concept, applied in two places.

```
question ──┬─► extract mentions ──► resolve  ──► exact ids   ─┐
           │                                                  ├─► injected into MainAgent prompt
           └─► detect concepts  ──► entity map ──► tables/joins┘
```

---

## 3. Decisions

**Engine: Postgres 17 + `pg_trgm` + FTS**, in the existing project database. Already provisioned, backed up and Drizzle-managed; client values never leave the VM.

**Plain FTS does not solve either case.** `to_tsvector('F D C LIMITED')` → tokens `f`, `d`, `c`, `limited`; query `FDC` → `fdc`; **no match.** The fix is a *squashed* form (`fdclimited`) with a trigram index — §4.

**Location: same database, new tables.** One migration chain, one backup; the FK between the two tables comes free. Counter-argument, recorded: the value index is *derived data* (rebuildable), while the rest of that DB is user data that isn't — so backups carry tens of millions of regenerable rows. All DB access is confined to `entity-search.ts`, so moving later is a connection-string change. Revisit if backup/restore time hurts.

**Meilisearch: not now.** It would fail the same headline case — it tokenizes on whitespace (`f`/`d`/`c`/`limited`) and its typo tolerance needs 5+ character words before allowing one typo, so the 3-char query `FDC` is matched exactly and hits nothing. `FDC` vs `F D C` is a *tokenization* mismatch, not a typo; **any** token-based engine hits it, and the fix is the squashed form either way. So this isn't Postgres vs Meilisearch — the squashed work is required regardless; the question is only whether we run a second engine on top of it, as a **third datastore** per VM (we already run Postgres + Chroma).

Adopt it when one of these is *observed*: (1) real misspellings at volume where trigram underperforms, (2) synonym config we're hand-maintaining in SQL, (3) user-facing typeahead in the UI, (4) resolve latency past the §9 target. Keep `/resolve` engine-agnostic so it can be swapped behind the contract.

---

## 4. Schema

New migration `0019_entity_search.sql`, hand-authored + `_journal.json` entry — same pattern as `0016`–`0018`.

Store only what is used. Everything below is exercised by phase 1; nothing is speculative.

**`search_entity_types`** (entity map) — `entity_type` PK · `resolution` **jsonb** · `created_at` / `updated_at`. (Tiny table, a few dozen rows — timestamps are free here.)

`resolution` holds *everything* about reaching the concept — tables, id/label columns, join path, SQL template — and is JSONB because concepts differ in shape: `customer` is one table; `outstanding-booking` is a join plus a filter predicate. Structure is enforced at the write layer, not by columns.

**`search_values`** (value index) — `id` bigserial · `entity_type` FK · `instance_id` · `value` · `value_kind` · `attrs` jsonb · `updated_at` · 3 generated columns.

- `value_kind` (`name`/`code`/`alias`) — drives **ranking**, not matching; distinguishes `C000163` from `F D C LIMITED` for the same instance. (No `identifier` kind: transaction identifiers are not indexed — §2.1.)
- `attrs` — payload returned with the hit, so a resolve needs no follow-up query.
- `updated_at` — drives incremental refresh and stale-row detection (§7). `created_at` is omitted here: at tens of millions of rows it buys nothing operationally.

Three ids, deliberately distinct:

| | what it is | in generated SQL? |
|---|---|---|
| `search_values.id` | row id of one value row | no — internal |
| `instance_id` | business key of the instance (`10141`) | **yes — this is the payload** |
| `entity_type` | the concept (`customer`) | no — a label |

Normalized forms are **`GENERATED ALWAYS ... STORED`** — the indexer writes only `value`, so normalization can never drift from the data:

| column | `F D C LIMITED` | `CHL/895/26-27` |
|---|---|---|
| `value_norm` — punctuation → space | `f d c limited` | `chl 895 26 27` |
| `value_squashed` — punctuation removed | `fdclimited` | `chl8952627` |
| `value_tsv` — `to_tsvector('simple', norm)` | word tokens | word tokens |

`value_squashed` is what makes **both** cases work: `fdc` is a substring of `fdclimited`, and every punctuation variant of the CHL number collapses to one key. (`to_tsvector` must use the 2-arg form — the 1-arg form is only `STABLE` and is rejected in a generated column.)

**Indexes:** GIN `gin_trgm_ops` on `value_squashed` (the fix) and `value_norm`; GIN on `value_tsv`; btree `text_pattern_ops` on `value_norm` for exact/prefix; unique `(entity_type, instance_id, value_kind, md5(value))` so re-indexing updates instead of duplicating.

**Scale:** master data only — parties 185,890 · service networks 8,953 · locations ~180 · plus vehicles and charge heads. Names + codes land in the **low hundreds of thousands of rows**, not millions. (For contrast, indexing transaction identifiers too — 732,060 bookings and their invoices — would have added millions of forever-growing rows; §2.1 rules that out.)

---

## 5. Retrieval

One query, tiered so exact always beats fuzzy. Ties break on `value_kind` priority, then shorter value.

| tier | score |
|---|---|
| exact `value_norm` | 1.00 |
| exact `value_squashed` | 0.95 |
| prefix on `value_norm` | 0.85 |
| word match (`tsquery`) | 0.75 |
| **starts-with on `value_squashed`** | **0.70** |
| substring on `value_squashed` | 0.60 |
| trigram similarity | `sim × 0.5` |

The 0.70 tier was added during phase 1 after measurement: without it `FDC` tied `F D C LIMITED` against `…DIVISION OF DCM SHRIRAM…` at 0.60 (both are substring hits) and the result was flagged ambiguous. An acronym that *opens* the squashed value is a stronger signal than one sitting mid-word, so the real match now leads 0.70 to 0.60.

Returns `entityType, instanceId, value, valueKind, attrs, score, matchType`.

**Rules — the product-facing part:**

1. **Zero matches is a hard stop.** Return `{resolved: false}`; the agent must name the failed mention and refuse *that part*. It must never silently answer for the subset that resolved. This is the fix for the actual damage in both cases.
2. **One result per `(entity_type, instance_id)`**, best score kept. One instance has several values (name, code, alias) — without collapsing, `FDC` reads as "3 matches" for one customer.
3. **Ambiguity is returned, not hidden.** `FDC` legitimately matches 2 parties today; `CHANDRA` maps to a customer *and* a product. Return ranked candidates; the agent disambiguates or asks.
4. **`instance_id` is opaque.** Composite keys (a `lane` = from+to) keep parts in `attrs`; only the caller parses them.

---

## 6. Integration

Two callers, one implementation:

- **SDK collection** `entity-search` — ops `resolve`, `entities`, `indexValues`, `upsertEntityType`, `deleteValues`, `stats`. Mirrors the existing `schema-embeddings` collection.

Hook point in `sdk-nodejs/.../main-agent.ts`: `handleQuestion()` (~209), before `buildSystemPrompt()`; inject as a template var alongside `KNOWLEDGE_BASE_CONTEXT` (~1062), consumed by a `{{RESOLVED_ENTITIES}}` block in `agent-main/system.md`. Same shape as the existing `preResolveSchema()` (~862).

**Mention extraction:** start **index-first** (run question n-grams against the index, no LLM) — the index is its own filter, and an n-gram that hits nothing is dropped. Revisit if precision is poor.

---

## 7. Filling the index

Claude Code authors the content; infrastructure only provides the write path via `entity-search-index.ts`.

**Value index — bounded master data only** (§2.1): names and codes for customer/party, branch/location, service network, vehicle, charge head, plus low-cardinality categoricals (status, party category, document type). Don't hand-curate 348 tables — drive candidate selection from the semantic model's existing `cardinality` / `distinct` / `sampleValues`, and have Claude Code confirm.

**Entity map — everything a user can ask for**, including every unbounded identifier class (invoice no, GCN no, e-way bill, PAN) that is deliberately *not* indexed. Each such entry must carry its match pattern (§2.1), not just table and column.

**Freshness:** scheduled rebuild per entity, watermarked on `UpdatedOn` where available. Master data changes slowly, so a nightly rebuild of a few hundred thousand rows is cheap — this is a direct benefit of the §2.1 scoping. Real-time CDC is out of scope.

---

## 8. What changes, and when

| file | change | status |
|---|---|---|
| `drizzle/migrations/0019_entity_search.sql` + `_journal.json` + `0019_snapshot.json` | new — extension, 2 tables, generated cols, 8 indexes | **done, applied** |
| `drizzle/schema.ts` | edit — Drizzle table defs | **done** |
| `src/project-data-db/entity-search.ts` | new — upsert, bulk index, ranked resolve, stats | **done** |
| `scripts/_verify-entity-search.ts` | new — seeds real rows, asserts 10 resolve cases, cleans up | **done, all pass** |
| `backend/src/collections/entity-search.ts` + `index.ts` | new + edit — register collection |
| `backend/src/tools/direct/.../resolve-entity/` | new — direct tool |
| `backend/scripts/entity-search-index.ts` | new — CLI to fill/refresh |
| `main-agent.ts`, `agent-main/system.md` | **phase 3 only** |

Nothing existing is modified destructively — no change to the semantic model, KB nodes, or the current agent flow before phase 3.

| phase | contents | SDK release? |
|---|---|---|
| **1 — infrastructure** | migration, data layer, collection; verified by resolving both cases end to end | no |
| **2 — usable** | `resolve-entity` tool + KB rule + first real index fill | no |
| **3 — automatic** | MainAgent pre-pass, `{{RESOLVED_ENTITIES}}`, zero-match hard stop | **yes** |
| **4 — later** | PostGIS geo entities; entity map generated from semantic model | no |

**Phases 1+2 alone fix both reported failures.** Phase 3 removes the agent's discretion to skip the resolver.

Out of scope for phase 1: PostGIS (right long-term answer to the `PAL`→`PALAKKAD` bug, but needs 8,953 service networks geocoded first), replacing the semantic model, real-time sync, any cross-client shared index.

---

## 9. Success criteria

- **Value-index path:** `FDC` → `PartyId 10141` in a single call, with **no query against the source DB**.
- **Entity-map path:** `CHL/895/26-27` → `BookingId 837159` in **one** targeted query (today: six failing probes then a false negative). `CHL 895 26-27` and `chl8952627` must work too — that is the §2.1 match-pattern requirement, and is the thing to test, since it is where this path breaks if the map only names a table and column.
- A genuinely absent mention yields an explicit failure, **never** a silent partial answer.
- Median resolve latency < 50 ms.
- Measurable drop in agent iterations per question (baseline captured before phase 3).

---

## 10. Open questions for sign-off

1. **Entity map vs semantic model — one source of truth or two?** `resolution` overlaps what the semantic model already stores (`joins`, `notes`, `summary`). *Not hypothetical:* the disk semantic model and the applied DB copy have already drifted on 31 entities, leaving the disk copy prescribing the known-unsafe `LIKE CityName + '%'` pattern. A second hand-edited store compounds that. **Recommend: entity map generated from the semantic model, which stays authoritative.**
2. **Index refresh cadence** — nightly? hourly? per entity? Sets the staleness window for new customers/invoices.
3. **Mention extraction** — confirm index-first for phase 1.
4. **Rollout** — build general from day one (recommended; nothing here is client-specific), populate Total Group first.
5. **Meilisearch** — confirm the §3 position and its adoption triggers.

**Decided:** same database · Postgres over Meilisearch for now · `instance_id` naming · **value index holds bounded master data only; unbounded identifiers go through the entity map (§2.1)** · phases 1–2 ship without an SDK release.
