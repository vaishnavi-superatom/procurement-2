# Microsoft SQL Server - Query Rules

## BEFORE WRITING ANY QUERY — CHECK THESE FIRST
These are the most common mistakes. Verify each one before generating SQL:

1. **Aggregate in WHERE** — `SUM`/`COUNT` never go in WHERE. Use HAVING or a subquery.
2. **Unicode string literals** — NEVER put Unicode/special characters (arrows `→`, rupee `₹`, em-dash `—`, etc.) directly in a string literal without the `N` prefix. Without `N`, SQL Server treats the literal as VARCHAR and the character becomes `?`. Always write `N' -> '` or just use ASCII `' -> '` instead of `' → '`. **For lane/route display always use `col1 + ' -> ' + col2` (ASCII hyphen-arrow), never `' → '` (Unicode arrow).**
3. **STRING_AGG** — always wrap column as `STRING_AGG(CAST(col AS NVARCHAR(MAX)), ', ')` to avoid 8000 byte limit.
3. **STRING_AGG DISTINCT** — DISTINCT is FORBIDDEN anywhere inside STRING_AGG. Not as `STRING_AGG(DISTINCT col, ', ')` and NOT as `STRING_AGG(CAST(DISTINCT col AS NVARCHAR(MAX)), ', ')`. Both cause syntax errors. Always deduplicate in a subquery first, then STRING_AGG outside.
4. **Integer division** — `5/2` is `2`: both operands are integers. Multiply by `1.0` or `CAST(... AS decimal(18,4))` before dividing, or a share/average comes back truncated.
5. **Date + integer** — never write `GETDATE() + 1` or `CAST(GETDATE() AS DATE) + 1`. Always use `DATEADD(DAY, 1, GETDATE())`.
6. **No DECLARE** — `DECLARE @var` is not supported. Use subqueries or derived tables instead.
7. **CTEs are supported and PREFERRED for complex queries** — `WITH cte AS (...)` is valid MSSQL syntax. Use CTEs when LIKE-based joins or multi-step filtering (e.g. state → city → service network) would time out as subqueries. CTEs must come before the main SELECT: `WITH cte AS (...) SELECT ... FROM cte JOIN ...`.
8. **Query must start with SELECT or WITH** — if using a CTE start with `WITH`, otherwise `SELECT`. No DECLARE or other statements. NEVER prefix WITH a semicolon (`;WITH` is forbidden — the `;` is treated as a statement separator and will be rejected).
9. **Date literal format** — Date/datetime string literals must be ISO format: `'YYYY-MM-DD'` or `'YYYY-MM-DD HH:MM:SS'`. If a date value you're given (e.g. from conversation context, a filter, or "today") looks like `'Mon Jun 22 2026 05:30:00 GMT+0530 (India Standard Time)'` (JavaScript's `Date.toString()` output), **reformat it to `'2026-06-22'` before embedding it in SQL** — never paste it in verbatim. SQL Server cannot parse that format and will fail with "Conversion failed when converting date and/or time from character string."
10. **GROUP BY must cover every non-aggregated column — including ones hidden inside a CASE/expression, not just bare SELECT columns.** Before finalizing a query with GROUP BY, re-scan every SELECT item for any raw column reference buried inside a `CASE WHEN`, function call, or other expression — checking only the top-level SELECT aliases is NOT enough, since the alias name often doesn't resemble the column hidden inside it (e.g. `CASE WHEN t.OwnerId > 0 THEN o.OwnerName ELSE t.FallbackName END AS DisplayName` references `t.OwnerId` and `t.FallbackName` — BOTH must be in GROUP BY, even though neither literally appears in the alias `DisplayName`). See rule 7 below for the full example.

11. **Two measures (or a row count) at DIFFERENT GRAINS — aggregate each in its own CTE, then join.** Never join two fact tables directly and `SUM`/`COUNT(*)` off the join: joining to a table with multiple rows per key multiplies every parent row once per matching child row, inflating both the sum AND the row count. `COUNT(DISTINCT <parent key>)` HIDES this — it stays correct even when the join is wrong — so cross-check `COUNT(*)` against `COUNT(DISTINCT <parent key>)` before trusting either, and never use `COUNT(*)` as a total when the same query also joins a one-to-many child table. Correct shape:
```sql
WITH a AS (SELECT KeyId, SUM(x) AS SumX FROM t1 WHERE ... GROUP BY KeyId),
     b AS (SELECT KeyId, SUM(y) AS SumY FROM t2 WHERE ... GROUP BY KeyId)
SELECT ... FROM a LEFT JOIN b ON b.KeyId = a.KeyId ORDER BY ...
```
Sanity-check the magnitude before trusting it: if one entity's total exceeds a plausible whole-business total, you have a fan-out, not a big customer.
---

## CRITICAL ERRORS (Query Will Fail)

### 1. Aggregate Nesting is Forbidden
MSSQL cannot evaluate an aggregate function that contains another aggregate, a subquery, or any expression using an aggregate.

**Invalid patterns:**
- Aggregate inside aggregate: `AVG(MAX(...))`, `SUM(COUNT(...))`, `MIN(SUM(...))`
- Aggregate inside function inside aggregate: `AVG(DATEDIFF(..., MAX(...), ...))`
- Aggregate in CASE inside aggregate: `SUM(CASE WHEN COUNT(...) > 0 THEN ...)`

**Solution:** Use a subquery or CTE to compute inner aggregates first, then apply outer aggregate to the result.

### 2. Aggregates Cannot Appear in GROUP BY
GROUP BY expressions cannot contain any aggregate function - neither directly nor inside CASE, functions, or other expressions.

**Invalid patterns:**
- Direct: `GROUP BY MAX(column)`
- Inside CASE: `GROUP BY CASE WHEN MAX(...) > value THEN ... END`
- Inside function: `GROUP BY DATEDIFF(..., MAX(...), ...)`

**Solution:** Compute aggregates in a subquery first, expose as a column, then GROUP BY that column in the outer query.

### 3. Aggregates Cannot Appear in WHERE
WHERE clause cannot reference any aggregate function, even nested inside other functions.

**Invalid:** `WHERE COUNT(*) > 0`, `WHERE SUM(x) > 100`

**Solution:** Use HAVING after GROUP BY for aggregate conditions, or filter via subquery.

### 4. Scalar Subquery Requirement
Subqueries in SELECT clause must return exactly one row and one column.

**Solution:** Use TOP 1, or ensure aggregation guarantees single value.

### 5. Subqueries with Comparison Operators Must Return Single Value
When a subquery is used with `=`, `!=`, `<`, `<=`, `>`, `>=` operators, it MUST return exactly one row.

**Invalid:**
- `WHERE BranchFK = (SELECT BranchSK FROM DimBranch WHERE BranchName = 'Name')` — may return multiple rows

**Valid patterns:**
- Use `TOP 1`: `WHERE BranchFK = (SELECT TOP 1 BranchSK FROM DimBranch WHERE BranchName = 'Name')`
- Use `IN` operator: `WHERE BranchFK IN (SELECT BranchSK FROM DimBranch WHERE BranchName = 'Name')`
- Use aggregate: `WHERE BranchFK = (SELECT MAX(BranchSK) FROM DimBranch WHERE BranchName = 'Name')`

**Solution:** Always use `TOP 1` in subqueries used with comparison operators, or use `IN` if multiple matches are acceptable.

### 6. Derived Tables Must Have an Alias
Any subquery used in a FROM clause (derived table) MUST have an alias.

**Invalid:**
- `SELECT * FROM (SELECT col FROM table)` — missing alias

**Valid:**
- `SELECT * FROM (SELECT col FROM table) AS subq` — has alias `subq`

**Solution:** Always add an alias after the closing parenthesis of a derived table.

### 7. SELECT-GROUP BY Consistency
Every non-aggregated column in SELECT must appear in GROUP BY — including a column referenced only INSIDE a `CASE`, function, or other expression, not just columns that appear as their own bare SELECT item. SQL Server checks this purely syntactically: it does not matter that a column is provably redundant (e.g. functionally determined by a primary key you already grouped by) — if the exact column reference isn't in GROUP BY, and isn't wrapped in an aggregate, the query fails with *"Column '...' is invalid in the select list because it is not contained in either an aggregate function or the GROUP BY clause."*

**The easy-to-miss case — a column hidden inside a CASE condition, where the alias gives no hint:**
```sql
-- INVALID: t.OwnerId and t.FallbackName are referenced inside the CASE,
-- but only t.FallbackName made it into GROUP BY — t.OwnerId did not.
-- Scanning the alias "DisplayName" gives no hint that OwnerId is even involved.
SELECT
    t.Id,
    CASE WHEN t.OwnerId > 0 THEN o.OwnerName ELSE t.FallbackName END AS DisplayName
FROM main_table t
LEFT JOIN owner_table o ON t.OwnerId = o.OwnerId
GROUP BY t.Id, t.FallbackName   -- missing t.OwnerId
```

**Solution:** for every `CASE`/expression in the SELECT list, list out EVERY raw column it references (not just the alias), and confirm each one is either in GROUP BY or wrapped in an aggregate:
```sql
GROUP BY t.Id, t.FallbackName, t.OwnerId   -- both referenced columns now present
```

### 7b. ORDER BY Must Use GROUP BY Expressions or Aggregates
When a query has GROUP BY, ORDER BY can ONLY reference:
- Expressions that exactly match a GROUP BY expression
- Column aliases from SELECT
- Aggregate functions

MSSQL does NOT recognize two CASE expressions as "the same" if they produce different values, even if they reference the same column.

**Invalid pattern:**
```sql
SELECT CASE WHEN MONTH(dt) IN (4,5,6) THEN 'Q1' ... END AS Quarter
FROM table
GROUP BY CASE WHEN MONTH(dt) IN (4,5,6) THEN 'Q1' ... END
ORDER BY CASE WHEN MONTH(dt) IN (4,5,6) THEN 1 ... END  -- FAILS: different CASE, references raw column
```

**Valid patterns:**
```sql
-- Option 1: ORDER BY the column alias
SELECT CASE WHEN MONTH(dt) IN (4,5,6) THEN 'Q1' ... END AS Quarter
...
GROUP BY CASE WHEN MONTH(dt) IN (4,5,6) THEN 'Q1' ... END
ORDER BY Quarter

-- Option 2: Use an aggregate
...
GROUP BY CASE WHEN MONTH(dt) IN (4,5,6) THEN 'Q1' ... END
ORDER BY MIN(dt)

-- Option 3: Include the ordering expression in GROUP BY
SELECT CASE ... END AS Quarter, CASE ... END AS SortOrder
GROUP BY CASE ... END, CASE ... END  -- both expressions in GROUP BY
ORDER BY SortOrder
```

**Solution:** Always use column aliases from SELECT in ORDER BY when the query has GROUP BY. This is the simplest and safest approach.

### 8. text, ntext, and image Columns Cannot Be Compared or Sorted
MSSQL's legacy LOB types (`text`, `ntext`, `image`) do NOT support `=`, `<>`, `>`, `<`, `>=`, `<=`, `GROUP BY`, `ORDER BY`, `DISTINCT`, or `UNION`. Using these operators on such columns causes: *"The text, ntext, and image data types cannot be compared or sorted"*.

**Check the schema's `nativeType` for each column before writing the query.** If a column has nativeType `text`, `ntext`, or `image`:

**Invalid patterns:**
- `WHERE notes = 'value'`
- `ORDER BY description`
- `GROUP BY remarks`
- `SELECT DISTINCT comments`

**Valid patterns (CAST to nvarchar(max) first):**
- `WHERE CAST(notes AS NVARCHAR(MAX)) = 'value'`
- `WHERE CAST(notes AS NVARCHAR(MAX)) LIKE '%value%'`
- `ORDER BY CAST(description AS NVARCHAR(MAX))`
- `GROUP BY CAST(remarks AS NVARCHAR(MAX))`
- `SELECT DISTINCT CAST(comments AS NVARCHAR(MAX))`

**Solution:** Always wrap `text`/`ntext` columns in `CAST(column AS NVARCHAR(MAX))` before any comparison, sorting, grouping, or DISTINCT. For `image` columns, avoid comparisons entirely — they are binary data.

### 9. nvarchar to Numeric Conversion Errors
When a column has a string type (`nvarchar`, `varchar`, `char`) but may contain numeric-looking values, using it in arithmetic or numeric comparisons causes: *"Error converting data type nvarchar to numeric"*.

**Check the schema's `nativeType` before numeric operations.** If the column is a string type:

**Invalid patterns:**
- `WHERE price > 100` (when `price` is nvarchar)
- `SUM(amount)` (when `amount` is varchar)
- `column * 1.1` (when `column` is nvarchar)

**Valid patterns (use TRY_CAST for safe conversion):**
- `WHERE TRY_CAST(price AS DECIMAL(18,2)) > 100`
- `SUM(TRY_CAST(amount AS DECIMAL(18,2)))`
- `TRY_CAST(column AS DECIMAL(18,2)) * 1.1`

**Solution:** Always use `TRY_CAST(column AS DECIMAL(18,2))` or `TRY_CONVERT` for numeric operations on string-typed columns. `TRY_CAST` returns NULL instead of raising an error for non-numeric values. Never use plain `CAST` — it will error on non-numeric rows.

### 10. Date-Integer Type Clash
MSSQL does NOT allow comparing or combining `date`/`datetime` columns with `int` values directly. This causes: *"Operand type clash: date is incompatible with int"*.

**Check the schema's `nativeType` before date operations.** If a column is `date`, `datetime`, `datetime2`, or `smalldatetime`:

**Invalid patterns:**
- `WHERE OrderDate = 2024` — comparing date with integer
- `WHERE OrderDate > 20240101` — integer that looks like a date
- `WHERE OrderDate BETWEEN 2024 AND 2025` — integers, not date strings
- `WHERE OrderDate = YEAR(GETDATE())` — YEAR() returns int
- `WHERE OrderDate + 30 > GETDATE()` — adding int to date without DATEADD

**Valid patterns:**
- `WHERE OrderDate >= '2024-01-01' AND OrderDate < '2025-01-01'` — use date string literals
- `WHERE YEAR(OrderDate) = 2024` — extract int from date, compare int to int
- `WHERE OrderDate > DATEADD(DAY, -30, GETDATE())` — use DATEADD for date arithmetic
- `WHERE OrderDate BETWEEN '2024-01-01' AND '2024-12-31'` — string date literals in BETWEEN

**Solution:** Never compare a date column directly with an integer. Either use string date literals (`'2024-01-01'`) or extract the integer part with `YEAR()`/`MONTH()`/`DAY()` and compare integers to integers.

### 11. ORDER BY is Forbidden in Subqueries Without TOP/OFFSET
ORDER BY cannot appear inside any subquery, CTE, derived table, or inline function unless that same query level also has TOP or OFFSET-FETCH.

**Invalid patterns:**
- `SELECT * FROM (SELECT col FROM table ORDER BY col) t` — ORDER BY without TOP
- Nested subqueries where inner has ORDER BY but no TOP

**Valid patterns:**
- `SELECT * FROM (SELECT TOP 100 col FROM table ORDER BY col) t` — TOP makes ORDER BY valid
- Place ORDER BY only in the outermost SELECT statement
- If you need ordered data in a subquery, you MUST add TOP to that subquery

**Solution:** Either add TOP to the subquery that has ORDER BY, or move ORDER BY to the outermost query.

### 12. UNION / UNION ALL — Row Limits and ORDER BY
In UNION queries, `TOP` and `ORDER BY` can ONLY appear in the **outermost query** or in subqueries wrapped in parentheses.

**Invalid patterns:**
```sql
-- TOP in individual UNION branches (ambiguous syntax)
SELECT TOP 10 col FROM tableA
UNION ALL
SELECT TOP 10 col FROM tableB

-- ORDER BY in individual UNION branches
SELECT col FROM tableA ORDER BY col
UNION ALL
SELECT col FROM tableB
```

**Valid patterns:**
```sql
-- Option 1: Wrap entire UNION in a subquery, apply TOP/ORDER BY outside
SELECT TOP 10 * FROM (
    SELECT col FROM tableA
    UNION ALL
    SELECT col FROM tableB
) AS combined
ORDER BY col

-- Option 2: Use CTEs
WITH combined AS (
    SELECT col FROM tableA
    UNION ALL
    SELECT col FROM tableB
)
SELECT TOP 10 * FROM combined ORDER BY col
```

**Solution:** Always apply TOP and ORDER BY to the outermost query when using UNION/UNION ALL, not to individual branches.

---

## REQUIRED PATTERNS

### Row Limits
Always limit results with TOP clause. Default to 10 rows if user doesn't specify, max 10 rows

### Table Aliases
Always prefix columns with table alias in multi-table queries to avoid ambiguity.

### Balanced Parentheses
Every `(` must have a matching `)`. Verify carefully in nested subqueries and CASE expressions.

### Column Alias References
- Cannot use column aliases in WHERE (use the original expression)
- Can use column aliases in ORDER BY

---

## SYNTAX REFERENCE

| Feature | MSSQL Syntax |
|---------|--------------|
| Row limit | `SELECT TOP n ...` |
| Boolean | `1` (true), `0` (false) — no `TRUE`/`FALSE` keywords |
| NULL check | `IS NULL`, `IS NOT NULL` — never `= NULL` or `= 'null'` |
| String escape | `'O''Brien'` — double single-quotes |
| Current datetime | `GETDATE()` |
| Current date only | `CAST(GETDATE() AS DATE)` |
| Date arithmetic | `DATEADD(unit, count, date)` — units: day, month, year, hour, etc. |
| Last day of month | `EOMONTH(date)` — returns the last day of that month (handles Feb 28/29 etc.) |
| Date difference | `DATEDIFF(unit, start_date, end_date)` |
| String concat | `CONCAT(a, b, ...)` or `a + b` |
| Type conversion | `CAST(expr AS type)` or `CONVERT(type, expr)` |
| Conditional | `CASE WHEN cond THEN val ELSE val END` |
| Coalesce | `COALESCE(a, b, c)` or `ISNULL(a, b)` |
| String contains | `column LIKE '%text%'` |
| Case-insensitive | Use `LOWER()` or `COLLATE` for explicit case handling |
| Insert with return | `INSERT ... OUTPUT INSERTED.*` |
| Pagination | `OFFSET n ROWS FETCH NEXT m ROWS ONLY` (requires ORDER BY) |

---

## COMMON PITFALLS

1. **Division by zero** - Wrap with `NULLIF(denominator, 0)` to return NULL instead of error
1b. **NULL propagation breaks arithmetic AND aggregates** - In SQL, `NULL + <anything> = NULL` (not `<anything>`). If you add/subtract/multiply two or more columns and even ONE is NULL for a row, the whole expression is NULL for that row — and `SUM()`/aggregates silently SKIP NULL rows instead of erroring, so that row's other, real, non-null value is silently dropped from the total. No error, no warning — just a quietly wrong (usually undercounted) aggregate.
   - **Invalid:** `SELECT SUM(FreightAmount + AdvanceAmount) FROM ...` — any row where either column is NULL contributes NOTHING to the sum, even though the other column had a real value.
   - **Invalid:** `SELECT (Revenue - Cost) AS Profit FROM ...` — a NULL `Cost` makes `Profit` NULL instead of just `Revenue`.
   - **Valid:** `SELECT SUM(COALESCE(FreightAmount, 0) + COALESCE(AdvanceAmount, 0)) FROM ...`
   - **Valid:** `SELECT (COALESCE(Revenue, 0) - COALESCE(Cost, 0)) AS Profit FROM ...`
   - **Solution:** Before ANY arithmetic (`+`, `-`, `*`, `/`) across two or more columns — whether bare or inside an aggregate like `SUM(col1 + col2)` — wrap every column that can be NULL in `COALESCE(column, 0)`. Check the schema's `nullable` flag for each operand; if any can be NULL, COALESCE it, not just the denominator.
2. **String to number** - Always check schema nativeType. Use `TRY_CAST(col AS DECIMAL(18,2))` for numeric operations on string columns — never plain `CAST`
3. **Date format** - Use `FORMAT(date, 'yyyy-MM-dd')` for consistent string representation
3b. **Month-end dates** - NEVER hardcode month-end days (e.g., `'2025-02-29'`, `'2025-04-31'`). Use `EOMONTH('2025-02-01')` to get the correct last day. Invalid date literals cause: *"Conversion failed when converting date/time from character string"*
3c. **Date literal format** - ALWAYS use `'YYYY-MM-DD'` ISO format for date string literals (e.g., `'2025-04-01'`). NEVER use `'DD/MM/YYYY'`, `'DD-MM-YYYY'`, or any other format — SQL Server's implicit conversion for non-ISO formats depends on the server's DATEFORMAT setting and will silently fail on some servers. This applies to WHERE clauses, BETWEEN, CONVERT/CAST arguments, and scripts. The only 100% safe formats are `'YYYY-MM-DD'` and `'YYYYMMDD'` (no separators).
4. **Integer division** - `5/2 = 2` — cast to DECIMAL for precise division: `CAST(5 AS DECIMAL)/2 = 2.5`
12. **Empty string vs NULL** - They are different in MSSQL; check for both when needed
13. **OPENJSON column references** - When using OPENJSON, you MUST use JSON_VALUE() to extract values in both SELECT and GROUP BY:
   - **Invalid:** `SELECT MajorCode FROM OPENJSON('[...]')`
   - **Valid:** `SELECT JSON_VALUE(value, '$.MajorCode') as MajorCode FROM OPENJSON('[...]')`
   - In GROUP BY: `GROUP BY JSON_VALUE(value, '$.MajorCode')`
14. **Balanced parentheses** - Always verify parentheses match, especially with nested subqueries and OPENJSON
15. **STRING_AGG does NOT support DISTINCT anywhere** — DISTINCT inside STRING_AGG is illegal in ALL forms. Both patterns below cause `"Incorrect syntax near ','"` or `"Incorrect syntax near 'AS'"`:
   - **Invalid:** `STRING_AGG(DISTINCT col, ', ')` — DISTINCT as first argument
   - **Invalid:** `STRING_AGG(CAST(DISTINCT col AS NVARCHAR(MAX)), ', ')` — DISTINCT inside CAST inside STRING_AGG — also illegal
   - **Valid:** Pre-deduplicate in a subquery, then STRING_AGG outside:
     ```sql
     SELECT main_col, STRING_AGG(col, ', ') AS ValuesAggregated
     FROM (
         SELECT DISTINCT main_col, col FROM source_table
     ) deduped
     GROUP BY main_col
     ```
   - This is also the fix when STRING_AGG produces repeated values (e.g., "PATNA, PATNA, PATNA...") — wrap in a DISTINCT subquery first.

16. **Reserved keyword aliases** - Never use MSSQL reserved keywords as column aliases. Common offenders: `DISTINCT`, `RowCount`, `Key`, `Value`, `Index`, `Plan`, `User`, `Name`, `Type`, `Status`, `Date`, `Order`, `Group`, `Table`, `Column`, `Count`, `Sum`, `Percent`, `Transaction`. Use descriptive alternatives instead: `TotalRows`, `UniqueCount`, `ItemKey`, `ItemValue`, `RecordCount`, `TotalCount`, `PctValue`, etc. **`DISTINCT` is especially common** — never write `COUNT(DISTINCT x) AS DISTINCT`; use `AS UniqueCount`, `AS DistinctCount`, etc.

---
