CREATE TABLE "artifacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_by" integer,
	"dsl" jsonb,
	"type" varchar(100),
	"filters" jsonb,
	"deleted" boolean DEFAULT false,
	"status" varchar(100),
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"thread_id" varchar(255),
	"name" varchar(255),
	"description" text,
	"uiblock" jsonb NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" serial PRIMARY KEY NOT NULL,
	"dashboard_id" varchar(255) NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"name" varchar(255),
	"description" text,
	"dashboard" jsonb,
	"published" boolean DEFAULT false,
	"allowed_users" jsonb DEFAULT '[]'::jsonb,
	"created_by" integer,
	"updated_by" integer,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "kb_nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(500) NOT NULL,
	"content" text NOT NULL,
	"category" varchar(200),
	"tags" text[],
	"type" varchar(50) DEFAULT 'query',
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"created_by" integer,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "menus" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"component_name" varchar(255) NOT NULL,
	"icon" varchar(100),
	"user_message" text,
	"parent_id" integer,
	"sort_order" integer DEFAULT 0,
	"props" jsonb,
	"menu_json" jsonb,
	"version" integer,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" varchar(255) NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"name" varchar(255),
	"description" text,
	"report" jsonb,
	"published" boolean DEFAULT false,
	"created_by" integer,
	"updated_by" integer,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "uis" (
	"id" serial PRIMARY KEY NOT NULL,
	"ui_id" varchar(255) NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"name" varchar(255),
	"description" text,
	"ui" jsonb,
	"created_by" integer,
	"updated_by" integer,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "user_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"threadid" varchar(255),
	"userprompt" text NOT NULL,
	"uiblock" jsonb NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(100) NOT NULL,
	"email" varchar(255),
	"password" varchar(255) NOT NULL,
	"fullname" varchar(255),
	"role" varchar(50),
	"user_info" jsonb,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "users_username_key" UNIQUE("username"),
	CONSTRAINT "users_email_key" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_nodes" ADD CONSTRAINT "kb_nodes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_nodes" ADD CONSTRAINT "kb_nodes_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uis" ADD CONSTRAINT "uis_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uis" ADD CONSTRAINT "uis_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_conversations" ADD CONSTRAINT "user_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifacts_created_by" ON "artifacts" USING btree ("created_by" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_artifacts_created_at" ON "artifacts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_bookmarks_uiblock" ON "bookmarks" USING gin ("uiblock" jsonb_ops);--> statement-breakpoint
CREATE INDEX "idx_bookmarks_created_at" ON "bookmarks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_bookmarks_user_id" ON "bookmarks" USING btree ("user_id" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_bookmarks_thread_id" ON "bookmarks" USING btree ("thread_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_dashboards_dashboard_id" ON "dashboards" USING btree ("dashboard_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_dashboards_project_id" ON "dashboards" USING btree ("project_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_dashboards_created_at" ON "dashboards" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_dashboards_created_by" ON "dashboards" USING btree ("created_by" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_dashboards_updated_by" ON "dashboards" USING btree ("updated_by" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_dashboards_allowed_users" ON "dashboards" USING gin ("allowed_users" jsonb_ops);--> statement-breakpoint
CREATE INDEX "idx_kb_nodes_type" ON "kb_nodes" USING btree ("type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_kb_nodes_category" ON "kb_nodes" USING btree ("category" text_ops);--> statement-breakpoint
CREATE INDEX "idx_kb_nodes_content_fts" ON "kb_nodes" USING gin (to_tsvector('english'::regconfig, content));--> statement-breakpoint
CREATE INDEX "idx_kb_nodes_created_at" ON "kb_nodes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_kb_nodes_created_by" ON "kb_nodes" USING btree ("created_by" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_kb_nodes_tags" ON "kb_nodes" USING gin ("tags" array_ops);--> statement-breakpoint
CREATE INDEX "idx_kb_nodes_title" ON "kb_nodes" USING btree ("title" text_ops);--> statement-breakpoint
CREATE INDEX "idx_kb_nodes_title_fts" ON "kb_nodes" USING gin (to_tsvector('english'::regconfig, (title)::text));--> statement-breakpoint
CREATE INDEX "idx_kb_nodes_updated_by" ON "kb_nodes" USING btree ("updated_by" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_menus_parent_id" ON "menus" USING btree ("parent_id" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_menus_sort_order" ON "menus" USING btree ("sort_order" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_menus_is_active" ON "menus" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_reports_report_id" ON "reports" USING btree ("report_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_project_id" ON "reports" USING btree ("project_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_created_at" ON "reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_reports_created_by" ON "reports" USING btree ("created_by" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_updated_by" ON "reports" USING btree ("updated_by" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_uis_ui_id" ON "uis" USING btree ("ui_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_uis_project_id" ON "uis" USING btree ("project_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_uis_created_at" ON "uis" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_uis_created_by" ON "uis" USING btree ("created_by" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_uis_updated_by" ON "uis" USING btree ("updated_by" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_user_conversations_user_id" ON "user_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_conversations_thread_id" ON "user_conversations" USING btree ("threadid");--> statement-breakpoint
CREATE INDEX "idx_user_conversations_created_at" ON "user_conversations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_user_conversations_user_prompt_fts" ON "user_conversations" USING gin (to_tsvector('english'::regconfig, userprompt));--> statement-breakpoint
CREATE INDEX "idx_users_username" ON "users" USING btree ("username" text_ops);--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" USING btree ("email" text_ops);