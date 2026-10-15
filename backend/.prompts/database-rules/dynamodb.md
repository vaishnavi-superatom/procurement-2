# DynamoDB (PartiQL) - Query Rules

DynamoDB is a **NoSQL key-value / document store**, queried here with **PartiQL**.
It is NOT a relational database. Most SQL you know does NOT apply. Read these rules
before writing any statement.

## CRITICAL ERRORS (Query Will Fail)

### 1. No JOIN, GROUP BY, HAVING, or aggregate functions
DynamoDB PartiQL has **no `JOIN`, no `GROUP BY`, no `HAVING`, and no aggregate
functions** (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`). Writing any of them fails.

**Invalid:**
- `SELECT COUNT(*) FROM "T"` — aggregates are not supported
- `SELECT deviceId, AVG(batteryPercentage) FROM "T" GROUP BY deviceId` — no GROUP BY
- `SELECT * FROM "A" JOIN "B" ON ...` — no JOIN

**Solution:** To answer an analytics question (totals, averages, counts, rankings,
group-by), **SELECT the rows you need — filtered by the partition key — and let the
calling script compute the aggregation in code.** Do not try to aggregate in the query.

### 2. No LIKE, no DISTINCT, no subqueries, no arithmetic/functions in SELECT
**Invalid:**
- `WHERE pk LIKE '%abc%'` — `LIKE` is not supported. Use `begins_with(attr, 'abc')` or `contains(attr, 'abc')`.
- `SELECT DISTINCT ...` — not supported.
- `SELECT col * 2 FROM "T"` / `SELECT NOW()` / `SELECT DATE_TRUNC(...)` — no expressions or SQL functions in the projection.

### 3. Table names MUST be double-quoted
`SELECT * FROM "BROKEN_UNI_1_DATA" WHERE ...` — always wrap the table name in double
quotes.

### 3a. Reserved-word attributes MUST be double-quoted (very common error)
DynamoDB PartiQL has reserved keywords. If an **attribute name** you SELECT or filter on
is a reserved word, you MUST wrap it in double quotes, or the query fails with
**"Statement wasn't well formed, can't be processed: Unexpected keyword."**

Common reserved words that appear as attributes here: **`timestamp`**, `status`, `count`,
`source`, `interval`, `name`, `type`, `data`, `value`, `size`, `date`, `year`.

**Invalid (fails):**
- `SELECT timestamp, batteryPercentage FROM "T" WHERE pk = '...'` — `timestamp` is reserved

**Valid:**
- `SELECT "timestamp", batteryPercentage FROM "T" WHERE pk = '...'` — reserved word quoted
- Prefer selecting the **sort key `sk`** for time (it holds the timestamp and is NOT reserved), or `SELECT *`.
- When unsure, double-quote the attribute name — quoting a non-reserved attribute is harmless.

If you hit "Unexpected keyword", double-quote every attribute in the SELECT/WHERE and retry.

### 4. Always filter by the partition key (pk) for a specific entity
A `WHERE` that pins the partition key with `=` is an efficient internal Query. A query
**without** the partition key is a **full-table Scan** — slow, costly, and capped by the
connector (you will get a `truncated` result on large tables).

**Prefer:** `WHERE pk = '<exact partition key value>'`
Add a sort-key condition to narrow further: `AND sk BETWEEN '<start>' AND '<end>'`.

**The pk value MUST identify the entity in the user's question / conversation — NEVER copy a
sample value from the schema.** Sample values (e.g. a `pk` like `packets_3cdc75441ea0`) are
illustrative examples of the *format*, not the target. If the user asks about device
`e8f60aab68b4`, the pk is `packets_e8f60aab68b4` — build it from the id in the question, not
from a sample. Using a sample value returns another entity's data (a silent wrong answer).

## REQUIRED PATTERNS

### Row limit & ordering (IMPORTANT — different from real SQL)
DynamoDB itself rejects a `LIMIT` clause and an `ORDER BY` clause inside a statement.
**This tool applies them for you**, so you MAY — and should — still write them:
- `LIMIT n` caps the rows (the connector enforces it).
- `ORDER BY <sortKey> DESC|ASC` orders the rows (the connector sorts them).

**Only order by the sort key** (e.g. `sk`), and **always include a `pk =` filter when you
order**, so the set being ordered is a single bounded partition.

Most-recent-N for one device:
```
SELECT * FROM "BROKEN_UNI_1_DATA" WHERE pk = '<pk value>' ORDER BY sk DESC LIMIT 10
```

**For "recent" / "latest" / "last N" questions, order by `sk DESC`** (newest first). Do NOT
order by a timestamp *attribute* ASC — `ASC` returns the OLDEST rows in the table, which is
almost never what "recent/latest/trend" means.

### Time windows — "last N days / hours" (CRITICAL)
A "last 7 days" (or "yesterday", "past month") question MUST be bounded by the sort key —
otherwise you get an arbitrary slice (often the oldest data) and the time window is ignored:
```
WHERE pk = '<pk value>' AND sk BETWEEN '<start-epoch>' AND '<end-epoch>'
```
- The sort key here holds an **epoch timestamp stored as a string** — check its sample values
  for the unit (this table's `sk` is epoch **seconds**, e.g. `1764398270`; others use millis).
- You do NOT know the current time — so **the calling SCRIPT must compute the bounds in JS**
  (e.g. `const now = Math.floor(Date.now()/1000); const start = now - 7*86400;`) and pass them
  into the query. Do not hardcode dates.
- High-frequency telemetry (e.g. 10s interval) produces tens of thousands of rows per week —
  more than the connector's fetch cap. For a multi-day *trend*, fetch the bounded window and
  **downsample/aggregate in the script** (e.g. average per hour/day); expect `truncated` if the
  window is too dense.

### Filtering
```
WHERE pk = '<pk value>' AND kind = 'EVENT'
WHERE pk = '<pk value>' AND charging = true
WHERE pk = '<pk value>' AND begins_with(sk, '17758')
```

## SYNTAX REFERENCE

| Feature | DynamoDB PartiQL |
|---------|------------------|
| Table name | `FROM "TableName"` — always double-quoted |
| Row limit | `... LIMIT n` (applied by this tool, not by DynamoDB) |
| Ordering | `... ORDER BY sortKey DESC` (applied by this tool; sort key only) |
| Equality / compare | `=`, `<>`, `<`, `<=`, `>`, `>=` |
| Set / range | `IN (...)`, `BETWEEN a AND b` |
| Logic | `AND`, `OR`, `NOT` |
| Prefix match | `begins_with(attr, 'prefix')` |
| Substring match | `contains(attr, 'text')` — NOT `LIKE` |
| Existence | `attribute_exists(attr)`, `attribute_not_exists(attr)` |
| Boolean | `true`, `false` — lowercase, no quotes |
| String literal | `'value'` — single quotes, escape as `''` |
| Nested attribute | `attr.subfield` or `attr[0]` (map/list access) |

## COMMON PITFALLS

1. **No partition key = full-table scan.** For a specific device/entity, always pin `pk = '...'`. Scans on large tables are capped and return `truncated`.
2. **`LIKE` does not exist** — use `begins_with()` or `contains()`.
3. **No aggregates/GROUP BY** — fetch the rows (pk-scoped) and aggregate in the calling script.
4. **Sort key is a string** — quote timestamp comparisons and use full-width epoch-millis (`'1775878147000'`), not integers.
5. **Order only by the sort key**, and only alongside a `pk =` filter.
6. **Items are heterogeneous** — different items may have different attributes; do not assume every attribute exists on every row.
7. **Double-quote table names**, single-quote string values.
