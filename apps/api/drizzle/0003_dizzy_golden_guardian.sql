ALTER TABLE "inputs" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "inputs" ADD COLUMN "files" json;