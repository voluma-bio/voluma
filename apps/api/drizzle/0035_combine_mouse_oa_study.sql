-- One multi-scan study on staging, for testing the Study overview and Study / Scan navigation:
-- four single-scan mouse-oa studies in Jimmy's member lab become "Mouse OA knees (combined)",
-- their members and five ended runs moved into it, the emptied studies deleted. Touches no events.
-- The study is inserted only when every listed row is as staging held it on 2026-11-04 (each
-- source study exactly its one member and its listed runs, all ended, all the creator's), so any
-- other database, or staging after a new run in a source study, is left untouched. Each later
-- step is guarded by row id, lab and current study, so a second apply changes nothing.
-- Its creation time is the earliest source study's, so Home's last activity stays the runs'.
-- Holds the run queue's lock (QUEUE_LOCK in pg-queue.ts) so an old API's start in a source study
-- during the deploy can't land between the guard and the delete.
SELECT pg_advisory_xact_lock(1987013745);--> statement-breakpoint
INSERT INTO "studies" ("id", "lab_id", "name", "workflow_id", "budget_usd", "created_by", "example", "created_at")
SELECT 'study-combined-mouse-oa', s."lab_id", 'Mouse OA knees (combined)', s."workflow_id", NULL, s."created_by", false,
  (SELECT min(o."created_at") FROM "studies" o
   WHERE o."id" IN ('2968733e-d267-4f56-a4c5-810ea5f22749', 'b6a0e29b-a663-41ba-bc55-025ce1f0a0c7', 'c88b9cdc-fc6f-4ad8-9aa8-71eb6c25cdfd', 'study-3780cacd-f969-4de8-87e1-88c918154900'))
FROM "studies" s
WHERE s."id" = '2968733e-d267-4f56-a4c5-810ea5f22749'
  AND s."lab_id" = 'org_01M607KFV8XW85ZMKH2HTKTBG6'
  AND (SELECT count(*) FROM "studies" o
       WHERE o."id" IN ('2968733e-d267-4f56-a4c5-810ea5f22749', 'b6a0e29b-a663-41ba-bc55-025ce1f0a0c7', 'c88b9cdc-fc6f-4ad8-9aa8-71eb6c25cdfd', 'study-3780cacd-f969-4de8-87e1-88c918154900')
         AND o."lab_id" = s."lab_id" AND o."workflow_id" = 'mouse-oa' AND NOT o."example" AND o."created_by" = s."created_by") = 4
  AND (SELECT count(*) FROM "study_members" m
       JOIN (VALUES
         ('2968733e-d267-4f56-a4c5-810ea5f22749', '860929cb-24a5-4106-9bcf-b6b9cfd59929'),
         ('b6a0e29b-a663-41ba-bc55-025ce1f0a0c7', 'dbbd114d-8eba-45ee-9ade-52eacb365de1'),
         ('c88b9cdc-fc6f-4ad8-9aa8-71eb6c25cdfd', 'reference-org_01M607KFV8XW85ZMKH2HTKTBG6'),
         ('study-3780cacd-f969-4de8-87e1-88c918154900', '4c7403a2-cb0e-43bf-aff5-1fea51d53f5d')
       ) AS v("study_id", "input_id") ON m."study_id" = v."study_id" AND m."input_id" = v."input_id") = 4
  AND (SELECT count(*) FROM "study_members"
       WHERE "study_id" IN ('2968733e-d267-4f56-a4c5-810ea5f22749', 'b6a0e29b-a663-41ba-bc55-025ce1f0a0c7', 'c88b9cdc-fc6f-4ad8-9aa8-71eb6c25cdfd', 'study-3780cacd-f969-4de8-87e1-88c918154900')) = 4
  AND (SELECT count(*) FROM "runs" r
       JOIN (VALUES
         ('778f0937-9395-414c-8e31-03d4266fb153', '2968733e-d267-4f56-a4c5-810ea5f22749', '860929cb-24a5-4106-9bcf-b6b9cfd59929'),
         ('d1b9cb89-fd2d-4112-b363-0b5ad151a886', '2968733e-d267-4f56-a4c5-810ea5f22749', '860929cb-24a5-4106-9bcf-b6b9cfd59929'),
         ('8b05ef94-439e-4cdb-aed7-2bc936bb1590', 'b6a0e29b-a663-41ba-bc55-025ce1f0a0c7', 'dbbd114d-8eba-45ee-9ade-52eacb365de1'),
         ('81942c77-3904-461a-9a93-2560ebb1c4e6', 'c88b9cdc-fc6f-4ad8-9aa8-71eb6c25cdfd', 'reference-org_01M607KFV8XW85ZMKH2HTKTBG6'),
         ('3780cacd-f969-4de8-87e1-88c918154900', 'study-3780cacd-f969-4de8-87e1-88c918154900', '4c7403a2-cb0e-43bf-aff5-1fea51d53f5d')
       ) AS v("id", "study_id", "input_id") ON r."id" = v."id" AND r."study_id" = v."study_id" AND r."input_id" = v."input_id"
       WHERE r."lab_id" = s."lab_id" AND r."state" = 'ended' AND NOT r."example" AND r."started_by" = s."created_by") = 5
  AND (SELECT count(*) FROM "runs"
       WHERE "study_id" IN ('2968733e-d267-4f56-a4c5-810ea5f22749', 'b6a0e29b-a663-41ba-bc55-025ce1f0a0c7', 'c88b9cdc-fc6f-4ad8-9aa8-71eb6c25cdfd', 'study-3780cacd-f969-4de8-87e1-88c918154900')) = 5
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- Each scan joins the new study in the table's order, keeping its subject, group and attributes.
UPDATE "study_members" m
SET "study_id" = 'study-combined-mouse-oa', "position" = v."position"
FROM (VALUES
  ('2968733e-d267-4f56-a4c5-810ea5f22749', '860929cb-24a5-4106-9bcf-b6b9cfd59929', 0),
  ('b6a0e29b-a663-41ba-bc55-025ce1f0a0c7', 'dbbd114d-8eba-45ee-9ade-52eacb365de1', 1),
  ('c88b9cdc-fc6f-4ad8-9aa8-71eb6c25cdfd', 'reference-org_01M607KFV8XW85ZMKH2HTKTBG6', 2),
  ('study-3780cacd-f969-4de8-87e1-88c918154900', '4c7403a2-cb0e-43bf-aff5-1fea51d53f5d', 3)
) AS v("study_id", "input_id", "position")
WHERE m."study_id" = v."study_id" AND m."input_id" = v."input_id"
  AND EXISTS (SELECT 1 FROM "studies" n JOIN "studies" src ON src."id" = v."study_id"
              WHERE n."id" = 'study-combined-mouse-oa' AND n."lab_id" = 'org_01M607KFV8XW85ZMKH2HTKTBG6'
                AND src."lab_id" = n."lab_id" AND src."created_by" = n."created_by");
--> statement-breakpoint
-- A run moves only once its scan is a member of the new study.
UPDATE "runs" r
SET "study_id" = 'study-combined-mouse-oa'
FROM (VALUES
  ('778f0937-9395-414c-8e31-03d4266fb153', '2968733e-d267-4f56-a4c5-810ea5f22749', '860929cb-24a5-4106-9bcf-b6b9cfd59929'),
  ('d1b9cb89-fd2d-4112-b363-0b5ad151a886', '2968733e-d267-4f56-a4c5-810ea5f22749', '860929cb-24a5-4106-9bcf-b6b9cfd59929'),
  ('8b05ef94-439e-4cdb-aed7-2bc936bb1590', 'b6a0e29b-a663-41ba-bc55-025ce1f0a0c7', 'dbbd114d-8eba-45ee-9ade-52eacb365de1'),
  ('81942c77-3904-461a-9a93-2560ebb1c4e6', 'c88b9cdc-fc6f-4ad8-9aa8-71eb6c25cdfd', 'reference-org_01M607KFV8XW85ZMKH2HTKTBG6'),
  ('3780cacd-f969-4de8-87e1-88c918154900', 'study-3780cacd-f969-4de8-87e1-88c918154900', '4c7403a2-cb0e-43bf-aff5-1fea51d53f5d')
) AS v("id", "study_id", "input_id")
WHERE r."id" = v."id" AND r."study_id" = v."study_id" AND r."input_id" = v."input_id"
  AND r."lab_id" = 'org_01M607KFV8XW85ZMKH2HTKTBG6'
  AND EXISTS (SELECT 1 FROM "study_members" m
              WHERE m."study_id" = 'study-combined-mouse-oa' AND m."input_id" = v."input_id");
--> statement-breakpoint
-- A source study goes only once nothing points at it and the new study holds its scans.
DELETE FROM "studies" s
WHERE s."id" IN ('2968733e-d267-4f56-a4c5-810ea5f22749', 'b6a0e29b-a663-41ba-bc55-025ce1f0a0c7', 'c88b9cdc-fc6f-4ad8-9aa8-71eb6c25cdfd', 'study-3780cacd-f969-4de8-87e1-88c918154900')
  AND s."lab_id" = 'org_01M607KFV8XW85ZMKH2HTKTBG6'
  AND EXISTS (SELECT 1 FROM "studies" n WHERE n."id" = 'study-combined-mouse-oa' AND n."lab_id" = s."lab_id")
  AND NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."study_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "study_members" m WHERE m."study_id" = s."id");
