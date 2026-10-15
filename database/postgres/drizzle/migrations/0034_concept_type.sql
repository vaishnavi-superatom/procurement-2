-- concepts.type: who a concept applies to (global | user | group), optional.
-- Written to run safely on any database: a fresh one gets the column; one that
-- already has it (from an earlier draft of this change, where it was NOT NULL
-- DEFAULT 'global') is brought to the same state.
ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "type" varchar(8);--> statement-breakpoint
ALTER TABLE "concepts" ALTER COLUMN "type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "concepts" ALTER COLUMN "type" DROP DEFAULT;
