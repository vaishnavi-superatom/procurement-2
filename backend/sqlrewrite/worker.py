#!/usr/bin/env python3
"""
SQL authorization rewriter — one long-lived worker process.

Reads line-delimited JSON requests on stdin, writes one JSON response per line
to stdout. Holds no state between requests and never exits on a bad one: every
request is answered, so the Node side's checkout slot is always returned.

See backend/docs/SQL-AUTHORIZATION-DESIGN.md for the design. In short: agent
SQL is parsed to an AST, gated, has the caller's policies injected as
predicates, and is re-rendered. What reaches the database is our output, never
the agent's input.

Request:
  {"id": 7, "op": "rewrite", "sql": "...", "read": "tsql", "write": "tsql",
   "policies": [...], "readableTables": [...], "maxRows": 50, "allowWrites": false}
Response:
  {"id": 7, "ok": true, "sql": "...", "cappedTo": 50, "probeLimit": 51, "applied": [...]}
  {"id": 7, "ok": false, "error": "query rejected — ..."}
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import sqlglot  # noqa: E402
from sqlglot import exp  # noqa: E402

from hooks import apply_post_text_hooks, apply_pre_ast_hooks  # noqa: E402

# Gate 1. Node types, not spellings: a DROP hidden in a second statement, a
# subquery or a CTE is still a node in the same tree.
#
# The last row is ours, added after checking what our dialects actually parse
# to. `EXEC sp_who` (tsql) is exp.Execute, NOT exp.Command; `COPY t FROM
# PROGRAM 'sh'` (postgres) is exp.Copy; `ATTACH`/`INSTALL` (duckdb) are their
# own nodes. Each of those is a live statement type on a source we ship, and
# none is covered by exp.Command.
FORBIDDEN = (
    exp.Insert, exp.Update, exp.Delete, exp.Merge, exp.Create, exp.Drop,
    exp.Alter, exp.TruncateTable, exp.Command, exp.Grant, exp.Into,
    exp.Execute, exp.Copy, exp.Attach, exp.Detach, exp.Install,
    exp.Use, exp.Set, exp.Pragma,
)

# DuckDB reads the local filesystem through table functions, which parse as an
# ordinary Select — no node type marks them. Our excel/csv/federation sources
# all speak duckdb, so `SELECT * FROM read_csv('/etc/passwd')` is a plain read
# that Gate 1 cannot see and the regex guard never blocked either. Gate 3 would
# reject it once readableTables is populated (Phase 3); until then this is the
# only thing standing in front of it.
DUCKDB_DIALECTS = {"duckdb"}
FILE_FUNCTIONS = {
    "read_csv", "read_csv_auto", "read_parquet", "read_json", "read_json_auto",
    "read_ndjson", "read_ndjson_auto", "read_text", "read_blob", "glob",
    "parquet_scan", "csv_scan", "json_scan", "delta_scan", "iceberg_scan",
}


class Rejected(Exception):
    """A query we refuse to run. The message reaches the caller verbatim."""


class PolicyError(Rejected):
    """
    A malformed access policy — a CONFIGURATION problem, not an unsafe statement.

    Kept distinct because the two must be handled differently by mode: an unsafe
    statement is refused in every mode, but a bad policy only matters where
    policies are actually applied. Shadow mode never injects, so blocking there
    protects nothing and merely breaks the query.
    """


# ============================================================
# Naming helpers
# ============================================================

def _qualified_name(tbl):
    """`db.schema.table` from the parts the query actually wrote, lowercased."""
    parts = [p for p in (tbl.catalog, tbl.db, tbl.name) if p]
    return ".".join(parts).lower()


def _table_matches(tbl, policy_table):
    """
    Match a table reference against a policy's table name.

    A qualified policy ("dw.FactSales") matches only the same qualified name,
    so `dw.FactSales` and `staging.FactSales` stay distinct. A bare policy
    ("FactSales") falls back to bare-name matching, which is what an
    unqualified policy is asking for.
    """
    want = str(policy_table).lower()
    if "." in want:
        return _qualified_name(tbl) == want
    return (tbl.name or "").lower() == want


def _cte_names(root):
    """
    CTE aliases anywhere in the tree. These are query-local names, not real
    tables: a policy on `FactSales` must not attach to a CTE that happens to be
    called FactSales, and Gate 3 must not reject one.

    Collecting them globally rather than per-scope is deliberately
    over-inclusive. The cost is that a policy table shadowed by a same-named
    CTE gets no predicate at that reference — but the CTE's own body still
    reads the real table and IS injected there, and Gate 3 backstops anything
    the body reads instead. Rejecting on collision was considered and dropped:
    `WITH FactSales AS (SELECT ... FROM dw.FactSales ...)` is plausible,
    legitimate agent output.
    """
    return {(c.alias_or_name or "").lower() for c in root.find_all(exp.CTE)}


# ============================================================
# Gate 1 — reads only, structurally
# ============================================================

def enforce_read_only(root, allow_writes):
    if allow_writes:
        return
    found = root.find(*FORBIDDEN)
    if found is not None:
        raise Rejected(
            f"query rejected — this source is READ-ONLY and the query contains "
            f"a {found.key.upper()} operation"
        )
    if root.find(exp.Select) is None:
        raise Rejected("query rejected — this source is READ-ONLY and the query is not a SELECT")


def enforce_file_functions(root, dialect):
    """Block DuckDB's filesystem-reading table functions. See FILE_FUNCTIONS."""
    if dialect not in DUCKDB_DIALECTS:
        return
    # SQLGlot models some of these as dedicated nodes (ReadCSV, ReadParquet)
    # and leaves the rest as Anonymous, so match on the function NAME across
    # every Func node rather than on node type.
    for fn in root.find_all(exp.Func):
        if isinstance(fn, exp.Anonymous):
            name = fn.this if isinstance(fn.this, str) else ""
        else:
            try:
                name = fn.sql_name()
            except Exception:
                name = type(fn).__name__
        if name and name.lower() in FILE_FUNCTIONS:
            raise Rejected(
                f"query rejected — '{name}' reads the local filesystem and is not "
                f"permitted; query the loaded tables instead"
            )


# ============================================================
# Gate 2 — policy injection
# ============================================================

def _literal(value):
    if isinstance(value, bool):
        return exp.Boolean(this=value)
    if isinstance(value, (int, float)):
        return exp.Literal.number(value)
    if value is None:
        return exp.Null()
    return exp.Literal.string(str(value))


def _build_predicate(pol, alias):
    """
    Build the predicate as AST nodes at the injection site.

    Two things this buys over a SQL-text fragment: the alias is the one THIS
    query wrote (`FROM dw.FactSales AS whatever` works), and policy values
    never pass through string concatenation, so a value drawn from a user
    attribute cannot inject SQL into the policy itself.
    """
    col = exp.column(pol["column"], table=alias or None)
    op = str(pol.get("op", "in")).lower()
    values = pol.get("values", [])

    if op in ("in", "not_in"):
        node = exp.In(this=col, expressions=[_literal(v) for v in values])
        return exp.Not(this=node) if op == "not_in" else node
    if op in ("eq", "ne"):
        one = _literal(values[0] if values else None)
        return exp.EQ(this=col, expression=one) if op == "eq" else exp.NEQ(this=col, expression=one)
    raise PolicyError(f"unsupported policy operator '{op}'")


def inject_policies(root, policies):
    """
    Turn authorization from a check into a transformation: rather than deciding
    whether a query is permitted, add the caller's restrictions so that it is.

    `sel.where(...)` ANDs into any existing WHERE, creating one if absent. It
    cannot be escaped by the surrounding query text because at the point it is
    applied it is not text.
    """
    applied = []
    if not policies:
        return applied

    ctes = _cte_names(root)

    for pol in policies:
        # Validate shape before use. A policy is authored by a human in an admin
        # field and arrives here as free-form JSON; indexing it blindly turned a
        # wrong shape into "rewriter internal error: KeyError: 'column'", which
        # blocked every query on the source with nothing naming the cause.
        # Confirmed live when nested {sourceId, rowFilters[]} objects were passed
        # where flat row filters were expected.
        if not isinstance(pol, dict):
            raise PolicyError(f"malformed access policy (expected an object, got {type(pol).__name__})")
        if not pol.get("column"):
            raise PolicyError(
                "malformed access policy: no 'column'. Expected a flat row filter "
                "{table, column, op, values}; got keys " + str(sorted(pol.keys()))
            )
        if not pol.get("values"):
            raise PolicyError(f"access policy for '{pol['column']}' has no values")

        table = pol.get("table")
        targets = []  # (select_node, alias) — every match, no break

        if table:
            for tbl in root.find_all(exp.Table):
                if not _table_matches(tbl, table):
                    continue
                if not tbl.db and not tbl.catalog and (tbl.name or "").lower() in ctes:
                    continue
                sel = tbl.find_ancestor(exp.Select)
                if sel is not None:
                    targets.append((sel, tbl.alias_or_name))
        else:
            # Global filter — last resort. Every root-level select, so a
            # top-level UNION gets both branches, not just the first.
            for sel in _root_selects(root):
                targets.append((sel, None))

        # Dedup on (select, alias), NOT on select alone: a self-join
        # `FROM t a JOIN t b` lives in one select and needs BOTH aliases
        # constrained, or half the join is unfiltered.
        seen = set()
        for sel, alias in targets:
            key = (id(sel), (alias or "").lower())
            if key in seen:
                continue
            seen.add(key)
            sel.where(_build_predicate(pol, alias), copy=False)
            applied.append(f"{table or '*'}.{pol['column']}")

    return applied


def _root_selects(root):
    """Root-level selects: the statement itself, or every branch of a set operation."""
    if isinstance(root, exp.Select):
        return [root]
    if isinstance(root, exp.SetOperation):
        out = []
        for side in (root.this, root.expression):
            if isinstance(side, exp.Select):
                out.append(side)
            elif isinstance(side, exp.SetOperation):
                out.extend(_root_selects(side))
        return out
    found = root.find(exp.Select)
    return [found] if found is not None else []


# ============================================================
# Gate 3 — table allow-list
# ============================================================

def enforce_table_allowlist(root, readable):
    """
    Injection alone is fail-open: a policy on `dw.FactSales` does nothing when
    the agent reads a view, a synonym, or a differently-named table holding the
    same rows. This closes that, on a traversal we are already doing.
    """
    if not readable:
        return
    allowed = {str(t).lower() for t in readable}
    bare_allowed = {t.split(".")[-1] for t in allowed}
    ctes = _cte_names(root)

    for tbl in root.find_all(exp.Table):
        qualified = _qualified_name(tbl)
        bare = (tbl.name or "").lower()
        if not bare or bare in ctes:
            continue
        if qualified in allowed or (not tbl.db and not tbl.catalog and bare in bare_allowed):
            continue
        raise Rejected(
            f"query rejected — table '{qualified}' is not readable by this user"
        )


# ============================================================
# Row cap
# ============================================================

def _is_scalar_aggregate(sel):
    """SELECT COUNT(*) FROM t — one row by construction, so a cap is noise."""
    if sel.args.get("group"):
        return False
    return any(e.find(exp.AggFunc) is not None for e in sel.expressions)


def enforce_cap(root, max_rows):
    """
    Cap the OUTERMOST select only — never a CTE or subquery, which would sample
    the input before aggregation and silently corrupt every aggregate.

    Injects `max_rows + 1` so truncation is detected exactly rather than
    inferred: if the extra row comes back there is genuinely more data; if it
    does not, the result is complete, including when it lands precisely on the
    cap. A cap applied silently is indistinguishable, to the caller, from
    "that is all the data".
    """
    if not max_rows or max_rows <= 0:
        return None, None

    probe = max_rows + 1
    targets = [root] if isinstance(root, (exp.Select, exp.SetOperation)) else _root_selects(root)

    capped = False
    for node in targets:
        if isinstance(node, exp.Select) and _is_scalar_aggregate(node):
            continue
        existing = node.args.get("limit")
        if existing is not None:
            try:
                current = int(existing.expression.name)
                if current <= probe:
                    continue  # the agent asked for less than we allow; leave it
            except (AttributeError, ValueError):
                pass
        node.set("limit", exp.Limit(expression=exp.Literal.number(probe)))
        capped = True

    return (max_rows, probe) if capped else (None, None)


# ============================================================
# Pipeline
# ============================================================

def rewrite(req):
    sql = req.get("sql")
    if not isinstance(sql, str) or not sql.strip():
        raise Rejected("query rejected — empty SQL")

    read = req.get("read") or None
    write = req.get("write") or read

    sql = apply_pre_ast_hooks(sql, read)

    try:
        statements = sqlglot.parse(sql, read=read)
    except Exception as err:
        raise Rejected(f"query rejected — could not be parsed: {err}")

    statements = [s for s in statements if s is not None]
    if not statements:
        raise Rejected("query rejected — no statement found")

    # Gate 1 runs over EVERY parsed statement before the single-statement
    # check, so `SELECT 1; DROP TABLE t` is reported as the DROP it is rather
    # than as a statement-count problem. Stacked injection is caught by tree
    # traversal, not by statement splitting.
    allow_writes = bool(req.get("allowWrites"))
    for st in statements:
        enforce_read_only(st, allow_writes)
        enforce_file_functions(st, read)

    if len(statements) > 1:
        raise Rejected("query rejected — only a single statement is allowed")

    root = statements[0]
    applied = inject_policies(root, req.get("policies") or [])
    enforce_table_allowlist(root, req.get("readableTables") or [])
    capped_to, probe = enforce_cap(root, req.get("maxRows"))

    out = root.sql(dialect=write)
    out = apply_post_text_hooks(out, write)

    return {"ok": True, "sql": out, "cappedTo": capped_to, "probeLimit": probe, "applied": applied}


def handle(req):
    op = req.get("op", "rewrite")
    if op == "ping":
        return {"ok": True, "pong": True, "sqlglot": sqlglot.__version__}
    if op == "rewrite":
        return rewrite(req)
    raise Rejected(f"unknown op '{op}'")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            res = handle(req)
        except PolicyError as err:
            # Separate kind: the caller decides by mode whether a bad policy is
            # fatal. See sql-rewrite.ts.
            res = {"ok": False, "kind": "policy", "error": str(err)}
        except Rejected as err:
            # "rejected" = we understood the query and refuse it. The caller
            # surfaces this to the user. "internal" = we failed to do our job,
            # which is an availability problem and is handled differently.
            res = {"ok": False, "kind": "rejected", "error": str(err)}
        except Exception as err:  # never die on a bad request
            res = {"ok": False, "kind": "internal",
                   "error": f"rewriter internal error: {type(err).__name__}: {err}"}
        res["id"] = req_id
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
