CREATE TABLE "alert_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"alert_id" varchar(255) NOT NULL,
	"triggered_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"value" double precision,
	"reason" text,
	"analysis" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "report_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"alert_id" varchar(255) NOT NULL,
	"report_id" varchar(255) NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"name" varchar(255),
	"enabled" boolean DEFAULT true,
	"metric_description" text,
	"source_id" varchar(255),
	"generated_query" text,
	"result_column" varchar(255),
	"condition_type" varchar(50),
	"config" jsonb,
	"check_interval" varchar(50),
	"recipients" jsonb DEFAULT '[]'::jsonb,
	"email_subject" varchar(255),
	"cooldown_minutes" integer DEFAULT 60,
	"last_checked_at" timestamp,
	"last_triggered_at" timestamp,
	"last_value" double precision,
	"consecutive_errors" integer DEFAULT 0,
	"status" varchar(50) DEFAULT 'unchecked',
	"created_by" varchar(255),
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "report_alerts_alert_id_unique" UNIQUE("alert_id")
);
--> statement-breakpoint
CREATE INDEX "idx_alert_history_alert_id" ON "alert_history" USING btree ("alert_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_alert_history_triggered_at" ON "alert_history" USING btree ("triggered_at");--> statement-breakpoint
CREATE INDEX "idx_report_alerts_alert_id" ON "report_alerts" USING btree ("alert_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_report_alerts_report_id" ON "report_alerts" USING btree ("report_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_report_alerts_project_id" ON "report_alerts" USING btree ("project_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_report_alerts_enabled" ON "report_alerts" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "idx_report_alerts_status" ON "report_alerts" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_report_alerts_created_at" ON "report_alerts" USING btree ("created_at");