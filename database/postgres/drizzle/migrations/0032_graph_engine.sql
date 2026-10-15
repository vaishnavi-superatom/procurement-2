CREATE TABLE "graph_domain_members" (
	"domain_id" integer NOT NULL,
	"node_id" integer,
	"concept_name" varchar(160),
	"role" varchar(12) NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_domain_terms" (
	"domain_id" integer NOT NULL,
	"term" varchar(64) NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(16) NOT NULL,
	"name" varchar(96) NOT NULL,
	"title" varchar(160),
	"body" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hash" varchar(64) NOT NULL,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes" integer,
	"origin" varchar(24),
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_routes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"domain_id" integer,
	"domain_hash" varchar(64),
	"score" double precision,
	"runner_up_id" integer,
	"runner_up_score" double precision,
	"matched_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by" varchar(12) NOT NULL,
	"thread_id" varchar(64),
	"user_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_graph_domain_members_order" ON "graph_domain_members" USING btree ("domain_id","role","position");--> statement-breakpoint
CREATE INDEX "idx_graph_domain_terms_term" ON "graph_domain_terms" USING btree ("term");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_graph_nodes_kind_name_version" ON "graph_nodes" USING btree ("kind",lower("name"),"version");--> statement-breakpoint
CREATE INDEX "idx_graph_nodes_published" ON "graph_nodes" USING btree ("kind",lower("name")) WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "idx_graph_routes_domain" ON "graph_routes" USING btree ("domain_id","created_at");