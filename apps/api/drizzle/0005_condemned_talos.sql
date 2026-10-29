ALTER TABLE "runs" ADD COLUMN "last_claim_end" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "last_progress_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "claim_start_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "stalled_claims" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "recoveries";