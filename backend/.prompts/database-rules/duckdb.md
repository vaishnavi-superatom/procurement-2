# DuckDB - Query Rules

## CRITICAL ERRORS (Query Will Fail)

### 1. INTERVAL Cannot Be Cast to INTEGER or DOUBLE
Subtracting two dates/timestamps in DuckDB returns an `INTERVAL`, NOT a number. You CANNOT cast an INTERVAL to INTEGER or DOUBLE.

**Invalid patterns:**
- `CAST(date1 - date2 AS INTEGER)` — fails with "Unimplemented type for cast (INTERVAL -> INTEGER)"
- `CAST(date1 - date2 AS DOUBLE)` — fails with "Unimplemented type for cast (INTERVAL -> DOUBLE)"
- `(dispatch_date - placement_date)::INTEGER` — same error

**Valid patterns:**
- `DATE_DIFF('day', date2, date1)` — returns integer number of days between two dates
- `DATE_DIFF('hour', date2, date1)` — returns integer number of hours
- `EXTRACT(EPOCH FROM (date1 - date2)) / 86400` — alternative for fractional days

**Solution:** Always use `DATE_DIFF('unit', start_date, end_date)` for date arithmetic that needs a numeric result. The unit MUST be a quoted string.

### 2. DATEDIFF / DATE_DIFF Unit Must Be a Quoted String
The date part argument in `DATE_DIFF` and `DATEDIFF` MUST be a quoted string literal, NOT a bare identifier.

**Invalid patterns:**
- `DATEDIFF(day, date1, date2)` — `day` is interpreted as a column name, fails with "Referenced column 'day' not found"
- `DATEDIFF(month, date1, date2)` — same error
- `DATE_PART(year, date_col)` — same error

**Valid patterns:**
- `DATEDIFF('day', date1, date2)` — unit as quoted string
- `DATE_DIFF('day', date1, date2)` — preferred DuckDB syntax
- `DATE_PART('year', date_col)` — unit as quoted string
- `EXTRACT(DAY FROM interval_value)` — EXTRACT syntax uses unquoted keywords (this is different)

**Solution:** ALWAYS quote the unit argument in DATE_DIFF, DATEDIFF, DATE_PART, DATE_TRUNC, and similar functions: `'day'`, `'month'`, `'year'`, `'hour'`, `'minute'`, `'second'`.

### 3. TRY_CAST(string AS DATE) Silently Fails on Non-ISO Dates
`TRY_CAST(col AS DATE)` only recognizes ISO format (`YYYY-MM-DD`). For ANY other date format (e.g., `DD-MM-YYYY`, `DD/MM/YYYY`, `DD Mon YYYY`), TRY_CAST silently returns **NULL** — it does NOT error, it just gives NULL for every row. This leads to incorrect results (e.g., 0% match rates) without any error message.

**Invalid patterns (silently wrong results):**
- `TRY_CAST("Actual Date of Arrival" AS DATE)` — returns NULL if column contains `02-04-2025` (DD-MM-YYYY)
- `CAST(col AS DATE)` — errors on non-ISO formats
- `TRY_CAST(SUBSTR(col, 1, 10) AS DATE)` — only works if the substring is already `YYYY-MM-DD`

**Valid patterns:**
- `TRY_STRPTIME(col, '%d-%m-%Y')::DATE` — explicitly parse DD-MM-YYYY format, then cast to DATE
- `TRY_STRPTIME(col, '%d/%m/%Y')::DATE` — for DD/MM/YYYY format
- `TRY_STRPTIME(col, '%d %b %Y')::DATE` — for "01 Apr 2025" format
- `COALESCE(TRY_STRPTIME(col, '%d-%m-%Y'), TRY_STRPTIME(col, '%d/%m/%Y'), TRY_STRPTIME(col, '%Y-%m-%d'))::DATE` — handle multiple possible formats

**Solution:** NEVER use `TRY_CAST(col AS DATE)` or `CAST(col AS DATE)` for date string columns. ALWAYS use `TRY_STRPTIME` with the correct format string. Check sample values in the schema to determine the format. If the format is unclear, use COALESCE with multiple TRY_STRPTIME patterns.

### 4. Aggregate Nesting is Forbidden
DuckDB cannot evaluate an aggregate function that contains another aggregate — including inside a `CASE` or a `FILTER (WHERE ...)` clause.

**Invalid patterns:**
- `AVG(MAX(...))`, `SUM(COUNT(...))`, `MIN(SUM(...))`
- `SUM(CASE WHEN rsp = mode(rsp) THEN 1 ELSE 0 END)` — `mode(rsp)` is an aggregate nested inside `SUM(...)`. INVALID.
- `COUNT(*) FILTER (WHERE rsp = mode(rsp))` — same problem, the aggregate `mode(rsp)` cannot appear in the FILTER condition.

**Solution:** Compute the inner aggregate (e.g. the mode) in a CTE first, then JOIN it back or compare against it in an OUTER query. To count how many rows equal the mode (the mode's frequency): CTE 1 computes `mode(rsp) AS mode_rsp` per group; CTE 2 (or the base rows) is joined to CTE 1 and does `COUNT(*) FILTER (WHERE rsp = mode_rsp)` — now `mode_rsp` is a plain column, not an aggregate.

**COPY THIS EXACT TEMPLATE for "mode + its frequency + total observations per group"** (the single most common cause of the "aggregate function calls cannot be nested" error — adapt the table, value column, group keys, and filters):
```sql
WITH base AS (
  -- raw rows: PROJECT the value column + every group key you need downstream
  SELECT "Store", "Category", "Amount"
  FROM "Sales"
  WHERE "Region" = 'West' AND "Amount" IS NOT NULL
),
modes AS (
  -- resolve the mode (and any counts) per group HERE, where they are aggregates
  SELECT "Store", "Category",
         mode("Amount") AS mode_value,
         COUNT(*)    AS total_obs
  FROM base
  GROUP BY "Store", "Category"
)
SELECT b."Store", b."Category",
       m.mode_value,
       m.total_obs,
       COUNT(*) FILTER (WHERE b."Amount" = m.mode_value) AS mode_frequency  -- mode_value is now a PLAIN column
FROM base b
JOIN modes m USING ("Store", "Category")
GROUP BY b."Store", b."Category", m.mode_value, m.total_obs
LIMIT 50;
```
The mistake to NEVER repeat: `COUNT(*) FILTER (WHERE "Amount" = mode("Amount"))` in the same SELECT as `mode("Amount")`. The `mode(...)` MUST come from a separate CTE (`m.mode_value` above), never be called inside another aggregate's `FILTER`/`CASE`/argument.

### 4a. A column must be PROJECTED by a CTE/subquery to be used outside it
Once a CTE/subquery runs `GROUP BY` (or otherwise omits a column from its SELECT list), that column NO LONGER EXISTS for any query reading from it. Referencing it downstream raises `Binder Error: Referenced column "X" not found`.

**Invalid:** a `stats` CTE selects `Store, mode_amount, total_obs` (grouped), then the outer query does `COUNT(*) FILTER (WHERE amount = mode_amount)` — but `amount` was never projected by `stats`, so it is not available.

**Solution:** carry every column you need downstream through the CTE's SELECT list, or do the per-row work (like comparing each `rsp` to the group mode) in the SAME query level where the raw rows still exist (e.g. join the raw rows to the mode CTE).

### 5. Aggregates Cannot Appear in WHERE
WHERE clause cannot reference any aggregate function.

**Invalid:** `WHERE COUNT(*) > 0`, `WHERE SUM(x) > 100`

**Solution:** Use HAVING after GROUP BY for aggregate conditions, or filter via subquery.

### 6. SELECT-GROUP BY Consistency
When a query uses `GROUP BY` (or ANY aggregate like `mode()`, `COUNT`, `SUM`), EVERY column in the SELECT list must EITHER appear in the `GROUP BY` clause OR be wrapped in an aggregate. You CANNOT select a raw per-row column (one whose value differs row-to-row) next to aggregates without grouping it — DuckDB fails with `column "X" must appear in the GROUP BY clause or must be part of an aggregate function`.

**Invalid pattern (a very common cause of this error):**
```sql
SELECT Store, Category, Amount,            -- Amount is raw — not grouped, not aggregated → ERROR
       COUNT(*) AS obs
FROM "Sales"
GROUP BY Store, Category
```

**Valid — decide what you actually want for that column:**
- **Aggregate it** (the usual fix): `SELECT Store, Category, mode(Amount) AS amount_mode, COUNT(*) AS obs FROM ... GROUP BY Store, Category`
- **Keep any one value** when the exact row doesn't matter: `ANY_VALUE(Amount)`
- **Group by it too** (only if you truly want one row per distinct value): add `Amount` to the `GROUP BY`

**Solution:** For every SELECT column ask "is this a grouping KEY or a MEASURE?" — keys go in `GROUP BY`, measures get wrapped in `mode`/`COUNT`/`SUM`/`AVG`/`ANY_VALUE`. Never leave a bare value column in a grouped/aggregated SELECT. If you need raw per-row values, produce them in a separate non-grouped CTE.

### 7. PERCENTILE_CONT Returns DECIMAL, Not DOUBLE
`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY col)` may return a DECIMAL type that doesn't implicitly convert in all contexts.

**Solution:** Wrap with `CAST(... AS DOUBLE)` if needed for further arithmetic.

---

## REQUIRED PATTERNS

### Row Limits
Always end every SELECT with a LIMIT clause, using the exact row count given in the query-generation row-limit instruction (do NOT invent a larger number — the system enforces that cap regardless, so a bigger LIMIT only produces a misleading query).

### Date Parsing from Strings — CRITICAL
Excel/CSV data has dates as strings in various formats. **NEVER use TRY_CAST(col AS DATE)** — it only works for ISO format and silently returns NULL for everything else, producing wrong results with no error.

**ALWAYS use `TRY_STRPTIME` with the correct format:**
- `TRY_STRPTIME(col, '%d %b %Y')` — "01 Apr 2025"
- `TRY_STRPTIME(col, '%d-%m-%Y')` — "01-04-2025"
- `TRY_STRPTIME(col, '%d/%m/%Y')` — "01/04/2025"
- `TRY_STRPTIME(col, '%Y-%m-%d')` — "2025-04-01"
- `TRY_STRPTIME(col, '%Y-%m-%d %H:%M:%S')` — "2025-04-01 07:15:46"
- Use `COALESCE(TRY_STRPTIME(col, fmt1), TRY_STRPTIME(col, fmt2))` to handle multiple possible formats
- `TRY_STRPTIME` returns NULL on parse failure instead of error
- To get a DATE from a parsed timestamp: `TRY_STRPTIME(col, '%d-%m-%Y')::DATE`

**Determine the format from sample values in the schema.** Different columns in the same table may use different date formats — parse each column with its own format string.

### Time Parsing from Strings
Time columns in Excel/CSV are often stored as `HH:MM` strings (e.g., `09:57`, `14:30`). To extract the hour as an integer for time-slot grouping, use the simplest approach:

```sql
TRY_CAST(SPLIT_PART("Time Column", ':', 1) AS INTEGER) AS hour_of_day
```

Then use the integer hour for time-slot buckets:
```sql
CASE
  WHEN hour_of_day >= 0  AND hour_of_day < 6  THEN '00-06 (Night)'
  WHEN hour_of_day >= 6  AND hour_of_day < 12 THEN '06-12 (Morning)'
  WHEN hour_of_day >= 12 AND hour_of_day < 18 THEN '12-18 (Afternoon)'
  WHEN hour_of_day >= 18 AND hour_of_day < 24 THEN '18-24 (Evening)'
END
```

**Do NOT use complex nested casts** like `TRY_CAST(CAST(STRPTIME(...) AS TIME) AS VARCHAR)` for time-slot grouping — it is error-prone and unnecessarily complex. Simple string splitting is more reliable.

### Table Aliases
Always prefix columns with table alias in multi-table queries to avoid ambiguity.

### Balanced Parentheses
Every `(` must have a matching `)`. Verify carefully in nested subqueries and CASE expressions.

### Column Alias References
- Cannot use column aliases in WHERE (use the original expression)
- Can use column aliases in ORDER BY and HAVING

---

## SYNTAX REFERENCE

| Feature | DuckDB Syntax |
|---------|---------------|
| Row limit | `SELECT ... LIMIT n` |
| Pagination | `LIMIT n OFFSET m` |
| Boolean | `true`, `false` — lowercase, no quotes |
| NULL check | `IS NULL`, `IS NOT NULL` — never `= NULL` or `= 'null'` |
| String escape | `'O''Brien'` — double single-quotes |
| Current datetime | `NOW()` or `CURRENT_TIMESTAMP` |
| Current date only | `CURRENT_DATE` or `TODAY()` |
| Date difference (days) | `DATE_DIFF('day', start_date, end_date)` — returns INTEGER |
| Date difference (hours) | `DATE_DIFF('hour', start_date, end_date)` — returns INTEGER |
| Date arithmetic | `date_col + INTERVAL '7 days'` or `date_col - INTERVAL '1 month'` |
| Date extract | `EXTRACT(unit FROM date_col)` or `DATE_PART('unit', date_col)` |
| Day of week | `DAYOFWEEK(date_col)` — 0=Sunday, 6=Saturday |
| Day name | `DAYNAME(date_col)` — returns 'Monday', 'Tuesday', etc. |
| Date format | `STRFTIME(date_col, '%Y-%m-%d')` |
| Date truncate | `DATE_TRUNC('month', date_col)` — unit MUST be quoted |
| Parse date string | `TRY_STRPTIME(string, format)` — returns NULL on failure |
| String concat | `a \|\| b` or `CONCAT(a, b)` |
| Type conversion | `CAST(col AS type)` or `col::type` |
| Safe type conversion | `TRY_CAST(col AS type)` — returns NULL on failure |
| Conditional | `CASE WHEN cond THEN val ELSE val END` |
| Coalesce | `COALESCE(a, b, c)` |
| String contains | `column LIKE '%text%'` |
| Case-insensitive | `column ILIKE '%text%'` |
| Regex match | `REGEXP_MATCHES(col, 'pattern')` |
| List aggregation | `LIST(col)` or `ARRAY_AGG(col)` |
| String split | `SPLIT_PART(string, delimiter, index)` — 1-based index |
| Median | `MEDIAN(col)` or `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY col)` |

---

## COMMON PITFALLS

1. **Division by zero** - Wrap with `NULLIF(denominator, 0)` to return NULL instead of error
2. **Integer division** - `5/2 = 2` — cast to DOUBLE for precise division: `CAST(5 AS DOUBLE)/2 = 2.5`
3. **String comparison** - DuckDB is case-sensitive by default; use ILIKE or LOWER() for case-insensitive
4. **Date strings** - ALWAYS use `TRY_STRPTIME(col, format)` to parse dates. NEVER use `TRY_CAST(col AS DATE)` — it silently returns NULL for non-ISO formats, producing wrong results with no error
5. **Empty string vs NULL** - They are different; check for both when needed
6. **Column names with spaces** - Must be quoted with double quotes: `"Column Name"`
7. **INTERVAL arithmetic** - `date1 - date2` gives INTERVAL; use `DATE_DIFF('day', date2, date1)` for a number
8. **Bare date units** - NEVER use `day`, `month`, `year` without quotes in functions — always `'day'`, `'month'`, `'year'`
9. **String-to-numeric** - Use `TRY_CAST(col AS DOUBLE)` for numeric operations on string columns — never plain `CAST` on user data
10. **DAYOFWEEK convention** - DuckDB's `DAYOFWEEK` returns 0=Sunday through 6=Saturday (ISO convention). Use `DAYNAME()` for readable names.
11. **Non-existent functions** - DuckDB does NOT have `FORMAT_TIMESTAMP`, `TO_CHAR`, or `FORMAT_DATE`. Use `STRFTIME(date_col, format)` for date-to-string formatting. Example: `STRFTIME(date_col, '%B %Y')` → "April 2025"
12. **Month-year grouping** - For month-over-month analysis, use `DATE_TRUNC('month', date_col)` in GROUP BY and `STRFTIME(date_col, '%B %Y')` for display. Do NOT group by the formatted string — group by the truncated date for correct sorting.
13. **COALESCE type mismatch** - All arguments in COALESCE must be the same type. `COALESCE("varchar_col", 0)` fails because VARCHAR and INTEGER can't mix. Cast first: `COALESCE(TRY_CAST("varchar_col" AS DOUBLE), 0)`. Same applies to CASE WHEN, BETWEEN, and IN — always ensure consistent types.

---

## PERFORMANCE

- Avoid `SELECT *` — specify only needed columns
- Use indexed columns in WHERE and JOIN conditions
- Prefer JOINs over correlated subqueries when possible
- Limit result sets appropriately
- DuckDB is columnar — queries touching fewer columns are significantly faster
