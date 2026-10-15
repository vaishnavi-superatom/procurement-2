#!/usr/bin/env python3
"""
Rewriter tests. No dependencies — run with `python3 test_worker.py`.

Every case under "injection completeness" is a way a policy silently fails to
apply, which is the failure mode this whole component exists to remove. Cases
tagged [delta N] correspond to the numbered deltas from the reference
implementation in backend/docs/SQL-AUTHORIZATION-DESIGN.md.
"""

import sys
import traceback

import worker

BRANCH = {"table": "dw.FactSales", "column": "BranchFK", "op": "in", "values": [16, 22]}
BARE = {"table": "sales", "column": "region_id", "op": "in", "values": [16]}

_results = []


def check(name, fn):
    try:
        fn()
        _results.append((True, name, ""))
    except Exception as err:
        _results.append((False, name, f"{type(err).__name__}: {err}"))
        if "-v" in sys.argv:
            traceback.print_exc()


def rw(sql, read="postgres", write=None, policies=None, readable=None, max_rows=None, allow_writes=False):
    return worker.rewrite({
        "sql": sql, "read": read, "write": write or read,
        "policies": policies or [], "readableTables": readable or [],
        "maxRows": max_rows, "allowWrites": allow_writes,
    })


def rejects(sql, contains=None, **kw):
    try:
        rw(sql, **kw)
    except worker.Rejected as err:
        if contains and contains.lower() not in str(err).lower():
            raise AssertionError(f"rejected, but for the wrong reason: {err}")
        return
    raise AssertionError("expected rejection, query was accepted")


def out(sql, **kw):
    return rw(sql, **kw)["sql"]


def has(sql_text, *fragments):
    low = sql_text.lower()
    for f in fragments:
        assert f.lower() in low, f"missing {f!r} in: {sql_text}"


def count(sql_text, fragment):
    return sql_text.lower().count(fragment.lower())


# ============================================================
# Gate 1 — reads only
# ============================================================

check("gate1: UPDATE rejected", lambda: rejects("UPDATE customer SET name='x'"))
check("gate1: DELETE rejected", lambda: rejects("DELETE FROM customer"))
check("gate1: MERGE rejected", lambda: rejects(
    "MERGE INTO a USING b ON a.id=b.id WHEN MATCHED THEN UPDATE SET a.x=b.x"))
check("gate1: DROP rejected", lambda: rejects("DROP TABLE customer"))
check("gate1: SELECT INTO rejected", lambda: rejects(
    "SELECT * INTO tmp FROM customer", read="tsql", contains="into"))
check("gate1: EXEC rejected [ours]", lambda: rejects("EXEC sp_who", read="tsql", contains="execute"))
check("gate1: COPY FROM PROGRAM rejected [ours]", lambda: rejects(
    "COPY t FROM PROGRAM 'sh'", contains="copy"))
check("gate1: ATTACH rejected [ours]", lambda: rejects(
    "ATTACH 'x.db'", read="duckdb", contains="attach"))
check("gate1: INSTALL rejected [ours]", lambda: rejects("INSTALL httpfs", read="duckdb"))
check("gate1: stacked DROP reported as DROP, not as statement count",
      lambda: rejects("SELECT id FROM customer; DROP TABLE customer", contains="drop"))
check("gate1: writable CTE rejected", lambda: rejects(
    "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", contains="delete"))
check("gate1: harmless multi-statement still rejected",
      lambda: rejects("SELECT 1; SELECT 2", contains="single statement"))
check("gate1: duckdb read_csv rejected [ours]", lambda: rejects(
    "SELECT * FROM read_csv('/etc/passwd')", read="duckdb", contains="filesystem"))
check("gate1: duckdb read_parquet rejected [ours]", lambda: rejects(
    "SELECT * FROM read_parquet('/x.pq')", read="duckdb", contains="filesystem"))
check("gate1: read_csv allowed on non-duckdb dialects (not a file read there)",
      lambda: out("SELECT * FROM read_csv('x')", read="postgres"))
check("gate1: plain SELECT passes", lambda: out("SELECT a FROM t"))


# ============================================================
# Gate 2 — injection completeness
# ============================================================

def union_both_branches():
    # [delta 1] the reference `break` filters only the first branch
    s = out("SELECT BranchFK FROM dw.FactSales a UNION ALL SELECT BranchFK FROM dw.FactSales b",
            policies=[BRANCH])
    assert count(s, "branchfk in (16, 22)") == 2, s


def self_join_both_aliases():
    # [delta 1] one select, two aliases — both halves must be constrained
    s = out("SELECT * FROM dw.FactSales a JOIN dw.FactSales b ON a.id=b.id", policies=[BRANCH])
    has(s, "a.BranchFK IN (16, 22)", "b.BranchFK IN (16, 22)")


def no_ancestor_on_first_match():
    # [delta 1] the reference breaks after the first NAME match even when it
    # injected nothing, leaving the query entirely unfiltered
    s = out("WITH c AS (SELECT 1 AS x) SELECT * FROM dw.FactSales", policies=[BRANCH])
    has(s, "BranchFK IN (16, 22)")


def unusual_alias():
    # [delta 2] the reference hardcodes the alias in the predicate text
    s = out("SELECT * FROM dw.FactSales AS whatever", policies=[BRANCH])
    has(s, "whatever.BranchFK IN (16, 22)")


def no_alias():
    # [delta 2]
    s = out("SELECT * FROM dw.FactSales", policies=[BRANCH])
    has(s, "BranchFK IN (16, 22)")


def existing_where_anded():
    s = out("SELECT * FROM dw.FactSales WHERE FiscalYear = 2026", policies=[BRANCH])
    has(s, "FiscalYear = 2026", "and", "BranchFK IN (16, 22)")


def contradictory_predicate_survives():
    s = out("SELECT * FROM dw.FactSales WHERE BranchFK = 99", policies=[BRANCH])
    has(s, "BranchFK = 99", "BranchFK IN (16, 22)")


def nested_lands_inner():
    import sqlglot
    from sqlglot import exp
    s = out("SELECT * FROM (SELECT BranchFK, NetSales FROM dw.FactSales) x", policies=[BRANCH])
    tree = sqlglot.parse_one(s, "postgres")
    assert tree.args.get("where") is None, f"outer select was filtered instead of inner: {s}"
    inner = tree.find(exp.Subquery).this
    assert inner.args.get("where") is not None, f"inner select was not filtered: {s}"
    has(s, "BranchFK IN (16, 22)")


def cte_alias_collision_not_treated_as_table():
    # [delta 4] the CTE reference is query-local; the real table inside it is
    # what gets constrained
    s = out("WITH FactSales AS (SELECT * FROM dw.FactSales) SELECT * FROM FactSales",
            policies=[BRANCH])
    assert count(s, "branchfk in (16, 22)") == 1, s


def schema_qualification_distinguishes():
    # [delta 4] a policy on dw.FactSales must not filter staging.FactSales
    s = out("SELECT * FROM staging.FactSales", policies=[BRANCH])
    assert "branchfk in" not in s.lower(), s


def bare_policy_matches_bare_name():
    s = out("SELECT * FROM sales", policies=[BARE])
    has(s, "region_id IN (16)")


def string_values_typed_as_strings():
    s = out("SELECT * FROM sales", policies=[
        {"table": "sales", "column": "region", "op": "in", "values": ["North", "South"]}])
    has(s, "'North'", "'South'")


def quote_in_value_cannot_escape():
    s = out("SELECT * FROM sales", policies=[
        {"table": "sales", "column": "region", "op": "in", "values": ["North') OR (1=1"]}])
    assert "or (1=1)" not in s.lower().replace(" ", " "), s
    has(s, "''")  # the quote is escaped inside the literal, not closing it


def global_filter_all_root_selects():
    # [delta 5] the reference targets only the first select of a UNION
    s = out("SELECT region_id FROM a UNION ALL SELECT region_id FROM b",
            policies=[{"column": "region_id", "op": "in", "values": [16]}])
    assert count(s, "region_id in (16)") == 2, s


def not_in_operator():
    s = out("SELECT * FROM sales", policies=[
        {"table": "sales", "column": "region_id", "op": "not_in", "values": [9]}])
    has(s, "not", "region_id in (9)")


def applied_is_reported():
    r = rw("SELECT * FROM dw.FactSales", policies=[BRANCH])
    assert r["applied"] == ["dw.FactSales.BranchFK"], r["applied"]


def policy_for_untouched_table_is_noop():
    s = out("SELECT * FROM other_table", policies=[BRANCH])
    assert "branchfk" not in s.lower(), s


for name, fn in [
    ("gate2: UNION — both branches filtered [delta 1]", union_both_branches),
    ("gate2: self-join — both aliases filtered [delta 1]", self_join_both_aliases),
    ("gate2: no-ancestor first match does not abort injection [delta 1]", no_ancestor_on_first_match),
    ("gate2: predicate uses the query's own alias [delta 2]", unusual_alias),
    ("gate2: unaliased table [delta 2]", no_alias),
    ("gate2: existing WHERE is AND-ed, not replaced", existing_where_anded),
    ("gate2: agent's contradictory predicate survives alongside ours", contradictory_predicate_survives),
    ("gate2: nested sub-select gets the predicate, not the outer", nested_lands_inner),
    ("gate2: CTE alias collision not treated as the table [delta 4]", cte_alias_collision_not_treated_as_table),
    ("gate2: dw.X and staging.X are distinct [delta 4]", schema_qualification_distinguishes),
    ("gate2: bare policy matches bare table name", bare_policy_matches_bare_name),
    ("gate2: string values typed as string literals", string_values_typed_as_strings),
    ("gate2: quote in a policy value cannot escape the literal [delta 2]", quote_in_value_cannot_escape),
    ("gate2: global filter hits all root selects [delta 5]", global_filter_all_root_selects),
    ("gate2: not_in operator", not_in_operator),
    ("gate2: applied policies reported back", applied_is_reported),
    ("gate2: policy for an untouched table is a no-op", policy_for_untouched_table_is_noop),
]:
    check(name, fn)


# ============================================================
# Gate 3 — table allow-list
# ============================================================

# ---- malformed policies: reject clearly, never crash ----------------------
check("policy: nested SourcePolicy shape rejected clearly, not KeyError", lambda: rejects(
    "SELECT * FROM sales",
    policies=[{"sourceId": "s1", "rowFilters": [{"table": "sales", "column": "x", "values": [1]}]}],
    contains="no 'column'"))
check("policy: missing values rejected clearly", lambda: rejects(
    "SELECT * FROM sales", policies=[{"table": "sales", "column": "x"}], contains="no values"))
check("policy: non-object entry rejected clearly", lambda: rejects(
    "SELECT * FROM sales", policies=["not-a-policy"], contains="expected an object"))

check("gate3: table outside the allow-list rejected [delta 3]", lambda: rejects(
    "SELECT * FROM dw.FactSales JOIN secret.Payroll p ON 1=1",
    readable=["dw.FactSales"], contains="not readable"))
check("gate3: allow-listed tables pass [delta 3]",
      lambda: out("SELECT * FROM dw.FactSales", readable=["dw.FactSales"]))
check("gate3: CTE names are not tables [delta 3]",
      lambda: out("WITH x AS (SELECT * FROM dw.FactSales) SELECT * FROM x",
                  readable=["dw.FactSales"]))
check("gate3: empty allow-list is a no-op, not a blanket reject",
      lambda: out("SELECT * FROM anything", readable=[]))
check("gate3: unqualified reference matches a qualified allow-list entry",
      lambda: out("SELECT * FROM FactSales", readable=["dw.FactSales"]))


# ============================================================
# Row cap
# ============================================================

def cap_probe_is_plus_one():
    r = rw("SELECT a FROM t", max_rows=50)
    assert r["cappedTo"] == 50 and r["probeLimit"] == 51, r
    has(r["sql"], "limit 51")


def cap_renders_as_top_on_mssql():
    s = out("SELECT a FROM t", read="tsql", max_rows=50)
    has(s, "top 51")


def cap_skips_scalar_aggregate():
    r = rw("SELECT COUNT(*) FROM t", max_rows=50)
    assert r["cappedTo"] is None, r
    assert "limit" not in r["sql"].lower(), r["sql"]


def cap_applies_to_grouped_aggregate():
    r = rw("SELECT k, COUNT(*) FROM t GROUP BY k", max_rows=50)
    assert r["cappedTo"] == 50, r


def cap_respects_smaller_agent_limit():
    r = rw("SELECT a FROM t LIMIT 5", max_rows=50)
    assert r["cappedTo"] is None, r
    has(r["sql"], "limit 5")


def cap_overrides_larger_agent_limit():
    r = rw("SELECT a FROM t LIMIT 100000", max_rows=50)
    has(r["sql"], "limit 51")


def cap_not_pushed_into_cte():
    s = out("WITH x AS (SELECT a FROM t) SELECT k, COUNT(*) FROM x GROUP BY k", max_rows=50)
    inner = s.lower().index("with x as")
    close = s.index(")", inner)
    assert "limit" not in s.lower()[inner:close], s


for name, fn in [
    ("cap: probe is cap+1, reported as cappedTo", cap_probe_is_plus_one),
    ("cap: renders as TOP on mssql", cap_renders_as_top_on_mssql),
    ("cap: scalar aggregate not capped", cap_skips_scalar_aggregate),
    ("cap: grouped aggregate IS capped", cap_applies_to_grouped_aggregate),
    ("cap: agent's smaller limit respected", cap_respects_smaller_agent_limit),
    ("cap: agent's larger limit overridden", cap_overrides_larger_agent_limit),
    ("cap: never pushed into a CTE", cap_not_pushed_into_cte),
]:
    check(name, fn)


# ============================================================
# Dialects and failure modes
# ============================================================

check("dialect: tsql in, duckdb out", lambda: has(
    out("SELECT TOP 5 a FROM t", read="tsql", write="duckdb"), "limit 5"))
check("dialect: postgres in, tsql out", lambda: out("SELECT a FROM t LIMIT 5",
                                                    read="postgres", write="tsql"))
check("failure: unparseable SQL rejected", lambda: rejects(
    "SELECT FROM WHERE ((", contains="parsed"))
check("failure: empty SQL rejected", lambda: rejects("   ", contains="empty"))
check("failure: unsupported policy operator rejected", lambda: rejects(
    "SELECT * FROM sales", policies=[{"table": "sales", "column": "x", "op": "regex", "values": [1]}],
    contains="operator"))
check("worker: bad request never raises out of handle",
      lambda: worker.handle({"op": "ping"}))


# ============================================================
# Report
# ============================================================

failed = [r for r in _results if not r[0]]
for ok, name, err in _results:
    if not ok or "-v" in sys.argv:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
        if err:
            print(f"      {err}")
print(f"\n{len(_results) - len(failed)}/{len(_results)} passed")
sys.exit(1 if failed else 0)
