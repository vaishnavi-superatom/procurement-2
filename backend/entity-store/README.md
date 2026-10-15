# Entities and Concepts — Working Guide

How the agent turns the words in a question into database ids and correct formulas.
**This directory holds the authored data; this file explains it.** Read it to author,
load, or debug entities and concepts.

> The files in this directory ship with placeholder/example content only. Before
> pointing an account at this system, replace `entity_map.json`,
> `entity_sample_values.json`, and `concepts.json` with that account's real data —
> see §3 and §4 below for the authoring rules.

Companion: `../docs/ENTITY-SEARCH-DESIGN.md` covers *why* the entity engine exists
and remains accurate on the rationale — including the bounded/unbounded scoping rule
restated below. One thing there has since changed: it describes `resolution` as
holding formulas too. Computed knowledge now lives in a separate `concepts` store,
and each name belongs to exactly one of the two.

---

## 1. The one decision that governs everything

Every piece of business knowledge is one of two things. Getting this wrong is the
source of most bugs in this area.

| | **Entity** | **Concept** |
|---|---|---|
| Answers | "what did the user *name*?" | "how do I *compute* this?" |
| Example | `Acme Corp` → `customer.id = 12345` | `revenue = qty × rate`, except when… |
| Has indexed values? | **Yes** — that is what makes it an entity | No |
| Lives in | `search_entity_types` + `search_values` | `concepts` |
| Reached by | `resolve_entities` | `resolve_concepts` |
| Matched by | fuzzy search over the indexed values | name/alias, with correction |

**The rule: if you can list its values and a user would say one out loud, it is an
entity. Everything else is a concept.**

A name appears in exactly **one** of the two stores. That is deliberate — when the
same rule lived in both, they drifted, and the agent received two different
definitions of the same metric in the same turn.

### What is deliberately NOT indexed

From `../docs/ENTITY-SEARCH-DESIGN.md` §2.1, and still the governing rule: **bounded**
master data (names, codes) is indexed; **unbounded** per-transaction identifiers
(invoice numbers, external reference numbers) are not — they grow forever and mirror
the source database. For those, the entity map records *where they live* and the
agent runs one targeted query.

---

## 2. The three stores

### `search_entity_types` — the entity map

One row per kind of name. Typically a handful of rows for a given account.

```
entity_type  varchar(64) PK     'customer name'
resolution   jsonb              where the values live, and how to reach them
```

`resolution` is assembled by the loader from **both** source files:

```jsonc
{
  "mapping":    "customer.companyname — the customer's display name…",  // from entity_map.json
  "idField":    "customer.id",          // from entity_sample_values.json
  "valueField": "customer.companyname",
  "indexed":    true,
  "complete":   true,                   // full_dump: the values are the whole set
  "rowCount":   4048,
  "indexedCount": 4048,
  "note":       "Scoped to isinactive=F …"
}
```

`idField` is the one the agent puts in its `WHERE` clause. It is returned
automatically now — see §6.

### `search_values` — the value index

One row per indexed value.

```
entity_type   FK → search_entity_types (ON DELETE CASCADE)
instance_id   the business key the agent filters on  ('279067')
value         the text a user might say              ('Acme Corp')
value_kind    name | code | alias — drives RANKING, not matching
attrs         jsonb payload returned with a hit (project_count, title, …)
value_norm / value_squashed / value_tsv    generated, indexed for matching
```

The three generated columns are why minor spelling/spacing/case differences in a
typed name still reach the same row. Never write them by hand.

### `concepts` — computed knowledge

```
name       varchar(64)   catalog key the agent asks for
body       text          the complete rule — REQUIRED
kind       varchar(24)   formula | definition | filter | lookup | join | invariant
requires   text[]        other concept names, resolved TRANSITIVELY
returns    jsonb         { type, unit, grain, caveats }
aliases    text[]        other ways users say it
origin     varchar(24)   data_source | knowledge_node | user_question | agent_validated
source_id  varchar(100)  project_sources.id, or NULL for all sources
```

Only `name` and `body` are required — the same two-field surface as an entity-map
entry, so authoring one is no harder than before.

---

## 3. Source files

All authored data lives here, in `backend/entity-store/`. `backend/scripts/` holds
only tooling.

| file | what it is |
|---|---|
| `entity_map.json` | the live map — indexed types only |
| `entity_sample_values.json` | the value dump |
| `concepts.json` | concept definitions |

This repo's copies of these files are **placeholders** — a shape example, not real
account data. Author real ones per account before loading.

### `entity_map.json`

```json
[
  { "entity": "customer name",
    "mapped_to": "customer.companyname — the customer's display name; the customer table covers both company and individual customers." }
]
```

Two fields. `mapped_to` is prose describing where the value lives and how to reach
it. **Every entry here must have values in the dump** — the loader's `SKIPPED`
section should be empty. A map entry with no values is a concept in the wrong file.

### `entity_sample_values.json`

```jsonc
[
  {
    "entity_type": "customer name",
    "id_field":    "customer.id",
    "value_field": "customer.companyname",
    "full_dump":   true,          // these are ALL the values, not a sample
    "row_count":   4048,
    "note":        "Scoped to isinactive=F …",
    "sample_values": [
      { "id": "12345", "value": "Acme Corp", "project_count": 344 }
    ]
  }
]
```

`sample_values[]` needs `id` and `value` at minimum. A value with no `id` cannot be
resolved *to* anything and is skipped. Extra keys are carried into `attrs` when the
loader recognises them (`project_count`, `title`, `code`, `active`, …) — see
`COUNT_KEYS` in `entity-search-load.ts`.

Where the file has `code` as well as `value`, both are indexed for the same
`instance_id`, so users can paste either.

### `concepts.json`

```jsonc
[
  {
    "name": "example formula",
    "kind": "formula",
    "aliases": ["example metric"],
    "body": "Join a.id = b.fk, filter a.status = 'active' … value = qty × rate, except when type is 'special' — then use the override column instead.",
    "requires": [],
    "returns": { "type": "money", "unit": "per-currency, unconverted",
                 "caveats": ["state any caveats that would otherwise surprise a reader"] },
    "origin": "knowledge_node"
  }
]
```

---

## 4. Authoring rules

### Entities

**One entity type per kind of name.** Not per table — `customer name` is an entity;
`customer` the table is an implementation detail inside `resolution`.

**The dump decides what gets indexed, not the loader.** The loader is deliberately
dumb: everything with ids gets indexed. So keeping transaction attributes out of the
values file is the *dump author's* job. Put them in the map instead.

**Scope the dump when the source has shadow records.** Some sources carry duplicate
or suffixed records with the same display name as a real one; scope the dump to
exclude them for exactly this reason, and carry a disambiguating count/attribute so
remaining collisions are resolvable rather than picked blind.

### Concepts

**One rule per concept.** A body needing "and also…" is two concepts joined by
`requires`.

**Use `aliases` instead of copies.** If several entries end up restating the same
formula under different names, the exception clause then has to be fixed in every
copy. Make them one concept with aliases instead.

**Fill in `requires`.** This is what makes decomposition safe. Asking for a derived
metric must also deliver its preconditions (a valid-row filter, a dedup rule), or you
get a correct formula over the wrong rows. Leave it out and the dependency ends up as
prose in `body`, recoverable later only by re-authoring every concept by hand.

**Fill in `returns`.** The field that makes an unstated unit visible while authoring
rather than in a wrong answer — e.g. a value spanning multiple currencies, where a
plain `SUM` would be meaningless.

**`kind: 'invariant'` means always-injected.** Use it for preconditions no question
is semantically close to — date encodings, valid-row filters. If the same clause
keeps getting repeated verbatim across many concept bodies, that is a sign it should
become one invariant. Invariants take no `requires` edges: they are injected on every
turn, so an edge would only duplicate them into every response.

---

## 5. Loading

Run everything from `backend/`. Paths resolve against the CWD.

```bash
# Entities — REPLACES the store (clears entity types + values first)
pnpm tsx scripts/entity-search-load.ts \
    --map entity-store/entity_map.json \
    --values entity-store/entity_sample_values.json

pnpm tsx scripts/entity-search-load.ts ... --dry-run     # report, write nothing
pnpm tsx scripts/entity-search-load.ts ... --only "customer name"   # partial, no wipe
pnpm tsx scripts/entity-search-load.ts --stats           # what is loaded now
```

A load is **authoritative**: the files are the whole truth, not a patch. Without the
wipe, a renamed entity leaves both generations resident and the same instance
resolves twice — which the caller reports as ambiguity from data that is not
ambiguous.

```bash
# Concepts — split from the pre-split map, then load
pnpm tsx scripts/_concepts-migrate.ts                 # dry run: report only
pnpm tsx scripts/_concepts-migrate.ts --write         # write concepts.json
pnpm tsx scripts/_concepts-migrate.ts --write --load  # …and load into the store

# Inspect / debug
pnpm tsx scripts/_concepts.ts --catalog     # what the agent is shown
pnpm tsx scripts/_concepts.ts --resolve "example formula" --invariants
pnpm tsx scripts/_concepts.ts --lint        # requires edges pointing nowhere
pnpm tsx scripts/_concepts.ts --stats
```

**Neither store needs a restart.** Both are read per question.

After a full reload, run `VACUUM ANALYZE search_values` — repeated wipe-and-reload
leaves dead tuples and stale planner stats.

---

## 6. How they reach the agent

### The prompt (every turn)

```
### ENTITY CATALOG        {{ENTITY_CATALOG}}      names only
### CONCEPT CATALOG       {{CONCEPT_CATALOG}}     names + aliases
### ALWAYS APPLIES        {{CONCEPT_INVARIANTS}}  full bodies — injected, not requested
```

Catalogs carry **names only**. Bodies come back from the tools once the agent has
named something — putting bodies in the prompt would rebuild the always-on context
problem concepts exist to solve.

> A placeholder the SDK does not supply is left **intact** by the prompt loader, so
> a template referencing an unknown variable ships `{{LIKE_THIS}}` to the model
> verbatim. Add the SDK variable before the placeholder, never the other way round.

### `resolve_entities({ mentions })`

Pinned to iteration 1 on every question.

- Pass every named value **verbatim** — no cleanup, no spelling fixes.
- Set a mention's `entityType` **only when the question states the type**
  ("project 314023"). **Never guess it.** A wrong guess confines the search to that
  type, and the unscoped fallback only fires on *zero* hits — so a weak wrong-type
  match wins silently. Omitted, every type is searched and the best candidate per
  type comes back labelled (`perTypeCap = 2`).
- Returns `resolved`, `alternatives`, `unresolved`, `recognized`, and `entityMap`.
- **`entityMap` is attached automatically** for every type a mention resolved to, so
  the agent always has `idField` without having had to ask.

Reading results: the top pick is safe on an exact or high score. When `ambiguous` is
set **or the score is low**, read `alternatives` — a confirmed miss can have the right
candidate scored just behind several coincidental matches, a gap too wide to be
flagged automatically.

### `resolve_concepts({ names })`

- Exact match on name or alias.
- A clear misspelling is **corrected** and reported.
- A vague or contested name resolves to **nothing** — `didYouMean` candidates come
  back instead, so a generic term matching several unrelated concepts within a
  narrow score margin isn't bound to the nearest one silently.
- `requires` is expanded transitively; implied concepts are marked `viaRequires`.

Thresholds live in `concepts.ts`: `FUZZY_ACCEPT` 0.65, `FUZZY_MARGIN` 0.12,
`FUZZY_FLOOR` 0.35. Trigram similarity over multi-word names runs lower than
intuition suggests — a one-character slip scores ~0.74, not ~0.95 — so the margin,
not the threshold, is what protects the contested case.

---

## 7. Common failures

| symptom | cause |
|---|---|
| Agent invents a filter on a name | it never called `resolve_entities`, or the value is not indexed |
| "Not found" for a real value | dump scoped too tightly, or the name is stored differently — check `alternatives` |
| Right formula, wrong number | a `requires` edge is missing, so a precondition was not injected |
| Formula ignored, agent re-derived it | concept name not in the catalog, or the ask came back in `didYouMean` and was not followed up |
| Same rule with two different definitions | it exists in both stores — it must live in exactly one |
| `SKIPPED` entries in the entity load | map entries with no values: they belong in `concepts` |
| `pnpm db:generate` fails on a snapshot collision | drizzle snapshot chain broke — see `fix(drizzle): relinearise the migration snapshot chain` |

Log lines worth grepping:

```
[ENTITY-SEARCH] resolve("…") RESOLVED — n hit(s)
[ENTITY-SEARCH] resolveEntities() → SENDING TO LLM: …
[MainAgent] resolve_concepts: asked n → m returned, corrected: …, ambiguous: …
[CONCEPTS] resolve(n asked) → m concept(s), k implied by requires
```

---

## 8. Current state and known gaps

This repo's `entity-store/` files are placeholders, not a real account's data — see
the note at the top of this file. Once a real account is authored, keep this section
updated with that account's own gaps (e.g. concepts missing a `returns` unit,
multi-currency handling, loader coverage), rather than leaving example numbers here.
