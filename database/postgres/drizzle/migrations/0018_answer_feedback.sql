-- IF NOT EXISTS throughout: this table shipped unregistered in the journal, so
-- databases that got it out-of-band (drizzle-kit push) must not fail on migrate.
CREATE TABLE IF NOT EXISTS "answer_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"ui_block_id" varchar(255) NOT NULL,
	"thread_id" varchar(255),
	"user_id" varchar(255),
	"user_prompt" text NOT NULL,
	"answer_snapshot" jsonb,
	"is_correct" boolean NOT NULL,
	"feedback_text" text,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_answer_feedback_user_uiblock" ON "answer_feedback" USING btree ("user_id","ui_block_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_answer_feedback_ui_block_id" ON "answer_feedback" USING btree ("ui_block_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_answer_feedback_user_id" ON "answer_feedback" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_answer_feedback_created_at" ON "answer_feedback" USING btree ("created_at");
