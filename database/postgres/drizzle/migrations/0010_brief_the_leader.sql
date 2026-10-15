CREATE TABLE "reports_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" varchar(255) NOT NULL,
	"project_id" varchar(255),
	"user_id" varchar(255),
	"user_prompt" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
ALTER TABLE "dashboard_agent_conversations" RENAME COLUMN "response_text" TO "response";--> statement-breakpoint
CREATE INDEX "idx_reports_conversations_report_id" ON "reports_conversations" USING btree ("report_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_conversations_project_id" ON "reports_conversations" USING btree ("project_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_conversations_user_id" ON "reports_conversations" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_conversations_created_at" ON "reports_conversations" USING btree ("created_at");