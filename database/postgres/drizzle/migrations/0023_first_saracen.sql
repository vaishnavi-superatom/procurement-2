CREATE TABLE "concepts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"body" text NOT NULL,
	"kind" varchar(24) DEFAULT 'definition' NOT NULL,
	"requires" text[] DEFAULT '{}'::text[] NOT NULL,
	"returns" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"origin" varchar(24),
	"source_id" varchar(100),
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_concepts_name" ON "concepts" USING btree (lower("name"),coalesce("source_id", ''));--> statement-breakpoint
CREATE INDEX "idx_concepts_kind" ON "concepts" USING btree ("kind" text_ops);--> statement-breakpoint
CREATE INDEX "idx_concepts_aliases" ON "concepts" USING gin ("aliases" array_ops);