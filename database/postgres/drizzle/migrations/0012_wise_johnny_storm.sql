CREATE TABLE "threads" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_threads_user_id" ON "threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_threads_user_updated_at" ON "threads" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_conversations_search_fts" ON "user_conversations" USING gin ((setweight(to_tsvector('english'::regconfig, "userprompt"), 'A') || setweight(to_tsvector('english'::regconfig, coalesce("response"->>'analysis', '')), 'B')));