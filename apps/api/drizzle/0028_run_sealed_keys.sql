ALTER TABLE "runs" ADD COLUMN "sealed_keys" text;--> statement-breakpoint
CREATE INDEX "runs_sealed_keys" ON "runs" USING btree ("id") WHERE "runs"."sealed_keys" IS NOT NULL;