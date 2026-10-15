CREATE TABLE "answer_validations" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"verdict" varchar(24) NOT NULL,
	"reported_answer" text,
	"rederived_answer" text,
	"unit" text,
	"finding" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_run_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
DROP INDEX "uq_concepts_name";--> statement-breakpoint
CREATE INDEX "idx_answer_validations_conversation" ON "answer_validations" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_answer_validations_verdict" ON "answer_validations" USING btree ("verdict","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_concepts_name" ON "concepts" USING btree (lower("name"),coalesce("source_id", '')) WHERE "supersedes" IS NULL;