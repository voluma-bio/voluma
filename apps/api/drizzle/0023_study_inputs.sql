ALTER TABLE "study_scans" RENAME TO "study_inputs";--> statement-breakpoint
ALTER TABLE "study_inputs" RENAME CONSTRAINT "study_scans_study_id_input_id_pk" TO "study_inputs_study_id_input_id_pk";--> statement-breakpoint
-- Expand step: the API still running during the deploy reads and writes `study_scans`. A plain
-- view is auto-updatable, so it keeps working; the follow-up PR drops it (.context/TODO.md).
CREATE VIEW "study_scans" AS SELECT * FROM "study_inputs";
