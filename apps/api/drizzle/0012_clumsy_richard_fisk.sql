CREATE TABLE "review_snapshots" (
	"run_id" text NOT NULL,
	"generation" uuid NOT NULL,
	"id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"snapshot" json NOT NULL,
	CONSTRAINT "review_snapshots_run_id_generation_id_pk" PRIMARY KEY("run_id","generation","id")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "generation" uuid DEFAULT gen_random_uuid() NOT NULL;