ALTER TABLE "runs" ADD COLUMN "struck_lease_token" text;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "claimable_after";