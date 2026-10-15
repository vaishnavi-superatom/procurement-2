-- Repair-only migration, no schema.ts change: on at least one already-provisioned
-- database, search_entity_types/search_values were created (0020/0021) but the
-- CREATE INDEX statements after CREATE TABLE in that same file never ran, leaving
-- the table present with none of its indexes — including uq_search_values, which
-- indexValues()'s ON CONFLICT requires. IF NOT EXISTS throughout so this is a
-- true no-op anywhere the indexes already exist (e.g. local dev).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_search_values" ON "search_values" USING btree ("entity_type","instance_id","value_kind",md5("value"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_values_squashed_trgm" ON "search_values" USING gin ("value_squashed" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_values_norm_trgm" ON "search_values" USING gin ("value_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_values_tsv" ON "search_values" USING gin ("value_tsv" tsvector_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_values_norm_prefix" ON "search_values" USING btree ("value_norm" text_pattern_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_values_entity_type" ON "search_values" USING btree ("entity_type" text_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_values_instance" ON "search_values" USING btree ("entity_type" text_ops,"instance_id" text_ops);
