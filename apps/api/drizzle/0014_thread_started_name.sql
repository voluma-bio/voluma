-- Gives every stored thread.started the `name` the harness now writes: the thread id without the
-- run id prefix. Idempotent; rerun it before `name` becomes required. `payload` stays json: other
-- event types hold \u0000, which jsonb rejects, so only thread.started rows are read as json, and
-- the CASE keeps the planner from reading the others.
UPDATE "events"
SET "payload" = ("payload"::jsonb || jsonb_build_object('name', substr("thread_id", length("run_id") + 2)))::json
WHERE "type" = 'thread.started' AND CASE WHEN "type" = 'thread.started' THEN "payload"->>'name' END IS NULL;
