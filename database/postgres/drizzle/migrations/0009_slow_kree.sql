CREATE TABLE "dashboard_agent_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"dashboard_id" varchar(255) NOT NULL,
	"project_id" varchar(255),
	"user_id" varchar(255),
	"user_prompt" text NOT NULL,
	"response_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX "idx_dashboard_agent_conversations_dashboard_id" ON "dashboard_agent_conversations" USING btree ("dashboard_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_dashboard_agent_conversations_project_id" ON "dashboard_agent_conversations" USING btree ("project_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_dashboard_agent_conversations_user_id" ON "dashboard_agent_conversations" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_dashboard_agent_conversations_created_at" ON "dashboard_agent_conversations" USING btree ("created_at");