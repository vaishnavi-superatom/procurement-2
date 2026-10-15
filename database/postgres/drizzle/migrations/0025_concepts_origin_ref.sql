ALTER TABLE "concepts" ADD COLUMN "origin_ref" varchar(100);--> statement-breakpoint
CREATE INDEX "idx_concepts_origin_ref" ON "concepts" USING btree ("origin_ref");