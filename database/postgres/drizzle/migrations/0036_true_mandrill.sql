-- What a thread was started on: `{ dashboardId }` for a thread begun by asking
-- about a dashboard, null for an ordinary chat. Written once from the thread's
-- first question (setThreadConfig) and read back so the UI reopens the thread
-- where it belongs.
--
-- IF NOT EXISTS because some databases already have this column from an earlier
-- `db:push`, which changes the schema without recording anything in the ledger.
-- Additive and nullable either way, so it is safe to run on any of them.
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "config" jsonb;
