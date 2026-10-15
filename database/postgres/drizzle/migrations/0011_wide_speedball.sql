ALTER TABLE "user_conversations" RENAME COLUMN "uiblock" TO "response";--> statement-breakpoint
ALTER TABLE "dashboard_agent_conversations" ADD COLUMN "status" varchar(20) DEFAULT 'success' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports_conversations" ADD COLUMN "status" varchar(20) DEFAULT 'success' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_conversations" ADD COLUMN "status" varchar(20) DEFAULT 'success' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_dashboard_agent_conversations_status" ON "dashboard_agent_conversations" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_conversations_status" ON "reports_conversations" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_user_conversations_status" ON "user_conversations" USING btree ("status" text_ops);