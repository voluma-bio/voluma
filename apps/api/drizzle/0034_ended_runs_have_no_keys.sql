UPDATE "runs" SET "sealed_keys" = NULL WHERE "state" = 'ended' AND "sealed_keys" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ended_no_keys" CHECK ("runs"."state" <> 'ended' OR "runs"."sealed_keys" IS NULL);
