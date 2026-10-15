# PostgreSQL - Query Rules

## CRITICAL ERRORS (Query Will Fail)

### 1. Aggregate Nesting is Forbidden
PostgreSQL cannot evaluate an aggregate function that contains another aggregate, a subquery, or any expression using an aggregate.

**Invalid patterns:**
- Aggregate inside aggregate: `AVG(MAX(...))`, `SUM(COUNT(...))`, `MIN(SUM(...))`
- Aggregate inside function inside aggregate: `AVG(DATE_PART(..., MAX(...)))`
- Aggregate in CASE inside aggregate: `SUM(CASE WHEN COUNT(...) > 0 THEN ...)`

**Solution:** Use a subquery or CTE to compute inner aggregates first, then apply outer aggregate to the result.

### 2. Aggregates Cannot Appear in GROUP BY
GROUP BY expressions cannot contain any aggregate function - neither directly nor inside CASE, functions, or other expressions.

**Invalid patterns:**
- Direct: `GROUP BY MAX(column)`
- Inside CASE: `GROUP BY CASE WHEN MAX(...) > value THEN ... END`
- Inside function: `GROUP BY DATE_PART('day', MAX(...))`

**Solution:** Compute aggregates in a subquery first, expose as a column, then GROUP BY that column in the outer query.

### 3. Aggregates Cannot Appear in WHERE
WHERE clause cannot reference any aggregate function, even nested inside other functions.

**Invalid:** `WHERE COUNT(*) > 0`, `WHERE SUM(x) > 100`

**Solution:** Use HAVING after GROUP BY for aggregate conditions, or filter via subquery.

### 4. Scalar Subquery Requirement
Subqueries in SELECT clause must return exactly one row and one column.

**Solution:** Use LIMIT 1, or ensure aggregation guarantees single value.

### 5. SELECT-GROUP BY Consistency
Every non-aggregated column in SELECT must appear in GROUP BY. Omitting columns causes "must appear in GROUP BY clause" error.

---

## REQUIRED PATTERNS

### Row Limits
Always end every SELECT with a LIMIT clause, using the exact row count given in the query-generation row-limit instruction (do NOT invent a larger number — the system enforces that cap regardless, so a bigger LIMIT only produces a misleading query).

### Table Aliases
Always prefix columns with table alias in multi-table queries to avoid ambiguity.

### Balanced Parentheses
Every `(` must have a matching `)`. Verify carefully in nested subqueries and CASE expressions.

### ORDER BY Placement
- ORDER BY is valid inside subqueries only when paired with LIMIT
- Can use column aliases in ORDER BY

### Column Alias References
- Cannot use column aliases in WHERE or GROUP BY (use the original expression)
- Can use column aliases in ORDER BY and HAVING

### String Comparisons
- Always use `ILIKE` with `%` wildcards instead of `=` for string comparisons and matching to ensure case-insensitive queries, partial matching, and handle variable inputs gracefully.
  - **Incorrect (no wildcards):** `col ILIKE 'value'`
  - **Correct (with wildcards):** `col ILIKE '%value%'`

---

## SYNTAX REFERENCE

| Feature | PostgreSQL Syntax |
|---------|-------------------|
| Row limit | `SELECT ... LIMIT n` |
| Pagination | `LIMIT n OFFSET m` |
| Boolean | `true`, `false` — lowercase, no quotes |
| NULL check | `IS NULL`, `IS NOT NULL` — never `= NULL` or `= 'null'` |
| String escape | `'O''Brien'` — double single-quotes |
| Current datetime | `NOW()` or `CURRENT_TIMESTAMP` |
| Current date only | `CURRENT_DATE` |
| Date arithmetic | `date_col + INTERVAL '7 days'` or `date_col - INTERVAL '1 month'` |
| Date difference | `date1 - date2` returns integer days, or `AGE(date1, date2)` |
| Date extract | `EXTRACT(unit FROM date_col)` or `DATE_PART('unit', date_col)` |
| Date format | `TO_CHAR(date_col, 'YYYY-MM-DD')` |
| Date truncate | `DATE_TRUNC('month', date_col)` |
| String concat | `a || b` or `CONCAT(a, b)` |
| Type conversion | `col::type` or `CAST(col AS type)` |
| Conditional | `CASE WHEN cond THEN val ELSE val END` |
| Coalesce | `COALESCE(a, b, c)` |
| String contains | `column LIKE '%text%'` |
| Case-insensitive | `column ILIKE '%text%'` |
| Insert with return | `INSERT ... RETURNING *` |
| Upsert | `ON CONFLICT (col) DO UPDATE SET col = EXCLUDED.col` |

---

## COMMON PITFALLS

1. **Division by zero** - Wrap with `NULLIF(denominator, 0)` to return NULL instead of error
2. **Integer division** - `5/2 = 2` — cast to NUMERIC for precise division: `5::NUMERIC/2 = 2.5`
3. **String comparison** - PostgreSQL is case-sensitive by default; use ILIKE or LOWER() for case-insensitive
4. **Date strings** - Use ISO format 'YYYY-MM-DD' or explicit casting
5. **Empty string vs NULL** - They are different in PostgreSQL; check for both when needed
6. **Array syntax** - Use `ARRAY[...]` or `'{...}'::type[]`

---

## PERFORMANCE

- Avoid `SELECT *` — specify only needed columns
- Use indexed columns in WHERE and JOIN conditions
- Prefer JOINs over correlated subqueries when possible
- Limit result sets appropriately
- Use EXPLAIN ANALYZE to verify query plans
