ALTER TABLE "concepts" ADD COLUMN "supersedes" integer;--> statement-breakpoint
CREATE INDEX "idx_concepts_supersedes" ON "concepts" USING btree ("supersedes");--> statement-breakpoint

-- The uniqueness key is (lower(name), coalesce(source_id,'')), so a revision
-- carrying the same name as the concept it replaces would collide. Exclude
-- revisions from it: an original and its pending replacement must coexist.
DROP INDEX IF EXISTS "uq_concepts_name";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_concepts_name" ON "concepts" (lower("name"), coalesce("source_id", ''))
	WHERE "supersedes" IS NULL;
