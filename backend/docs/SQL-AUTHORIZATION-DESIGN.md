# SQL Authorization — AST Rewriting with SQLGlot

How per-user data access is enforced on agent-authored SQL: parsed into an AST, constrained,
and re-rendered before it reaches a source. Adapted from the reference implementation
(`manager/sqlrewrite/`, documented separately); this doc covers **our** version — what we take
unchanged, what we change, and where it hooks into the multi-source backend.

---

## Problem

Our agents write SQL. `SourceAgent` is handed a schema and an intent and produces a query, which
then runs against a customer's production database. Two consequences that ordinary application
code never faces:

1. **The query text is not known in advance.** No fixed statement set to audit, no prepared-statement
   allowlist, no ORM boundary.
2. **The author is a language model.** Not adversarial, but not trustworthy either — it can be wrong,
   and it can be steered by data it read earlier in the turn.

So the guarantee has to be enforced **after the query is written and before it is executed, by
something that is not itself a language model.**

### Why the current mechanism is not that

We already have per-user scoping, and it is prompt-level:

| Layer | Where | What it does |
|---|---|---|
| Policy text | `backend/.prompts/agent-main/system.md:14`, `agent-source-query/system.md:10` | `{{USER_ACCESS_CONTEXT}}` — "apply this on every query, it overrides an explicit user request" |
| Rendering | `sdk-nodejs/src/userResponse/agent-user-response.ts:363` | `buildUserAccessContext()` stringifies the per-user config into that placeholder |
| Read-only guard | `backend/src/sources/core/sql-guard.ts` | Regex over literal-stripped SQL: leading-keyword check, forbidden-keyword scan, single-statement check |

The prompt layer is an **instruction to the author**, not a constraint on the output. A dropped
`WHERE` clause raises no error — it returns a wrong answer that looks right. That is the same
failure class already documented at `script-matcher.ts:372` (a script replaying its full unfiltered
scope while appearing to answer a narrower question).

The regex guard is real enforcement, but only of *read-only*. It says nothing about **which rows**.

### The naive extension, and why we don't take it

Extending the regex guard to check for required predicates fails immediately. `DROP` appears inside
string literals and column names; comments hide statements; dialects differ; and a predicate can be
present textually while being scoped to the wrong sub-select. **Text inspection cannot tell you what
a query does.**

So we don't inspect text. We parse the query into an AST, modify the tree, and re-render SQL from the
modified tree. **What reaches the database is our output, never the agent's input.**

---

## Prerequisite — mostly closed, two gaps left

This document assumes policies arrive from a **trusted server-side resolution** keyed on a verified
user identity. Most of that plumbing now exists; see `REQUEST-CONTEXT-DESIGN.md` for the mechanism.

| Link in the chain | State |
|---|---|
| Relay verifies the sa-api session JWT at handshake | built (`do-websocket/.../index.ts:139`) |
| DO attaches the verified identity to the socket | built (`broadcaster.ts:331`) |
| DO stamps `authContext` onto the relayed message | **built** |
| Message schemas declare `authContext` | **built** — `z.object()` was silently stripping it |
| SDK establishes a request context from it | **built** (`handlers/request-identity.ts`) |
| Context reaches `prepareSql()` on every path | **built**, including across the script bridge |
| Policy resolution from `users.config` | **not built** |
| Client-supplied `authContext` stripped at the relay | **not built — deliberately deferred** |

**Still not a security boundary, for two reasons.** Nothing populates `ctx.policies`, so there is
nothing to enforce. And a client-supplied `authContext` is not stripped: when the sender IS verified
the DO overwrites it, but an unverified sender's own value passes through. That is currently harmless
— `payload.userId` is equally client-controlled and equally trusted, so nothing is worse than before
— and it becomes a real hole the moment anything treats `authContext` as authoritative. **Strip it
before enabling enforcement.**

---

## The sidecar

SQLGlot is Python; our data plane is Node. The rewriter runs as a small pool of long-lived Python
worker processes, spoken to over line-delimited JSON on stdin/stdout — one request per line, one
response per line.

```
request : {"id": 7, "op": "rewrite", "sql": "...", "read": "tsql", "write": "tsql",
           "policies": [...], "readableTables": [...], "maxRows": 50}
response: {"id": 7, "ok": true, "sql": "...", "cappedTo": 50, "applied": ["dw.FactSales.BranchFK"]}
          {"id": 7, "ok": false, "error": "query rejected — ..."}
```

Node owns the pool: checkout, idle reaping, retry-once on a dead worker, and killing children when the
parent exits. The Python side holds no state between requests and never dies on a bad one — every
request is answered, so a checkout slot is always returned. SQLGlot is vendored, so there is no pip
dependency to resolve at runtime on a client VM.

The sidecar exists only because the best parser for this job is in another language. **The security
properties come from the AST, not from the process boundary.**

> **Alternative considered.** `node-sql-parser` runs in-process and removes the Python dependency
> entirely. Rejected: materially weaker dialect coverage, and no transpile — which we need, because
> read-dialect-in/write-dialect-out is what makes one policy definition work across ten source types.
> The sidecar's ops cost (pm2-managed children, vendored payload) is worth paying.

---

## The pipeline

Every agent query against a SQL-capable source passes through seven stages:

```
regex pre-check (in-process, existing sql-guard)
  → parse(read dialect)
  → Gate 1: SELECT-only allow-list        ← rejects anything that is not a read
  → pre-AST hooks                         ← per-dialect quirks SQLGlot doesn't model
  → Gate 2: inject policies               ← THE AUTHORIZATION SEAM
  → Gate 3: table allow-list              ← DORMANT: list is always empty, enforces nothing
  → enforce row cap                       ← bounded result, reported back
  → render(write dialect)
  → post-text hooks
```

Trusted system paths (schema introspection, entity grounding, health checks) never enter this pipeline
— see [Trusted paths](#trusted-paths).

---

## Gate 1 — reads only, structurally

After parsing, look for node types anywhere in the tree. This is a question about **structure**, not
spelling:

```python
FORBIDDEN = (exp.Insert, exp.Update, exp.Delete, exp.Merge, exp.Create, exp.Drop,
             exp.Alter, exp.TruncateTable, exp.Command, exp.Grant, exp.Into,
             # added after checking what our dialects actually parse to
             exp.Execute, exp.Copy, exp.Attach, exp.Detach, exp.Install,
             exp.Use, exp.Set, exp.Pragma)

if not req.get("allowWrites"):
    if root.find(*FORBIDDEN) is not None or not root.find(exp.Select):
        raise ValueError("query rejected — this source is READ-ONLY ...")
```

**The second row is ours, and it is not cosmetic.** The reference list was taken on faith and then
checked against the dialects we actually speak; three entries in it are live statement types on
sources we ship, and none is covered by `exp.Command`:

| Statement | Dialect | Parses to | Reference list |
|---|---|---|---|
| `EXEC sp_who` | tsql | `exp.Execute` | **missed** — the doc's own example claims `exp.Command` catches this; it does not |
| `COPY t FROM PROGRAM 'sh'` | postgres | `exp.Copy` | **missed** — command execution |
| `ATTACH 'x.db'` / `INSTALL httpfs` | duckdb | `exp.Attach` / `exp.Install` | **missed** — arbitrary file/db access |

None of these reached a database in practice, because our regex guard blocks the keywords and runs
first. But an AST gate that is weaker than the regex it is meant to supersede is not worth having,
and once the regex guard is the fallback rather than the primary, the gap would have become real.

### Table functions: a hole no node type closes

DuckDB reads the local filesystem through table functions, which parse as an ordinary `Select`:

```sql
SELECT * FROM read_csv('/etc/passwd')     -- exp.Select. Gate 1 sees nothing wrong.
```

Our `excel`, `csv` and `federation` sources all speak duckdb, and the regex guard never blocked this
either — so it is a **pre-existing hole**, not one the rewriter introduces. The worker carries an
explicit `FILE_FUNCTIONS` deny-list, matched on function *name* across every `exp.Func` node — SQLGlot
models some of these as dedicated nodes (`ReadCSV`, `ReadParquet`) and leaves the rest as `Anonymous`,
so matching on node type alone misses half of them.

A deny-list is the weaker construction — an allow-list of schema entities (Gate 3) would close this by
construction, without anyone maintaining a list of function names. Since Gate 3 is dormant and
unscheduled, **treat `FILE_FUNCTIONS` as the standing answer, not a stopgap**: a new DuckDB
file-reading function is a gap until someone adds its name here.

| Input | Verdict | Why it matters |
|---|---|---|
| `UPDATE customer SET name='x'` | REJECTED (`Update`) | The obvious case. |
| `SELECT * INTO tmp FROM customer` | REJECTED (`Into`) | Starts with SELECT, reads like a read — T-SQL `SELECT … INTO` **creates a table**. |
| `EXEC sp_who` | REJECTED (`Command`) | SQLGlot parses what it cannot model into a generic `Command`. If we cannot reason about a statement, we refuse it. |
| `SELECT id FROM customer; DROP TABLE customer` | REJECTED (`Drop`) | Stacked injection. The parse yields a block containing both; `find()` walks the whole tree. |

The last row is the point: protection is **tree traversal**, not statement splitting. Anything hidden
in a second statement, a subquery, or a CTE is still a node in the same tree.

### Relationship to the existing regex guard

`sql-guard.ts` is **not deleted**. It stays as an in-process pre-check, for two reasons:

- It is our degraded mode. If the sidecar is unavailable **and no policies apply**, we execute with
  regex enforcement only — today's behaviour — rather than taking a total outage. If policies **do**
  apply, we reject (see [Failure modes](#failure-modes)).
- `WriteMode` is imported by `sources/redis/command-guard.ts`; the module is load-bearing beyond SQL.

Its per-source `assertSqlAllowed()` call sites move (see [The seam](#the-seam)), but the checks remain.

Honest framing for reviewers: our regex guard already strips literals and comments, blocks `INTO`,
`EXEC` and multi-statement, so Gate 1 is a **modest** upgrade over it — `exp.Command` ("if we cannot
model it, we refuse it") is the real addition. **Gate 1 is not where our hole is. Gate 2 is.**

---

## Gate 2 — policy injection

This is what turns authorization from a *check* into a *transformation*. Rather than deciding whether
a query is permitted, we **make it permitted**: the caller's restrictions are added to the query as
predicates, server-side, and the agent never sees them.

### Policy shape

The reference implementation takes a raw SQL fragment — `{"table": "salesorder", "predicate":
"so.subsidiary IN (3,7)"}`. **We take a structured policy instead**, because ours is derived from
sa-api `users.config`, which is naturally column→values and has to apply across sources with
different table names:

```jsonc
{
  "sourceId": "mssql-722b94971107",

  // WHAT GETS SAID. A short noun phrase in the user's own language — this is
  // the ONLY thing the agent uses to describe the restriction, and it is
  // composed into component titles, the analysis and the method line, so it
  // must be a phrase rather than a sentence. Without it the agent is handed the
  // predicate and pastes "dw.FactSales.BranchFK IN (16, 22)" into the answer:
  // accurate, and meaningless to whoever reads it. Optional, warned about,
  // strongly recommended.
  "label": "North region branches",

  // WHAT GETS ENFORCED. Never shown to a user. A per-filter `label` overrides
  // the policy-level one, for a policy combining unrelated restrictions.
  "rowFilters": [
    { "table": "dw.FactSales", "column": "BranchFK", "op": "in", "values": [16, 22] },
    { "table": "dw.DimBranch", "column": "BranchFK", "op": "in", "values": [16, 22] }
  ],

  "readableTables": [],                          // Gate 3 is dormant — always empty
  "globalFilters": [],                           // last resort; see below

  // Behavioural guidance, folded into the system prompt (pre-existing).
  "prompt": "If asked about another region, say you lack access rather than querying it."
}

Both halves live in one object deliberately: the thing enforced and the thing
said about it must not be able to drift apart. Resolution order for the phrase
the agent sees is **per-filter label → policy label → raw predicate**, which
leaves room for a future automatic source (e.g. reverse-resolving an id through
the entity index) to slot in above the predicate without changing what an admin
writes.
```

Two reasons the structured form is not optional:

1. **Alias correctness.** The reference predicate hardcodes `so` — the alias the agent *happened* to
   choose. A query writing `FROM salesorder AS sales`, or no alias at all, gets a predicate referencing
   a nonexistent alias and errors out. We build the predicate at each injection site from that site's
   own alias.
2. **No string interpolation.** Policy values come from user attributes. Building `"col IN (" + values
   + ")"` makes the policy itself an injection surface. AST literals cannot be escaped out of.

### Injection

```python
def inject_policies(root, policies):
    for pol in policies:
        targets = []                                  # (select_node, alias) pairs
        for tbl in root.find_all(exp.Table):
            if not _table_matches(tbl, pol["table"]):
                continue
            if _is_cte_reference(tbl, root):          # CTE names are query-local, not real tables
                continue
            sel = tbl.find_ancestor(exp.Select)
            if sel is not None:
                targets.append((sel, tbl.alias_or_name))
            # NO break — see delta 1

        # Dedup on (select, alias), NOT on select alone: a self-join
        # `FROM t a JOIN t b` lives in ONE select and needs BOTH aliases
        # constrained, or half the join comes back unfiltered.
        seen = set()
        for sel, alias in targets:
            key = (id(sel), (alias or "").lower())
            if key in seen:
                continue
            seen.add(key)
            sel.where(_build_predicate(pol, alias), copy=False)
    return root


def _build_predicate(pol, alias):
    col = exp.column(pol["column"], table=alias)
    vals = [exp.Literal.number(v) if isinstance(v, (int, float))
            else exp.Literal.string(str(v)) for v in pol["values"]]
    return exp.In(this=col, expressions=vals)
```

`sel.where(...)` is an AST operation: it **AND**s into any existing `WHERE`, creating one if absent.
It cannot be escaped by the surrounding query text, because at the point it is applied it is not text.

### What it looks like on a real query

Input from the agent:

```sql
SELECT b.BranchName, SUM(f.NetSales) AS total
FROM dw.FactSales f
JOIN dw.DimBranch b ON b.BranchFK = f.BranchFK
WHERE f.FiscalYear = 2026
GROUP BY b.BranchName
```

The `WHERE` before and after injection:

```
before: WHERE f.FiscalYear = 2026
after : WHERE f.FiscalYear = 2026 AND f.BranchFK IN (16, 22) AND b.BranchFK IN (16, 22)
```

Note `f` and `b` — the aliases *the agent wrote*, resolved per site. And the rendered output, with the
cap applied in the target dialect's own syntax:

```sql
SELECT TOP 50 b.BranchName, SUM(f.NetSales) AS total
FROM dw.FactSales f
JOIN dw.DimBranch b ON b.BranchFK = f.BranchFK
WHERE f.FiscalYear = 2026 AND f.BranchFK IN (16, 22) AND b.BranchFK IN (16, 22)
GROUP BY b.BranchName
```

The agent asked for all branches. It received two. It was never told, and there is nothing it could
have written to avoid it — including writing its own contradictory `WHERE`, since ours is AND-ed on.

### Nesting

Injection targets a `Select` node, so it lands correctly regardless of nesting. Scoped policies use
`find_ancestor(exp.Select)` from the matched table, so a restriction on `dw.FactSales` attaches to the
sub-select that actually reads it, not to whichever `SELECT` happens to be outermost:

```
in : SELECT * FROM (SELECT BranchFK, NetSales FROM dw.FactSales) x
out: SELECT * FROM (SELECT BranchFK, NetSales FROM dw.FactSales WHERE BranchFK IN (16,22)) x
```

### Global filters are a last resort

`globalFilters` (no table) apply to root-level selects. Prefer table-scoped filters always:

- A global predicate on `SELECT SUM(x) FROM (SELECT …) t` errors when the column isn't projected by the
  subquery. That fails **closed**, so it is a UX problem rather than a security one — but it is still a
  failed query the user has to work around.
- The reference implementation targets `root.find(exp.Select)`, which is the *first* select — on a
  root-level `UNION`, one branch. Ours applies to all root-level selects (delta 5).

---

## Gate 3 — table allow-list  *(our addition — DORMANT)*

> **Status: the seam exists, nothing populates it, and populating it is deferred with no date.**
> `readableTables` is always `[]`, and an empty list returns on the first line — so Gate 3 currently
> enforces **nothing**. Do not read "we have a table allow-list" as "tables are restricted." It is
> 22 lines kept warm for the day Gate 2 turns out to need it, not a control that is running.

The reference design is **fail-open for tables it does not recognise**. If the policy names
`dw.FactSales` and the agent queries a view, a synonym, or a differently-named table holding the same
rows, no predicate is injected and the query executes unrestricted. Nothing rejects it. Gate 3 is the
answer to that, which is why the code stays even while dormant: without it, Gate 2 ships with a known
hole and no plan for it.

On the same AST walk we are already doing, collect every `exp.Table` and reject the query if any is
outside `readableTables`:

```python
def enforce_table_allowlist(root, readable):
    if not readable:
        return                                        # no allow-list configured → no-op
    allowed = {t.lower() for t in readable}
    cte_names = {c.alias_or_name.lower() for c in root.find_all(exp.CTE)}
    for tbl in root.find_all(exp.Table):
        name = _qualified_name(tbl).lower()
        if name in cte_names or name in allowed:
            continue
        raise ValueError(f"query rejected — table '{name}' is not readable by this user")
```

This converts the default from fail-open to fail-closed for one extra traversal. CTE names are excluded
because they are query-local aliases, not real tables.

### Why it is not populated

Deferred deliberately: the machinery to populate it is a project, and none of it is needed until
policies exist. For the record, so it does not have to be re-derived later — the options were:

| Source | Verdict |
|---|---|
| Hand-authored per user in `users.config` | Unmaintainable. Large sources run 500+ tables and every schema change breaks the list. |
| Derived from `SourceSchema.entities` | The right default if this is ever built. The agent can only query what it was shown, and the extracted schema *is* that set — so it costs an admin nothing and stays correct as schemas change. Needs no identity and no policy, since it is not per-user. |
| Per-user deny-list layered on the derived list | The only part worth authoring by hand, and it is small. |

**The blocker if it is revived:** all three SQL extractors filter to base tables —
`postgres/instance.ts:147`, `mysql/instance.ts:110,134`, `mssql/instance.ts:366,390` all carry
`TABLE_TYPE = 'BASE TABLE'`. **Views are absent from the extracted schema.** That is mostly
self-consistent (the agent cannot query what it was never shown), but two paths put a table name in
front of the agent without going through the schema: KB nodes and the semantic model can name a view
outright, and existing script recipes may already reference one. So a derived list could not be
switched straight to enforcing — it would need its own log-only bake first, exactly like Phase 1's.

---

## The row cap

`enforce_cap` takes the smaller of the caller's own limit and the system maximum and injects it into
the AST. It is a no-op for aggregations.

One property, learned the hard way, is worth stating: **a cap applied silently is indistinguishable,
to the caller, from "that is all the data."** A program that pages through rows and stops when a page
comes back short concludes it has read everything, then reports a truncated count as a total — a
confidently wrong answer.

So the worker returns what it injected, and the manager reports it when the result actually reached
the limit:

```jsonc
{ "rows": [...], "sql": "...", "cappedTo": 50,
  "notes": ["Row limit 50 was applied and there is more data beyond it: these are the FIRST 50 rows,
             not the full result. Aggregate in the query (COUNT/SUM/GROUP BY) for totals, or narrow
             it with a filter."] }
```

Detection is **exact rather than inferred**: request `cap + 1` rows and return `cap`. If the extra row
comes back there is genuinely more data; if it does not, the result is complete — including when it
lands precisely on the cap.

One contract deviation from the reference implementation: **the worker does the `+1`, not the caller.**
The reference passes `maxRows: 5001` and answers `cappedTo: 5000`, leaving the caller to remember the
off-by-one. Ours takes `maxRows` as the true cap and returns both `cappedTo` (the cap) and
`probeLimit` (what was injected). Same mechanism, one less thing for a caller to get wrong.

### Three existing mechanisms to reconcile

We currently cap in three places, all of which this replaces or demotes:

| Today | Where | Disposition |
|---|---|---|
| `ensureQueryLimit()` text-rewrites a `LIMIT`/`TOP` in | `source-agent.ts:216`, `tool-executor-service.ts:168`, `component-props-processor.ts:216` | **Replaced** by the AST cap |
| Prompt tells the agent to write its own limit | `agent-source-query/system.md:24-25` | **Demoted** to a hint; no longer load-bearing |
| Post-execution array slice | `base-source.ts:263` | **Replaced** by the cap+1 probe — this is the silent-cap bug above |

Our caps are much smaller than the reference implementation's 5000: `MAX_AGENT_QUERY_LIMIT` is 10,
`MAX_ROWS_FETCHED` 50, `MAX_COMPONENT_QUERY_LIMIT` 250 (`sdk-nodejs/src/userResponse/constants.ts`).
The cap is therefore **per-call**, passed in the request, not a single system constant.

---

## Deltas from the reference implementation

Taken unchanged: sidecar architecture, worker-pool lifecycle, vendoring, pipeline shape, and the
cap+1 probe mechanism.

| | Reference | Ours | Severity |
|---|---|---|---|
| 1. Scoped injection | first name match, then `break` | every match, deduped by (select, **alias**) | **blocking** |
| 2. Predicate | SQL text with hardcoded alias | AST built per-site from `alias_or_name` + typed literals | **blocking** |
| 3. Unknown tables | pass through unrestricted | Gate 3 allow-list — built but **dormant** | blocking *when Gate 2 goes live* |
| 4. Table matching | bare `tbl.name` | schema-qualified, bare-name fallback | correctness |
| 5. Global policies | first `Select` only | all root selects; table-scoped preferred | correctness |
| 6. Sidecar failure | unspecified | reject when policies non-empty | correctness |
| 7. Trusted path | `{raw:true}` request flag | structural — `transport.query()` vs `execute()` | hardening |
| 8. Policy input | `{table, predicate}` | `{sourceId, rowFilters[], readableTables[]}` | fit |
| 9. Dialects | suiteql/oracle | per-`SourceType` map incl. duckdb | fit |
| 10. Seam | one call site | 8 per-source guard calls consolidated into `BaseSource` | fit |
| 11. Gate 1 node list | 11 types | + `Execute`/`Copy`/`Attach`/`Detach`/`Install`/`Use`/`Set`/`Pragma` | **blocking** |
| 12. Table functions | not addressed | duckdb `FILE_FUNCTIONS` deny-list | **blocking** |
| 13. Cap contract | caller passes `cap+1` | worker does the `+1`; returns `cappedTo` and `probeLimit` | fit |

Deltas 11 and 12 were found during implementation by checking what our dialects actually parse to,
rather than trusting the reference list — see [Gate 1](#gate-1--reads-only-structurally). Both are
blocking for the same reason as 1–3: each is a statement that reaches the database unexamined.

### 1. The `break` is a bypass

```python
for tbl in root.find_all(exp.Table):
    if (tbl.name or "").lower() == str(table).lower():
        sel = tbl.find_ancestor(exp.Select)
        if sel is not None:
            sel.where(pred, copy=False)
        break                                   # ← at the name-match level, not the injection level
```

- `SELECT … FROM salesorder a UNION ALL SELECT … FROM salesorder b` — only branch `a` is filtered.
- `FROM salesorder s1 JOIN salesorder s2` — only `s1`.
- If `find_ancestor` returns `None` on the first match, it breaks having injected **nothing at all**,
  and the query runs completely unfiltered.

### 4. Schema-qualified matching

`tbl.name` is the bare name, so a policy on `customer` matches `dbo.customer`, `staging.customer` and
`archive.customer` alike. With the bluelinx `dw.*` schemas sitting alongside others, that mis-fires in
both directions — filtering a table that shouldn't be, and treating two different tables as one. Match
on `db.schema.table`, falling back to bare-name only when the policy itself is unqualified.

---

## The seam

*(Built. Kept in the past tense below because the reasoning is what matters for the next port.)*

`assertSqlAllowed()` / `assertReadOnlySql()` was called separately inside each source's
`execute()` — eight call sites to keep in sync:

```
backend/src/sources/postgres/instance.ts:625     mssql/instance.ts:928
backend/src/sources/mysql/instance.ts:592        netsuite/instance.ts:623
backend/src/sources/dynamodb/instance.ts:284     excel/instance.ts:574
backend/src/sources/csv/instance.ts:764          federation/instance.ts:443
```

The rewrite moved into `BaseSource.prepareSql()` so there is **one** seam; the per-source calls became
a dialect declaration instead of a guard. `prepareSql()` runs the regex guard, resolves the caller's
policies from the request context (`policy-gate.ts`), then rewrites.

That seam genuinely covers every flow. All of these reach `BaseSource.getTool().fn` → `this.execute()`:

- `MainAgent` / `SourceAgent` (`sdk-nodejs/src/userResponse/agents/`)
- the script flow — `script-runner.ts:541` `resolveAuthorizedTool()` resolves to the same
  `ExternalTool.fn`, so a script that concatenates SQL at runtime inside its subprocess still lands here
- `dashComp` and `reportComp`

### Trusted paths

The reference implementation carves out schema introspection and entity grounding with a `{raw:true}`
request flag. **We do not port that flag.** Our internal paths already call `this.transport.query()`
directly and never go through `execute()` — e.g. `postgres/instance.ts:120,138,155,424,511`. `execute()`
is the only thing agents can reach.

This is strictly better than a flag: there is no parameter an agent could ever set to reach the raw
path. For the same reason we do **not** port `allowWrites` as a request field — write capability stays
sourced from trusted server-side source config via `getWriteMode()` (`base-source.ts:189`), as it is
today.

### Dialect map

| SourceType | read | write | Notes |
|---|---|---|---|
| `postgres` | `postgres` | `postgres` | |
| `mysql` | `mysql` | `mysql` | |
| `mssql` | `tsql` | `tsql` | Cap renders as `TOP`, not `LIMIT` |
| `netsuite` | `oracle` | `oracle` | SuiteQL is Oracle-ish; the reference impl runs this pairing |
| `excel`, `csv` | `duckdb` | `duckdb` | In-memory DuckDB tables, one per sheet/file |
| federation | `duckdb` | `duckdb` | Internal type, not in `SourceType` |
| `dynamodb` | — | — | **PartiQL — no SQLGlot dialect.** See below |
| `redis`, `rest_api`, `graphql` | — | — | Not SQL; out of scope |

`dynamodb` currently passes through `assertSqlAllowed` (`instance.ts:284`) because PartiQL DML shares
the `INSERT`/`UPDATE`/`DELETE` leading keywords. SQLGlot has no PartiQL dialect, and DynamoDB
additionally rejects clauses the rewriter would inject (`stripUnsupportedClauses` at
`instance.ts:287` already strips `LIMIT`/`ORDER BY` and applies them client-side). **DynamoDB stays on
the regex guard and takes no policies** until this is validated separately. Do not let "we did SQL
authorization" read as "DynamoDB is authorized."

---

## Failure modes

| Condition | Behaviour |
|---|---|
| Regex pre-check rejects | Reject. Never reaches the parser. |
| Parse error | Reject. An unparseable query cannot be reasoned about. |
| Gate 1 finds a forbidden node | Reject. |
| Gate 3 finds a table outside the allow-list | Reject, naming the table. *Unreachable today — the list is always empty.* |
| Policy references a table the query never touches | No-op. Not an error — most queries touch a subset. |
| Sidecar unavailable, **policies empty** | Execute with regex guard only. Log a warning. Availability over strictness where there is no policy to violate. |
| Sidecar unavailable, **policies non-empty** | **Reject.** Never execute unfiltered. |
| Retry-once on a dead worker | As reference implementation; the rule above applies after it gives up. |

The distinction in the last two rows is the one to get right in review: a sidecar outage must degrade
to *today's* behaviour for unpoliced clients and to *no service* for policed ones — never to
unrestricted reads.

---

## Audit output

The worker already returns the rendered SQL. Log per execution:

```
(userId, policyVersion, sourceId, policiesApplied[], renderedSql, rowCount, cappedTo)
```

Nearly free once the rewrite is a single seam, and it is the evidence artifact the ISO 27001 / VAPT
track needs (`VAPT-REMEDIATION-TRACKER.md`).

---

## Out of scope

Named explicitly so nobody reads a narrower guarantee as a broader one.

- **Identity plumbing** — now largely built; see the Prerequisite table above and
  `REQUEST-CONTEXT-DESIGN.md`. Two gaps remain (policy resolution, stripping a client-supplied
  `authContext`).
- **Non-SQL sources** — `redis` (has `command-guard.ts`), `rest_api`, `graphql`, and `dynamodb` need
  their own predicate equivalents. Nothing here touches them.
- **Cache and reuse scoping — partly closed.** Because the rewriter fires at execution, a *replayed*
  script is re-filtered for the new user, which is the good case. The **script-bridge** cache was not:
  its key had no principal and was computed on pre-rewrite SQL, so one user's filtered rows would be
  served to another for the TTL. That one is fixed (policy-scope hash in the key). Two remain:
  - `sdk-nodejs`'s `queryCache` returns stored rows with no re-execution.
  - `ScriptStore.search({prompt, projectId})` (`script-store.ts:267`) can surface another user's
    recipe whose narrative and component titles were authored under a different scope.

  Both still need a `scopeKey`. **A cache is the cheapest way to bypass every gate in this
  document** — it answers without executing, so nothing in the pipeline is consulted. Audit the
  caches before enabling enforcement, not after.
- **Entity resolution** — `data_source_index` resolves and names out-of-scope entities before any SQL
  is authored. Separate work.
- **Feature-level RBAC** — "can this user create dashboards / export / see admin" is ordinary role
  checks on sa-api and backend routes. It should never touch the LLM or this pipeline.

---

## Implementation plan

### Phase 1 — rewriter, no policies  *(BUILT)*

The pipeline runs with `policies: []` and `readableTables: []`, in shadow mode. Nothing about which
rows come back changes; the point is to prove parse/render fidelity against real traffic before
anything depends on it.

| File | Role |
|---|---|
| `backend/sqlrewrite/worker.py` | parse, Gate 1, `inject_policies`, `enforce_table_allowlist`, `enforce_cap`, render |
| `backend/sqlrewrite/hooks.py` | per-dialect escape hatches, pre-AST and post-text (empty by design) |
| `backend/sqlrewrite/vendor/sqlglot/` | SQLGlot 30.17.0, vendored — 3.2 MB, pure Python, no pip at runtime |
| `backend/sqlrewrite/test_worker.py` | 51 cases; `python3 test_worker.py`, no dependencies |
| `backend/sqlrewrite/_smoke.ts` | end-to-end Node→Python check; `npx ts-node sqlrewrite/_smoke.ts` |
| `backend/src/sources/core/sqlglot-pool.ts` | process lifecycle only: checkout, idle reaping, retry-once, kill-on-exit |
| `backend/src/sources/core/sql-rewrite.ts` | the policy of *using* the rewriter: dialect map, modes, fail-closed rules |
| `backend/src/sources/core/base-source.ts` | `prepareSql()` — the seam |

The eight guard call sites now route through `prepareSql()` (federation calls `rewriteSql()` directly,
since it does not extend `BaseSource`). The regex guard moved inside `prepareSql` and still runs first.

**Deliberately not wired yet:** `prepareSql()` passes no `maxRows`. The cap is Phase 4, and turning it
on early would make Phase 1 a behaviour change rather than a fidelity test.

#### Operating it

| Env var | Default | Meaning |
|---|---|---|
| `SA_SQL_REWRITE_MODE` | `shadow` | `off` \| `shadow` (rewrite, log the diff, run the original) \| `enforce` (run the rewrite) |
| `SA_SQL_REWRITE_PYTHON` | `python3` | Interpreter for the worker |
| `SA_SQL_REWRITE_POOL_SIZE` | `2` | Long-lived workers |
| `SA_SQL_REWRITE_TIMEOUT_MS` | `5000` | Per-request deadline; a worker that misses it is retired, not trusted |
| `SA_SQL_REWRITE_IDLE_MS` | `300000` | Idle reaping |

Two behaviours worth knowing before reading logs:

- **A refusal holds in shadow mode.** Shadow mode de-risks *re-rendering*, not the decision that a
  statement is unsafe — a `DROP` is rejected in every mode. Only the rewritten SQL is discarded.
- **The rewriter self-disables** after 5 consecutive unavailability errors *when no policies are
  configured*, so a VM without Python logs once rather than per query. With policies configured it
  never self-disables; every query fails loudly instead.

**Exit criterion:** shadow mode over a week of real queries with no `[sqlrewrite:shadow] rewrite
differs` line that represents a semantic change, and no parse failures. Grep that prefix; each hit
needs eyeballing before `enforce` is safe.

### Phase 2 — policies  *(identity plumbing BUILT; policy resolution outstanding)*

Done:

- **Request context carrying identity to the seam** — `REQUEST-CONTEXT-DESIGN.md`. Not optional and
  not small: the script flow crosses a process boundary and an HTTP hop, so no single ambient
  mechanism reaches every path; that one needs an explicit token.
- **DO stamping + schema declaration**, so the identity at the seam can come from a verified session
  rather than the payload.
- **`runAsSystem()` at the seven non-user call sites**, so a trusted job is distinguishable from an
  identity that went missing.
- **`prepareSql()` reads its policies from the context** instead of a hardcoded `[]`, gated by
  `SA_SQL_REWRITE_MODE` (see below).
- **The script-bridge cache bypass is fixed.** Its key was `(toolId, sql, limit)` with no principal,
  computed on the PRE-rewrite SQL — so one user's filtered rows would have been served to another for
  the 10-minute TTL, with the rewriter never consulted. The key now carries a policy-scope hash.

Outstanding:

- **Policy resolution from `users.config`**, server-side, keyed on the verified identity. The admin
  surface already exists — `sa-platform-ui/src/components/projects/ManageMembersDialog.tsx` edits a
  per-member `config` JSON. This is giving that free-text field a schema and a resolver, not building
  a UI.
- **Populate `rowFilters`**; `readableTables` stays empty (Gate 3 is dormant).
- **Audit log** — `(userId, policyVersion, sourceId, policiesApplied[], renderedSql, rowCount)`.
- **Strip client-supplied `authContext` at the relay** before any of this is relied on.

#### The two switches, and the order to turn them on

One switch, three values:

| `SA_SQL_REWRITE_MODE` | Behaviour |
|---|---|
| `off` | the rewriter is never consulted |
| `shadow` **(default)** | parse, rewrite, log the diff; execute the ORIGINAL; never refuse for policy reasons |
| `enforce` | execute the rewrite, apply policies, and refuse any query arriving with no request context |

There was briefly a second variable, `SA_SQL_POLICY_ENFORCE`. It is **retired and
ignored** (setting it logs a warning). The two were not independent axes: of six
combinations one was nonsense, one was a footgun, and one caused a live bug —
blocking queries in shadow mode, which injects nothing and so had nothing to
protect. Refusing a contextless query only means something where policies are
applied, so it belongs inside `enforce`.

`enforce` is not safe to flip yet. Under `shadow` the gate logs `[policy-gate] anonymous query` lines
naming each uninstrumented call path — that log is the prerequisite checklist for turning it on, and
the only way to find paths this design did not anticipate before they become outages.

### Phase 3 — allow-list  *(NOT PLANNED)*

Deliberately unscheduled. The population machinery is a project of its own, and nothing needs it until
Phase 2 is live and shows a real fail-open case in practice — a query that reads restricted rows
through a table the row filters do not name. Revisit then, not before; the code is already in place
and [Why it is not populated](#why-it-is-not-populated) records the options and the blocker so this
does not have to be re-derived.

### Phase 4 — cap reconciliation

- Adopt the cap+1 probe, remove the silent slice at `base-source.ts:263`
- Retire `ensureQueryLimit()` from the three call sites
- Soften the prompt's row-limit rules to a hint

---

## Test plan

Adversarial cases, all of which must be covered before Phase 2 ships. Every one of these is a way a
policy silently fails to apply.

**Gate 1**

- `UPDATE`, `DELETE`, `MERGE`, `DROP` — rejected
- `SELECT * INTO tmp FROM t` — rejected (`Into`)
- `EXEC sp_who` — rejected (`Command`)
- `SELECT 1; DROP TABLE t` — rejected via tree traversal, not statement splitting
- `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x` — rejected

**Gate 2 — injection completeness**

- `UNION ALL` with the policy table in **both** branches → predicate in both *(delta 1)*
- Self-join `FROM t a JOIN t b` → predicate on both aliases *(delta 1)*
- Table in a sub-select with no `Select` ancestor at the first match → still injects on later matches *(delta 1)*
- No alias at all → predicate uses the bare table name *(delta 2)*
- Unusual alias (`FROM dw.FactSales AS whatever`) → predicate uses `whatever` *(delta 2)*
- Existing `WHERE` → AND-ed, not replaced
- Agent writes a contradictory predicate on the policy column → both present, AND-ed, result empty
- Nested sub-select → predicate lands on the inner select, not the outer
- CTE whose alias collides with a policy table name → not treated as the real table *(delta 4)*
- `dbo.customer` vs `staging.customer` with a policy on `dbo.customer` → only the former filtered *(delta 4)*
- String-valued policy (`region IN ('North','South')`) → typed as string literals, not numbers
- Policy value containing a quote → no escape from the literal *(delta 2)*

**Gate 3** *(dormant — these pass, but only the last one exercises how the gate actually runs today)*

- Query touching a table outside `readableTables` → rejected
- Query whose only non-allow-listed name is a CTE → allowed
- Unqualified reference matching a qualified allow-list entry → allowed
- **Empty `readableTables` → no-op, not a blanket reject** ← the live behaviour

**Cap**

- Aggregation → no cap injected
- Exactly `cap` rows available → no truncation note (the cap+1 probe returns nothing extra)
- `cap + 1` rows available → note present
- MSSQL renders `TOP`, postgres/duckdb render `LIMIT`

**Failure modes**

- Sidecar killed mid-flight, policies empty → query executes, warning logged
- Sidecar killed mid-flight, policies non-empty → query rejected
- Unparseable SQL → rejected

**Cross-flow**

The same policy must apply identically when the query originates from `SourceAgent`, from a replayed
script (`script-runner.ts:541`), from `dashComp`, and from `reportComp` — one test per entry point,
asserting on the rendered SQL from the audit log.
