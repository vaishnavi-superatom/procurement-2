DROP INDEX "idx_threads_title_fts";--> statement-breakpoint
DROP INDEX "idx_user_conversations_user_prompt_fts";--> statement-breakpoint
CREATE INDEX "idx_threads_title_fts" ON "threads" USING gin (to_tsvector('simple'::regconfig, title));--> statement-breakpoint
CREATE INDEX "idx_user_conversations_user_prompt_fts" ON "user_conversations" USING gin (to_tsvector('simple'::regconfig, userprompt));