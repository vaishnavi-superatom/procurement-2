ALTER TABLE "reports" ADD COLUMN "schedule_config" jsonb;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "last_scheduled_at" timestamp;