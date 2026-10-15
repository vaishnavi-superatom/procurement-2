CREATE TABLE "project_details" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"icon" varchar(500),
	"description" text,
	"database_type" varchar(100),
	"database_name" varchar(255),
	"primary_color" varchar(50),
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "project_sources" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"type" varchar(50) NOT NULL,
	"config" jsonb NOT NULL,
	"schema" jsonb,
	"is_primary" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"last_sync_at" timestamp,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."project_details"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_details_name" ON "project_details" USING btree ("name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_project_sources_project_id" ON "project_sources" USING btree ("project_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_project_sources_type" ON "project_sources" USING btree ("type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_project_sources_is_active" ON "project_sources" USING btree ("is_active");