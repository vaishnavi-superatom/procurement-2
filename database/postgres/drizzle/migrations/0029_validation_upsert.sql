-- One validation row per conversation.
--
-- It was always an INSERT with nothing to stop a second row, but the watermark
-- normally passed a conversation once so it rarely fired. Advancing the
-- watermark to the work actually reported makes a re-read ORDINARY — a batch
-- covering 1,2,4,5 advances to 2 and hands 3,4,5 back — so conversations 4 and
-- 5 are legitimately re-validated and would duplicate every time.
--
-- Duplicates are not merely untidy here: validationStats() computes accuracy as
-- match / (match + mismatch) over ROWS, so a duplicated conversation silently
-- counts twice and skews the headline number with nothing to show for it.

ALTER TABLE "answer_validations" ADD COLUMN "checks" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_validations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint

-- Carry the existing duplicates over as a count before collapsing them, so the
-- fact that an answer was checked more than once is not lost with the rows.
UPDATE answer_validations v
SET checks = c.n
FROM (SELECT conversation_id, count(*)::int AS n FROM answer_validations GROUP BY conversation_id) c
WHERE v.conversation_id = c.conversation_id AND c.n > 1;--> statement-breakpoint

-- Collapse to one row per conversation. A real verdict outranks 'unverifiable'
-- (having once managed to check an answer is information; a later failure to
-- check it is not), then the most recent wins.
DELETE FROM answer_validations WHERE id IN (
	SELECT id FROM (
		SELECT id, row_number() OVER (
			PARTITION BY conversation_id
			ORDER BY (verdict <> 'unverifiable') DESC, created_at DESC NULLS LAST, id DESC
		) AS rn
		FROM answer_validations
	) ranked WHERE rn > 1
);--> statement-breakpoint

-- Enforced in the DATABASE, not the writer: a dedupe in application code is
-- undone by the next caller. Also serves "show the validation for this answer",
-- which is why the plain index it replaces is dropped rather than kept.
DROP INDEX IF EXISTS "idx_answer_validations_conversation";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_answer_validations_conversation" ON "answer_validations" USING btree ("conversation_id");
