ALTER TABLE "script_recipes" ADD COLUMN "edited_by" varchar(255);--> statement-breakpoint
ALTER TABLE "script_recipes" ADD COLUMN "edited_from" text;--> statement-breakpoint
ALTER TABLE "script_recipes" ADD COLUMN "history" jsonb;--> statement-breakpoint
CREATE INDEX "idx_user_conversations_script_recipe" ON "user_conversations" USING btree (((response -> 'scriptBinding' ->> 'recipeId')));
