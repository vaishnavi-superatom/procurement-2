ALTER TABLE "concepts" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_concepts_verified" ON "concepts" USING btree ("verified");--> statement-breakpoint

-- Backfill: every concept that exists today was authored or curated by a human
-- (all 29 have origin='knowledge_node'), so they are verified by definition.
-- Without this the column default would mark them all unreviewed, the runtime
-- filters would return nothing, and MainAgent self-disables resolve_concepts on
-- an empty catalog — the whole feature would switch off silently rather than
-- fail loudly. New rows still default to false, which is what agent proposals
-- need.
UPDATE concepts SET verified = true;
