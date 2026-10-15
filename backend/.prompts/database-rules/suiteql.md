# SuiteQL (NetSuite) - Query Rules

SuiteQL is NetSuite's own query language, with its own rules. Do not assume behavior carries over from
anywhere else — read these rules before writing a query.

## CRITICAL ERRORS (Query Will Fail)

### 1. No `LIMIT` keyword; `TOP` exists but is banned here — see Row Limits below
`LIMIT` is not real SuiteQL syntax (that's Postgres/MySQL). `TOP n` IS real, working SuiteQL — but
NetSuite evaluates the full result set before truncating it, so it's slow on large tables, and this tool
routes all limiting through one path. SuiteQL's real paginated-fetch syntax is `FETCH FIRST n ROWS ONLY` /
`OFFSET m ROWS FETCH NEXT n ROWS ONLY` — don't write that either. See **Row Limits** below: write
`LIMIT n` regardless of all of this, and the tool converts it.

### 2. No `ILIKE`
There is no `ILIKE` operator, and plain `LIKE` is case-sensitive. Use `UPPER(col) LIKE UPPER('%text%')`
for case-insensitive matching instead.

### 3. Booleans are text, not real booleans
Boolean-looking fields (`isinactive`, `emailtransactions`, etc.) store the literal strings `'T'` / `'F'`,
not `true`/`false`. Compare with `= 'T'` / `= 'F'`, never `= true`.

### 4. `CAST(...)` does not work — never write it, of any target type
`CAST(col AS NUMBER)`, `AS DECIMAL`, `AS FLOAT`, `AS DOUBLE`, `AS INTEGER` all fail, even a bare
`SELECT CAST(col AS ...)` with no aggregate at all. Numeric-looking fields (`total`, `amountremaining`,
etc.) are typed as TEXT in the schema but work directly in arithmetic, comparisons, and aggregates with
no cast at all: `SUM(total)`, `AVG(total)`, `total > 100`, `total - taxtotal`. Just use the column bare.

### 5. Only the searched `CASE WHEN` form works — not the simple `CASE column WHEN value` form
`CASE WHEN custentity_status_code = '1' THEN 'Red' WHEN custentity_status_code = '2' THEN 'Amber'
ELSE 'Unknown' END` works. `CASE custentity_status_code WHEN '1' THEN 'Red' WHEN '2' THEN 'Amber'
ELSE 'Unknown' END` — otherwise equivalent, valid SQL elsewhere — fails. Always write the condition out
in full on each `WHEN` line; never write a bare value after `WHEN`.

### 6. `ORDER BY COUNT(*)` (or its alias) fails — `COUNT(column)` and `SUM(...)` are both fine
`SELECT x, COUNT(*) AS n FROM t GROUP BY x ORDER BY n DESC` fails, whether written as the alias or spelled
out raw (`ORDER BY COUNT(*) DESC`), on any table, joined or not. The fix is simply to count a specific
column instead of using the asterisk form: `COUNT(id)` (or any real column) works fine in `ORDER BY`, and
so does `SUM(...)`, `AVG(...)`, etc. — this is specific to the `COUNT(*)` asterisk form, not aggregates
in general. Prefer `COUNT(id)` over `COUNT(*)` whenever the result needs to be ordered.

### 7. A specific list of common SQL functions fail here — substitute before writing, not after failing
These are the functions an LLM reaches for by default; each has a working SuiteQL equivalent:

| Don't use (fails) | Use instead |
|---|---|
| `SUBSTRING(str, pos, len)` | `SUBSTR(str, pos, len)` |
| `LEFT(str, n)` | `SUBSTR(str, 1, n)` |
| `RIGHT(str, n)` | `SUBSTR(str, -n)` |
| `CHARINDEX(...)` / `LOCATE(...)` / `POSITION(...)` | `INSTR(...)` |
| `UCASE(...)` | `UPPER(...)` |
| `LCASE(...)` | `LOWER(...)` |
| `CEILING(...)` | `CEIL(...)` |
| `CHAR_LENGTH(...)` / `CHARACTER_LENGTH(...)` / `BIT_LENGTH(...)` | `LENGTH(...)` |
| `STRING_AGG(...)` | `LISTAGG(...)` — works on this account, but `LISTAGG(DISTINCT ...)` does NOT actually dedupe (confirmed live) — dedupe in code instead |
| `DATEDIFF`, `REPEAT`, `CONVERT`, `CHAR`, `COT`, `BIT_XOR_AGG` | no equivalent — avoid entirely |

### 8. `!= ''` / `<> ''` always returns zero rows — never pair it with `IS NOT NULL`
This engine treats an empty string as NULL, so `col != ''` silently becomes `col != NULL`, which is never
true for any row. Confirmed live: even `entityid != ''` — on a column that's never blank — returns 0 rows.
`col IS NOT NULL` alone is already the complete "populated" check; adding `AND col != ''` on top doesn't
tighten it, it zeroes out the whole result.

### 9. `TO_DATE(...)` on a text-stored date silently returns no rows — never rely on it
Many date-looking fields (commonly `DD/MM/YYYY`) are stored as TEXT, not a native date — see Common
Pitfall 4. Wrapping one in `TO_DATE(col, 'DD/MM/YYYY')` to range-filter it looks reasonable but doesn't
work: it doesn't error, it just silently fails to match, so the query quietly returns zero rows instead of
warning you. There is no working SQL-side conversion for these fields — fetch the rows with the field
populated, then parse the text and apply the date range filter in code.

### 10. `ORDER BY <expr> DESC` sorts NULLs FIRST — a "top N" query silently returns the wrong rows
This engine's default is the opposite of what most people assume: descending order puts NULL values at
the very top, not the bottom. If the sorted column can be NULL — including a computed expression like
`total_budget - actual_consumed`, which is NULL whenever either operand is NULL — a plain
`ORDER BY remaining DESC LIMIT 10` returns the 10 rows where the value is *undefined*, not the 10 largest
real values. It doesn't error, so this fails silently. Confirmed live: a "top 10 Red projects by remaining
budget" query returned 10 projects with NULL remaining budget, burying every project with a real, known
value further down the result. Always add `NULLS LAST` on a descending sort of any nullable or computed
column, and prefer filtering out rows where the sorted expression can't be computed
(`WHERE total_budget IS NOT NULL AND actual_consumed IS NOT NULL`) when "top N" should only rank projects
with known values.

### 11. Grouping/sorting by a `MM/YYYY`-extracted month string sorts by month, not chronologically
When you extract a "month" bucket from a `DD/MM/YYYY` text date (e.g. `SUBSTR(datecreated, 4, 7)` to get
`"MM/YYYY"`) and then `ORDER BY` that string, it sorts lexicographically on the string — which means by
the MONTH digit first, YEAR second, not by true chronological order. Confirmed live: `ORDER BY month DESC`
on a `MM/YYYY` string put every December from 2016 through 2025 at the very top, ahead of far more recent
months like March 2026, because `"12/..."` is lexicographically the largest month prefix regardless of
year. This doesn't error, so it fails silently, and under a `LIMIT` it can truncate to the wrong rows
entirely (keeping only high-month-digit years, dropping real recent low-month-digit data). Day and month
are not zero-padded in these fields, so a fixed-position `SUBSTR` also risks slicing the wrong characters
out of a short date — locate the `/` separators instead and zero-pad each part. Always build the sortable
key year-first: `LPAD(SUBSTR(datecreated, INSTR(datecreated,'/',1,2)+1), 4, '0') || '-' || LPAD(SUBSTR(datecreated, INSTR(datecreated,'/')+1, INSTR(datecreated,'/',1,2)-INSTR(datecreated,'/')-1), 2, '0')`
(`YYYY-MM`) — so lexicographic order matches chronological order, or skip SQL-side ordering of month buckets
entirely and sort in code after parsing.

### 12. `>=`/`<=` on a text-stored date compares characters, not dates — reorder before comparing, or filter in code
Comparing a `DD/MM/YYYY` text field directly against a literal date string (`col >= '02/08/2026' AND col <=
'02/11/2026'`) does not error and does not raise a warning — it silently does character-by-character string
comparison. Because DAY comes first in the text, a genuinely in-range date whose day digit sorts "high"
(e.g. `15/09/2026`) can compare as greater than an end-bound like `02/11/2026`, even though September is
chronologically two months earlier than November — it gets wrongly excluded with no error.
**Never conclude "no matches" / "0 rows in that range" from a result produced this way — it reflects the
string-comparison bug, not real data.**

**Preferred fix for a simple date-range filter — reorder into `YYYYMMDD` in SQL and compare that instead.**
Day and month are not zero-padded in these fields, so a fixed-position `SUBSTR(col, 7, 4) || SUBSTR(col, 4, 2)
|| SUBSTR(col, 1, 2)` slices the wrong characters out of anything shorter than 10 characters. Locate the `/`
separators instead and zero-pad each part:
```sql
WHERE (LPAD(SUBSTR(col, INSTR(col,'/',1,2)+1), 4, '0')
    || LPAD(SUBSTR(col, INSTR(col,'/')+1, INSTR(col,'/',1,2)-INSTR(col,'/')-1), 2, '0')
    || LPAD(SUBSTR(col, 1, INSTR(col,'/')-1), 2, '0')
   ) BETWEEN '20260802' AND '20261102'
```
Year-first, zero-padded, string comparison now matches chronological order exactly, as one query, with no
risk of the result getting truncated by over-fetching. `ORDER BY` should use the same reordered expression,
never the raw column.

**When the bound comes from a script `dateFrom`/`dateTo` param instead of a hardcoded literal**, build the
same `YYYYMMDD` shape directly from it — the param is a real `Date` object, not `DD/MM/YYYY` text, so don't
route it through a `DD/MM/YYYY` string first:
```ts
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, ''); // "20260505"
```
```sql
WHERE (LPAD(SUBSTR(col, ...), ...) || ...) BETWEEN '${ymd(params.dateFrom)}' AND '${ymd(params.dateTo)}'
```

**Fall back to fetching by `IS NOT NULL` only and filtering/parsing in code** when the SQL comparison isn't
enough — a derived value out of the date (days until X), a condition too complex for a clean `BETWEEN`, or
the date logic is part of other computation the script already does in JS:
```js
const [d, m, y] = value.split('/').map(Number);
const asDate = new Date(y, m - 1, d);
```
If that unfiltered fetch itself gets truncated (matched more rows than the cap), do not add a raw `>=`/`<=`
filter to shrink it — paginate across multiple queries (`LIMIT n OFFSET m`) to collect the complete set, then
filter in code. Guessing from a partial, capped sample produces a confidently wrong answer with no warning.

### 13. `ORDER BY` cannot reach into a derived table's raw column after `GROUP BY` — alias the sort expression in the outer query instead
Ordering a grouped/aggregated query by an expression built from a derived table's (subquery's) raw column —
one that isn't already part of the outer query's own `SELECT`/`GROUP BY` — fails with the same generic
`400 Invalid or unsupported search` error as every other unsupported-query case, with no hint that `ORDER BY`
is the actual problem:
```sql
SELECT LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/')+1, INSTR(earliest_date,'/',1,2)-INSTR(earliest_date,'/')-1), 2, '0') || '/' || LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/',1,2)+1), 4, '0') AS month_year, COUNT(DISTINCT customer_id) AS n
FROM (SELECT customer AS customer_id, MIN(datecreated) AS earliest_date FROM job GROUP BY customer) subq
GROUP BY LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/')+1, INSTR(earliest_date,'/',1,2)-INSTR(earliest_date,'/')-1), 2, '0') || '/' || LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/',1,2)+1), 4, '0')
ORDER BY LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/',1,2)+1), 4, '0') DESC, LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/')+1, INSTR(earliest_date,'/',1,2)-INSTR(earliest_date,'/')-1), 2, '0') DESC  -- fails
```
This fails purely because of the `ORDER BY` line — the identical query without it runs fine. **Fix: give the
sort expression its own alias in the outer `SELECT` (and include it in `GROUP BY`), then `ORDER BY` that
alias** — never re-derive an expression from the inner subquery's raw column directly in `ORDER BY`:
```sql
SELECT LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/',1,2)+1), 4, '0') || LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/')+1, INSTR(earliest_date,'/',1,2)-INSTR(earliest_date,'/')-1), 2, '0') AS sort_key,
       LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/')+1, INSTR(earliest_date,'/',1,2)-INSTR(earliest_date,'/')-1), 2, '0') || '/' || LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/',1,2)+1), 4, '0') AS month_year,
       COUNT(DISTINCT customer_id) AS n
FROM (SELECT customer AS customer_id, MIN(datecreated) AS earliest_date FROM job GROUP BY customer) subq
GROUP BY LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/',1,2)+1), 4, '0') || LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/')+1, INSTR(earliest_date,'/',1,2)-INSTR(earliest_date,'/')-1), 2, '0'), LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/')+1, INSTR(earliest_date,'/',1,2)-INSTR(earliest_date,'/')-1), 2, '0') || '/' || LPAD(SUBSTR(earliest_date, INSTR(earliest_date,'/',1,2)+1), 4, '0')
ORDER BY sort_key DESC  -- works
```
**If a query built this way suddenly fails with the generic "Invalid or unsupported search" error, check
`ORDER BY` for this pattern before restructuring anything else** — the surrounding logic is very likely
correct and the fix is narrow. Tearing up a correct query's filters/joins/grouping in response to this error
is how a working query turns into a wrong one that merely happens not to trigger the same error.

### 14. Filtering a date range before an aggregate answers a different, narrower question than "aggregate per group, then filter"
When a query needs each group's earliest/latest date restricted to a target window (e.g. "each customer's
first-ever project, for customers whose first project falls in the last 6 months"), the date filter MUST be
applied to the AGGREGATED value in the outer query — never inside the same query that computes the
`MIN()`/`MAX()`. Filtering the raw rows first computes `MIN()`/`MAX()` only over the already-narrowed rows,
which silently answers a different question and inflates the count — it now also matches rows whose true
earliest/latest value is outside the window but that happen to have some other row inside it:
```sql
-- WRONG — filters datecreated before MIN(), narrowing what MIN() sees
SELECT customer, MIN(datecreated) AS first_date
FROM job
WHERE (SUBSTR(datecreated,7,4) || SUBSTR(datecreated,4,2) || SUBSTR(datecreated,1,2)) BETWEEN '20260202' AND '20260802'
GROUP BY customer
```
```sql
-- RIGHT — compute the true per-group MIN first (no date filter on the input rows), THEN filter that result
SELECT customer, first_date FROM (
  SELECT customer, MIN(datecreated) AS first_date FROM job GROUP BY customer
) c
WHERE (SUBSTR(first_date,7,4) || SUBSTR(first_date,4,2) || SUBSTR(first_date,1,2)) BETWEEN '20260202' AND '20260802'
```
This applies to any "first/last X per group, restricted to a window" question, not just this one field —
filtering an aggregate's inputs before computing it changes what the aggregate means whenever the intent was
actually to filter the aggregate's output.

### 15. Combining a primary/fallback field pair as two independently OR'd null-checks silently disables the fallback
When a value should come from field A, falling back to field B when A is empty, the two fields must be
combined into ONE expression before any comparison — `COALESCE(A, B)`. Writing the check as two separate
OR'd conditions on the original fields instead — `A IS NULL OR A >= X OR B >= X` — looks equivalent but
isn't: if A is empty on almost every row (a common shape for a sparsely-populated primary field with a
fallback), the `A IS NULL` clause alone makes the whole OR chain true for nearly every row, and B's actual
value never gets checked at all. This doesn't error — it silently makes the condition trivially true, and
any "in progress" / "still active" / "still open" check built on it stops filtering anything at all.
```sql
-- WRONG — "a IS NULL" alone can make this whole OR chain true regardless of b's value
WHERE (a IS NULL OR a >= '20260503' OR (b IS NOT NULL AND b >= '20260503'))
```
```sql
-- RIGHT — combine into one value first, then check that value once
WHERE (COALESCE(a, b) IS NULL OR COALESCE(a, b) >= '20260503')
```
This applies to any primary/fallback field pair, not just dates — whenever a schema note says "use field A,
falling back to field B," combine them with `COALESCE` as a single expression everywhere that value is used,
never as two independently OR'd checks on the original fields.

### 16. Joining two separately-built CTEs together for a "true at A, false at B" check is unreliable — use a single-pass aggregate instead
Building two separate CTEs — one for "matched a condition at scope/time A", another for "matched at
scope/time B" — and then joining them together to find rows in A but not in B (via `LEFT JOIN ... WHERE
b.key IS NULL`, or `NOT IN (SELECT key FROM other_cte)`) is unreliable in this engine, even when each
individual CTE's own row count is sane on its own. There is no error — it silently returns fewer rows
than the real answer.
```sql
-- WRONG — two separate CTEs joined together for an anti-join
WITH set_a AS (SELECT DISTINCT customer FROM job WHERE <condition A>),
     set_b AS (SELECT DISTINCT customer FROM job WHERE <condition B>)
SELECT a.customer FROM set_a a LEFT JOIN set_b b ON a.customer = b.customer WHERE b.customer IS NULL
```
```sql
-- RIGHT — single pass, both conditions aggregated together over the SAME rows
SELECT customer,
       SUM(CASE WHEN <condition A> THEN 1 ELSE 0 END) AS count_a,
       SUM(CASE WHEN <condition B> THEN 1 ELSE 0 END) AS count_b
FROM job
GROUP BY customer
HAVING SUM(CASE WHEN <condition A> THEN 1 ELSE 0 END) > 0
   AND SUM(CASE WHEN <condition B> THEN 1 ELSE 0 END) = 0
```
This applies to any "matched a condition in one scope but not another" question — churn, before/after
comparisons, cohort membership, anything of that shape. Never build the two sides as separate CTEs and
join/anti-join them; always aggregate both conditions in one pass over one `FROM` clause.

### 17. A date column always displays as raw `DD/MM/YYYY`, even after a correct reorder-and-filter — that's not a bug
Don't mistake a returned `DD/MM/YYYY` value (e.g. `"4/5/2026"`) for wrong data and re-query. If the filter
used the Pitfall 12 reorder, trust the match.

### 18. A "latest row per group" `ROW_NUMBER()` must rank only ELIGIBLE rows — filter inside the same CTE, before the window function, not after
```sql
-- WRONG — ranks every row, then filters afterward
WITH latest AS (
  SELECT id, group_id, ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY created_date DESC) AS rn
  FROM t WHERE group_id IS NOT NULL
)
SELECT * FROM latest WHERE rn = 1 AND status = 'eligible'
```
If the true latest-created row for a group fails `status = 'eligible'`, the whole group silently disappears —
`rn = 1` already picked the ineligible row, and there is no fallback to the next-latest eligible one.
```sql
-- RIGHT — filter to eligible rows FIRST, rank within that set
WITH latest AS (
  SELECT id, group_id,
         ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY created_date DESC) AS rn
  FROM t WHERE group_id IS NOT NULL AND status = 'eligible'
)
SELECT * FROM latest WHERE rn = 1
```
Every eligibility condition on the ranked table belongs inside the same CTE as the `ROW_NUMBER()`, never in the
outer query's `WHERE` — an outer filter runs after ranking has already committed to a row.

### 19. A conditional override in the intent must become a `CASE WHEN` — not just the default branch
"Use B instead of A when condition" means both branches belong in the query. Writing only the default
expression and never referencing the override column silently drops it — no error, looks complete.
```sql
-- WRONG
SELECT qty * a AS value FROM t
-- RIGHT
SELECT qty * (CASE WHEN type = 'Special' THEN b ELSE a END) AS value FROM t
```
**Before finalizing, check every override clause in the intent has a matching `CASE WHEN`** — a column
joined/selected for the condition but never used in the final calculation means it was dropped.

---

## REQUIRED PATTERNS

### Row Limits — the one deliberate exception
Add `LIMIT <n>` at the end of every query — this tool converts it internally before sending the query to
NetSuite (SuiteQL itself has no `LIMIT` keyword, and while `TOP` is real it's slow and this tool avoids
it — see Critical Error 1). Do not write `TOP`, `FETCH FIRST ... ROWS ONLY`, or
`OFFSET ... ROWS FETCH NEXT ... ROWS ONLY` yourself — just `LIMIT <n>` (and `OFFSET <n>` if paginating).
**This is a narrow, deliberate exception** — it does not license any other assumption about how this
query language behaves. `CAST`, the simple `CASE` form, and `ORDER BY COUNT(*)` all fail here
(see Critical Errors and Pitfalls).

### Table Aliases
Always prefix columns with a table alias in multi-table (JOIN) queries to avoid ambiguity.

### Custom fields are per-tenant
Column names starting `custentity_`, `custbody_`, `custrecord_`, `custcol_` are specific customizations
for this NetSuite account. Only use ones that actually appear in the schema shown to you — never guess
or invent a custom field name.

### Subquery column aliases must be unquoted
`(SELECT a.externalid "AccountId" FROM account a)` fails — quoted aliases inside a subquery are rejected.
Write `(SELECT a.externalid AccountId FROM account a)` instead.

### Keep queries cheap on large tables
SuiteQL runs against a virtual schema, not real indexes, so inefficient queries time out more easily than
on a normal RDBMS — especially on high-row-count tables like `transaction`. Rules of thumb:
- Select only the columns needed — never `SELECT *`.
- Filter on `id` or `lastmodifieddate` where possible — both behave like indexed fields.
- Prefer running two queries over one `WHERE a = x OR b = y` — split disjunctions into separate queries.
- Don't join the same table target more than once in a query.
- `IN (...)` accepts at most 1000 items — batch larger id lists across multiple queries.

---

## SYNTAX REFERENCE

| Feature | SuiteQL Syntax |
|---|---|
| Row limit | `LIMIT n` (tool-converted — see Row Limits above) |
| Pagination | `LIMIT n OFFSET m` (tool-converted) |
| Boolean | `'T'` / `'F'` text — never `true`/`false` |
| NULL check | `IS NULL`, `IS NOT NULL` — never `= NULL`, never add `!= ''` alongside `IS NOT NULL` (see Critical Error 8) |
| String escape | `'O''Brien'` — double single-quotes |
| String concat | `a \|\| b` — never `+` |
| Case-insensitive match | `UPPER(col) LIKE UPPER('%text%')` — no `ILIKE` |
| Type conversion | **None — `CAST` does not work at all (see Critical Error 4).** Use numeric columns bare: `SUM(total)`, `total > 100`. |
| Date conversion | **None — `TO_DATE(...)` silently returns no rows on text-stored dates (see Critical Error 9).** Fetch populated rows, parse the text, and filter in code. |
| Date range filter | **Never `>=`/`<=` directly on a text-stored date (see Critical Error 12)** — it compares characters, not calendar dates. Reorder into `YYYYMMDD` first for a simple range filter; fetch `IS NOT NULL` + filter in code for anything more complex. |
| Conditional | Searched form only: `CASE WHEN col = val THEN x ELSE y END` — not `CASE col WHEN val THEN x END` |
| Sort with nulls | `ORDER BY col DESC NULLS LAST` — **required** on any nullable/computed column in a descending sort; NULLs sort FIRST by default (see Critical Error 10) |
| Aggregates | `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `GROUP BY`, `HAVING` — supported (but see Critical Error 6 on `ORDER BY COUNT(*)`) |
| Joins | `JOIN`/`LEFT JOIN`/`RIGHT JOIN`/`FULL JOIN ... ON` — supported |
| CTEs | `WITH name AS (...) SELECT ...` works, including chained CTEs joined against a real table — but joining TWO separately-built CTEs together (anti-join / `NOT IN`) is unreliable (see Critical Error 16) |
| Primary/fallback field pair | `COALESCE(a, b)` as ONE expression — never two independently OR'd null-checks on `a` and `b` (see Critical Error 15) |
| "True at A, false at B" check | Single-pass `SUM(CASE...)` + `GROUP BY`/`HAVING` — never two separate CTEs joined/anti-joined together (see Critical Error 16) |
| `IN` list size | Max 1000 items per `IN (...)` — batch larger lists across queries |

---

## COMMON PITFALLS

1. **Writing `TOP`/`FETCH FIRST` instead of `LIMIT n`** — see Critical Error 1.
2. **`ILIKE`** — see Critical Error 2.
3. **Comparing booleans as `true`/`false`** — see Critical Error 3.
4. **Date fields returned as free-text strings** (commonly `DD/MM/YYYY`, not ISO) rather than native
   dates — treat as text for filtering/formatting unless the schema says otherwise.
5. **`SELECT *` on relationship/junction record types** (e.g. `customersubsidiaryrelationship`) can
   return an unexpected single-column/nested shape instead of flat columns — prefer explicit column
   lists when the table's exact shape isn't already confirmed in the schema.
6. **Reference/lookup fields return raw internal IDs, not names** — e.g. `job.custentity_status_code`
   returns a numeric id, not a status label. Resolve id → name via the schema's documented value mappings
   (`semantic.valueVocabulary` / glossary) rather than assuming the raw id is human-readable, and never
   invent a join against a "lookup table" for a NetSuite custom list — custom lists are not independently
   queryable via SuiteQL. Resolve them with a searched `CASE WHEN` using the documented id→name mapping.
7. **`CAST(...)`** — see Critical Error 4.
8. **Simple `CASE column WHEN value THEN ...`** — see Critical Error 5.
9. **`ORDER BY COUNT(*)`** — see Critical Error 6.
10. **Reaching for a familiar function name that SuiteQL doesn't support** — see Critical Error 7.
11. **Adding `!= ''`/`<> ''` alongside `IS NOT NULL`** — see Critical Error 8.
12. **Using `TO_DATE(...)` to range-filter a text-stored date** — see Critical Error 9.
13. **`ORDER BY <expr> DESC` without `NULLS LAST` on a nullable/computed column** — see Critical Error 10.
14. **Sorting a `MM/YYYY`-extracted month string** — see Critical Error 11.
15. **Using `>=`/`<=` directly on a text-stored date, or trusting a "0 results" it produces** — see Critical Error 12.
16. **`ORDER BY` on a derived table's raw column after `GROUP BY`, instead of an aliased outer-query expression** — see Critical Error 13.
17. **Filtering a date range on the raw column before `MIN()`/`MAX()` instead of on the aggregated result** — see Critical Error 14.
18. **Checking a primary/fallback field pair as two independently OR'd conditions instead of `COALESCE`-ing them first** — see Critical Error 15.
19. **Joining two separately-built CTEs together for a "true at A, false at B" check** — see Critical Error 16.
20. **A conditional override in the intent implemented as only the default branch, no `CASE WHEN`** — see Critical Error 19.
