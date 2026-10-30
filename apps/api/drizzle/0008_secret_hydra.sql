CREATE TABLE "studies" (
	"id" text PRIMARY KEY NOT NULL,
	"lab_id" text NOT NULL,
	"name" text NOT NULL,
	"workflow_id" text NOT NULL,
	"budget_usd" double precision,
	"created_by" text NOT NULL,
	"example" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "study_scans" (
	"study_id" text NOT NULL,
	"input_id" text NOT NULL,
	"subject" text NOT NULL,
	"group" text,
	"attributes" json NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "study_scans_study_id_input_id_pk" PRIMARY KEY("study_id","input_id")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "study_id" text;--> statement-breakpoint
-- Every existing run becomes a study of one, named after its scan. Only an unfinished upload's input is
-- ever deleted, and no run starts on one, so every run has an input; one without would fail the
-- NOT NULL below, loudly.
INSERT INTO "studies" ("id", "lab_id", "name", "workflow_id", "created_by", "example", "created_at")
SELECT 'study-' || r."id", r."lab_id", i."name", r."workflow_id", r."started_by", r."example", r."created_at"
FROM "runs" r JOIN "inputs" i ON i."id" = r."input_id";--> statement-breakpoint
INSERT INTO "study_scans" ("study_id", "input_id", "subject", "attributes", "position")
SELECT 'study-' || r."id", r."input_id", i."name", '{}', 0
FROM "runs" r JOIN "inputs" i ON i."id" = r."input_id";--> statement-breakpoint
UPDATE "runs" r SET "study_id" = 'study-' || r."id" WHERE EXISTS (SELECT 1 FROM "inputs" i WHERE i."id" = r."input_id");--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "study_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "studies_lab" ON "studies" USING btree ("lab_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_study" ON "runs" USING btree ("study_id");--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "workflow_id";