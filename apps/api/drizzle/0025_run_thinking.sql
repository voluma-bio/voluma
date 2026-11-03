ALTER TABLE "runs" ADD COLUMN "thinking" text;
--> statement-breakpoint
-- Own-key runs from before the model picker had no model and ran on RUNNER_VISITOR_MODEL (deleted).
UPDATE "runs" SET "model" = 'meta/muse-spark-1.3' WHERE "credentials" = 'visitor' AND "model" IS NULL;
