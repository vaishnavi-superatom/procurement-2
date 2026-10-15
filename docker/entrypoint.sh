#!/bin/sh
# Runs before the backend on every container start: wait for the project
# database, apply migrations, ensure this project's project_details row exists.
set -e

: "${PROJECT_DATABASE_URL:?PROJECT_DATABASE_URL is required}"

echo "[entrypoint] waiting for the project database..."
until pg_isready -q -d "$PROJECT_DATABASE_URL"; do sleep 1; done

echo "[entrypoint] applying migrations..."
(cd /app/database/postgres && node_modules/.bin/tsx scripts/run-migrations.ts)

# The answer agent's shared prompt parts live in the DB, built from system.md.
# Re-published every start so an image update reaches them; an upsert, so safe.
echo "[entrypoint] publishing the answer agent's shared prompt parts..."
(cd /app/backend && node_modules/.bin/tsx scripts/graph-seed.ts --publish) \
  || echo "[entrypoint] WARNING: graph-seed failed — routed answers fall back to system.md"

# project_sources has an FK to project_details (setup.sh inserts the same row).
if [ -n "$SUPERATOM_PROJECT_ID" ]; then
  psql "$PROJECT_DATABASE_URL" -q -v ON_ERROR_STOP=1 -v pid="$SUPERATOM_PROJECT_ID" <<'SQL'
INSERT INTO project_details (id, name, description, database_type)
VALUES (:'pid', :'pid', 'Superatom project', 'multi-source')
ON CONFLICT (id) DO NOTHING;
SQL
fi

echo "[entrypoint] starting: $*"
exec "$@"
