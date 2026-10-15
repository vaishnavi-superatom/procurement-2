ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "artifacts_created_by_fkey";
--> statement-breakpoint
ALTER TABLE "bookmarks" DROP CONSTRAINT IF EXISTS "bookmarks_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "dashboards" DROP CONSTRAINT IF EXISTS "dashboards_created_by_fkey";
--> statement-breakpoint
ALTER TABLE "dashboards" DROP CONSTRAINT IF EXISTS "dashboards_updated_by_fkey";
--> statement-breakpoint
ALTER TABLE "kb_nodes" DROP CONSTRAINT IF EXISTS "kb_nodes_created_by_fkey";
--> statement-breakpoint
ALTER TABLE "kb_nodes" DROP CONSTRAINT IF EXISTS "kb_nodes_updated_by_fkey";
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT IF EXISTS "reports_created_by_fkey";
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT IF EXISTS "reports_updated_by_fkey";
--> statement-breakpoint
ALTER TABLE "uis" DROP CONSTRAINT IF EXISTS "uis_created_by_fkey";
--> statement-breakpoint
ALTER TABLE "uis" DROP CONSTRAINT IF EXISTS "uis_updated_by_fkey";
--> statement-breakpoint
ALTER TABLE "user_conversations" DROP CONSTRAINT IF EXISTS "user_conversations_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "users" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_artifacts_created_by";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_bookmarks_user_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_dashboards_created_by";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_dashboards_updated_by";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_kb_nodes_created_by";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_kb_nodes_updated_by";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_reports_created_by";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_reports_updated_by";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_uis_created_by";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_uis_updated_by";--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "created_by" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "bookmarks" ALTER COLUMN "user_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "dashboards" ALTER COLUMN "created_by" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "dashboards" ALTER COLUMN "updated_by" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "kb_nodes" ALTER COLUMN "created_by" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "kb_nodes" ALTER COLUMN "updated_by" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "created_by" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "updated_by" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "uis" ALTER COLUMN "created_by" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "uis" ALTER COLUMN "updated_by" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "user_conversations" ALTER COLUMN "user_id" SET DATA TYPE varchar(255);--> statement-breakpoint
CREATE INDEX "idx_artifacts_created_by" ON "artifacts" USING btree ("created_by" text_ops);--> statement-breakpoint
CREATE INDEX "idx_bookmarks_user_id" ON "bookmarks" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_dashboards_created_by" ON "dashboards" USING btree ("created_by" text_ops);--> statement-breakpoint
CREATE INDEX "idx_dashboards_updated_by" ON "dashboards" USING btree ("updated_by" text_ops);--> statement-breakpoint
CREATE INDEX "idx_kb_nodes_created_by" ON "kb_nodes" USING btree ("created_by" text_ops);--> statement-breakpoint
CREATE INDEX "idx_kb_nodes_updated_by" ON "kb_nodes" USING btree ("updated_by" text_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_created_by" ON "reports" USING btree ("created_by" text_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_updated_by" ON "reports" USING btree ("updated_by" text_ops);--> statement-breakpoint
CREATE INDEX "idx_uis_created_by" ON "uis" USING btree ("created_by" text_ops);--> statement-breakpoint
CREATE INDEX "idx_uis_updated_by" ON "uis" USING btree ("updated_by" text_ops);