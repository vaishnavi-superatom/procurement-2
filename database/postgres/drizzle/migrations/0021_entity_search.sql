-- Entity search engine — see backend/docs/ENTITY-SEARCH-DESIGN.md
-- Hand-added: gin_trgm_ops below is unusable without this, so it must run first.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "search_entity_types" (
	"entity_type" varchar(64) PRIMARY KEY NOT NULL,
	"resolution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "search_values" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"instance_id" varchar(128) NOT NULL,
	"value" text NOT NULL,
	"value_kind" varchar(32) DEFAULT 'name' NOT NULL,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"value_norm" text GENERATED ALWAYS AS (btrim(regexp_replace(lower("value"), '[^a-z0-9]+', ' ', 'g'))) STORED,
	"value_squashed" text GENERATED ALWAYS AS (regexp_replace(lower("value"), '[^a-z0-9]+', '', 'g')) STORED,
	"value_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', btrim(regexp_replace(lower("value"), '[^a-z0-9]+', ' ', 'g')))) STORED
);
--> statement-breakpoint
ALTER TABLE "search_values" ADD CONSTRAINT "search_values_entity_type_fk" FOREIGN KEY ("entity_type") REFERENCES "public"."search_entity_types"("entity_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_search_values_squashed_trgm" ON "search_values" USING gin ("value_squashed" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_search_values_norm_trgm" ON "search_values" USING gin ("value_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_search_values_tsv" ON "search_values" USING gin ("value_tsv" tsvector_ops);--> statement-breakpoint
CREATE INDEX "idx_search_values_norm_prefix" ON "search_values" USING btree ("value_norm" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "idx_search_values_entity_type" ON "search_values" USING btree ("entity_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_search_values_instance" ON "search_values" USING btree ("entity_type" text_ops,"instance_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_search_values" ON "search_values" USING btree ("entity_type","instance_id","value_kind",md5("value"));