CREATE TABLE "conversation_traces" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"thread_id" varchar(255),
	"trace" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX "idx_conversation_traces_conversation_id" ON "conversation_traces" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_traces_user_id" ON "conversation_traces" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_traces_created_at" ON "conversation_traces" USING btree ("created_at");