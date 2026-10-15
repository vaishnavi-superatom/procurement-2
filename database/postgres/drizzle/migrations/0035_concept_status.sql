-- concepts.status: where a concept sits in review (see schema.ts).
--
-- Every statement is safe to re-run, because two kinds of database reach this
-- file: one migrated on this line (none of it exists yet), and one migrated on
-- the fusion-5 / total-group line (all of it exists already).
DO $$ BEGIN
	CREATE TYPE "public"."concept_status" AS ENUM('draft', 'proposed', 'approved', 'rejected', 'superseded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "status" "concept_status" DEFAULT 'proposed' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_concepts_status" ON "concepts" USING btree ("status");--> statement-breakpoint
-- The two statements schema.ts says this column needs and drizzle cannot
-- generate. Without the first, every concept already in force comes back as a
-- pending proposal; without the second, status and verified can drift apart.
UPDATE "concepts" SET "status" = 'approved' WHERE "verified" = true AND "status" <> 'approved';--> statement-breakpoint
UPDATE "concepts" SET "status" = 'proposed' WHERE "verified" = false AND "status" = 'approved';--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "concepts" ADD CONSTRAINT "concepts_status_matches_verified" CHECK (("status" = 'approved') = "verified");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
