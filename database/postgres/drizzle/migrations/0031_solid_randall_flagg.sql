CREATE TABLE "data_source_index" (
	"id" text PRIMARY KEY NOT NULL,
	"source_name" varchar(128) NOT NULL,
	"table_name" varchar(128) NOT NULL,
	"column_name" varchar(128) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"data_type" varchar(64),
	"is_nullable" boolean,
	"row_count" bigint,
	"distinct_count" bigint,
	"non_null_count" bigint,
	"cardinality" varchar(16),
	"sample_values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"statistics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"indexed_from" varchar(24),
	"is_primary_key" boolean,
	"table_meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN "description" varchar(240);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_data_source_index_path" ON "data_source_index" USING btree ("source_name","table_name","column_name");--> statement-breakpoint
CREATE INDEX "idx_data_source_index_fts" ON "data_source_index" USING gin (to_tsvector('simple', "source_name" || ' ' || "table_name" || ' ' || "column_name"));--> statement-breakpoint
CREATE INDEX "idx_data_source_index_trgm" ON "data_source_index" USING gin (lower("source_name" || ' ' || "table_name" || ' ' || "column_name") gin_trgm_ops);