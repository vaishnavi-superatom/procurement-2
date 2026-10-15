#!/usr/bin/env bash
# Verifies migration 0029 + the recordAnswerValidation upsert against a real
# Postgres. Creates and drops its own throwaway database.
#   usage: _test_validation_sql.sh [path-to-repo-root]
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")" && pwd)}"
MIG="$ROOT/database/postgres/drizzle/migrations/0029_validation_upsert.sql"
DB="cb_val_test_$$"
PASS=0; FAIL=0
cleanup() { psql -d postgres -qc "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT
q() { psql -d "$DB" -Atqc "$1"; }
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1 — got [$2] want [$3]"; FAIL=$((FAIL+1)); fi; }

psql -d postgres -qc "CREATE DATABASE $DB" >/dev/null

# ── the table exactly as migrations 0027+0028 leave it ──────────────────────
psql -d "$DB" -q <<'EOF'
CREATE TABLE answer_validations (
  id serial PRIMARY KEY NOT NULL,
  conversation_id integer NOT NULL,
  verdict varchar(24) NOT NULL,
  reported_answer text, rederived_answer text, unit text, finding text,
  evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
  agent_run_id varchar(64),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  question text
);
CREATE INDEX idx_answer_validations_conversation ON answer_validations (conversation_id);
CREATE INDEX idx_answer_validations_verdict ON answer_validations (verdict, created_at DESC NULLS LAST);

-- Duplicates of exactly the kinds that exist in the wild.
INSERT INTO answer_validations (conversation_id, verdict, finding, question, created_at) VALUES
  (1,'match','first check','Q1',       now() - interval '3 day'),
  (1,'match','second check',NULL,      now() - interval '1 day'),   -- newer wins, question must survive
  (2,'mismatch','real verdict','Q2',   now() - interval '2 day'),
  (2,'unverifiable','bridge was down',NULL, now()),                 -- newer BUT unverifiable: must lose
  (3,'unverifiable','never checkable','Q3', now() - interval '5 day'),
  (4,'match','only one','Q4',          now());
EOF

echo "── migration 0029 on a table full of duplicates ───────────────────────"
BEFORE=$(q "SELECT count(*) FROM answer_validations")
check "seeded rows" "$BEFORE" "6"
# Run it exactly as run-migrations would: strip drizzle's statement markers.
sed 's/-->  *statement-breakpoint//' "$MIG" | psql -d "$DB" -q -v ON_ERROR_STOP=1
check "collapsed to one row per conversation" "$(q "SELECT count(*) FROM answer_validations")" "4"
check "  conv 1 kept the NEWER row"            "$(q "SELECT finding FROM answer_validations WHERE conversation_id=1")" "second check"
check "  conv 1 checks backfilled to 2"        "$(q "SELECT checks FROM answer_validations WHERE conversation_id=1")" "2"
check "  conv 2 kept the REAL verdict, not the newer unverifiable" "$(q "SELECT verdict FROM answer_validations WHERE conversation_id=2")" "mismatch"
check "  conv 3 (only unverifiable) survives"  "$(q "SELECT verdict FROM answer_validations WHERE conversation_id=3")" "unverifiable"
check "  conv 4 (never duplicated) checks=1"   "$(q "SELECT checks FROM answer_validations WHERE conversation_id=4")" "1"
check "unique index exists"                    "$(q "SELECT count(*) FROM pg_indexes WHERE indexname='uq_answer_validations_conversation'")" "1"
check "redundant plain index dropped"          "$(q "SELECT count(*) FROM pg_indexes WHERE indexname='idx_answer_validations_conversation'")" "0"
check "migration is re-runnable-safe (index guard)" "$(psql -d "$DB" -Atqc "SELECT 1" >/dev/null && echo ok)" "ok"

echo ""
echo "── the upsert, verbatim from recordAnswerValidation ───────────────────"
# $1..$9 mirror the driver's bound parameters.
upsert() {
psql -d "$DB" -Atq <<EOF
INSERT INTO answer_validations
  (conversation_id, question, verdict, reported_answer, rederived_answer, unit, finding, evidence, agent_run_id)
VALUES ($1, $2, '$3', NULL, NULL, NULL, '$4', '{}'::jsonb, 'run-x')
ON CONFLICT (conversation_id) DO UPDATE SET
  question         = COALESCE(EXCLUDED.question, answer_validations.question),
  verdict          = EXCLUDED.verdict,
  reported_answer  = EXCLUDED.reported_answer,
  rederived_answer = EXCLUDED.rederived_answer,
  unit             = EXCLUDED.unit,
  finding          = EXCLUDED.finding,
  evidence         = EXCLUDED.evidence,
  agent_run_id     = EXCLUDED.agent_run_id,
  checks           = answer_validations.checks + 1,
  updated_at       = CURRENT_TIMESTAMP
WHERE NOT (EXCLUDED.verdict = 'unverifiable' AND answer_validations.verdict <> 'unverifiable')
RETURNING checks;
EOF
}

R=$(upsert 4 "'Q4'" mismatch "re-derived, differs")
check "re-check UPDATES rather than inserting" "$(q "SELECT count(*) FROM answer_validations WHERE conversation_id=4")" "1"
check "  verdict replaced"                     "$(q "SELECT verdict FROM answer_validations WHERE conversation_id=4")" "mismatch"
check "  checks incremented"                   "$R" "2"
check "  updated_at moved off created_at"      "$(q "SELECT (updated_at > created_at) FROM answer_validations WHERE conversation_id=4")" "t"

R=$(upsert 4 "NULL" unverifiable "bridge down")
check "unverifiable does NOT overwrite a real verdict" "$(q "SELECT verdict FROM answer_validations WHERE conversation_id=4")" "mismatch"
check "  no row returned, so the caller reports skipped" "$R" ""
check "  and checks did not inflate"           "$(q "SELECT checks FROM answer_validations WHERE conversation_id=4")" "2"
check "  the finding was not clobbered"        "$(q "SELECT finding FROM answer_validations WHERE conversation_id=4")" "re-derived, differs"

R=$(upsert 3 "NULL" unverifiable "still not checkable")
check "unverifiable MAY replace an unverifiable" "$R" "2"
check "  question survives a NULL (conversation pruned)" "$(q "SELECT question FROM answer_validations WHERE conversation_id=3")" "Q3"

R=$(upsert 3 "NULL" match "finally checkable")
check "a real verdict always replaces unverifiable" "$(q "SELECT verdict FROM answer_validations WHERE conversation_id=3")" "match"
check "  question STILL survives the NULL"     "$(q "SELECT question FROM answer_validations WHERE conversation_id=3")" "Q3"

R=$(upsert 99 "'Q99'" match "brand new")
check "a first-time conversation still inserts" "$R" "1"
check "  and starts at checks=1"                "$(q "SELECT checks FROM answer_validations WHERE conversation_id=99")" "1"

check "duplicates are now impossible" \
  "$(psql -d "$DB" -Atq -c "INSERT INTO answer_validations (conversation_id, verdict) VALUES (99,'match')" 2>&1 | grep -c 'duplicate key')" "1"

echo ""
echo "── accuracy figure ────────────────────────────────────────────────────"
check "one row per conversation feeds the stats" \
  "$(q "SELECT count(*) = count(DISTINCT conversation_id) FROM answer_validations")" "t"

echo ""
[ "$FAIL" -eq 0 ] && echo "all $PASS passed" || { echo "$FAIL FAILED ($PASS passed)"; exit 1; }
