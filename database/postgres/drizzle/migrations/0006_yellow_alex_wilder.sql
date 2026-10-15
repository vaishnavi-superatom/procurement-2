CREATE TABLE "script_recipes" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"project_id" varchar(255),
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"intent_description" text NOT NULL,
	"tags" text[],
	"created_from" text,
	"source_ids" text[],
	"tables" text[],
	"parameters" jsonb,
	"components" jsonb,
	"file_base" text NOT NULL,
	"body_hash" varchar(64),
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_used" timestamp DEFAULT CURRENT_TIMESTAMP,
	"parent_id" varchar(128),
	"fork_depth" integer DEFAULT 0,
	"fork_reason" text,
	"status" varchar(20) DEFAULT 'verified' NOT NULL,
	"turn_id" varchar(64),
	"last_error" jsonb,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX "idx_script_recipes_name_fts" ON "script_recipes" USING gin (to_tsvector('english'::regconfig, "name"));--> statement-breakpoint
CREATE INDEX "idx_script_recipes_intent_fts" ON "script_recipes" USING gin (to_tsvector('english'::regconfig, "intent_description"));--> statement-breakpoint
CREATE INDEX "idx_script_recipes_created_from_fts" ON "script_recipes" USING gin (to_tsvector('english'::regconfig, coalesce("created_from", '')));--> statement-breakpoint
CREATE INDEX "idx_script_recipes_tags" ON "script_recipes" USING gin ("tags" array_ops);--> statement-breakpoint
CREATE INDEX "idx_script_recipes_status" ON "script_recipes" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_script_recipes_project_id" ON "script_recipes" USING btree ("project_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_script_recipes_last_used" ON "script_recipes" USING btree ("last_used");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_script_recipes_project_file_base" ON "script_recipes" USING btree ("project_id","file_base");