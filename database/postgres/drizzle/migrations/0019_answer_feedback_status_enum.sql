-- schema.ts (77ac4772) replaced answer_feedback.is_correct (boolean) with a
-- 3-state status enum, but shipped without a migration. Convert in place and
-- preserve existing feedback: true -> 'correct', false -> 'incorrect'.
CREATE TYPE "public"."feedback_status" AS ENUM ('correct', 'incorrect', 'partial');
--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD COLUMN "status" "public"."feedback_status";
--> statement-breakpoint
UPDATE "answer_feedback" SET "status" = CASE WHEN "is_correct" THEN 'correct' ELSE 'incorrect' END::"public"."feedback_status";
--> statement-breakpoint
ALTER TABLE "answer_feedback" DROP COLUMN "is_correct";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_answer_feedback_status" ON "answer_feedback" USING btree ("status");
