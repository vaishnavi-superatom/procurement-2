"""
Per-dialect escape hatches for the rewriter.

Two seams, both deliberately narrow:

  pre-AST   text in  -> text out, before parsing. For syntax SQLGlot does not
                        model and would reject outright.
  post-text text in  -> text out, after rendering. For syntax the target
                        engine needs and SQLGlot will not emit.

Every hook here is a liability: it operates on text, which is exactly what the
AST pipeline exists to avoid. Add one only when a dialect genuinely cannot be
modelled, keep it as narrow as the case requires, and say why.

Phase 1 ships with none. The registries exist so that adding one later is a
local change with an obvious home, rather than a special case smuggled into
worker.py.
"""

# dialect -> list of callables (str) -> str
PRE_AST_HOOKS = {}
POST_TEXT_HOOKS = {}


def apply_pre_ast_hooks(sql, dialect):
    for hook in PRE_AST_HOOKS.get(dialect, ()):
        sql = hook(sql)
    return sql


def apply_post_text_hooks(sql, dialect):
    for hook in POST_TEXT_HOOKS.get(dialect, ()):
        sql = hook(sql)
    return sql
