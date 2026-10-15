ALTER TABLE "threads" ADD COLUMN "agent_id" varchar(255);--> statement-breakpoint
ALTER TABLE "user_conversations" ADD COLUMN "agent_id" varchar(255);--> statement-breakpoint
CREATE INDEX "idx_threads_user_agent_updated_at" ON "threads" USING btree ("user_id","agent_id","updated_at" DESC NULLS LAST);