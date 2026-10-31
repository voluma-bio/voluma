-- Step 1 of narrowing two stored shapes (`packages/contracts/.context/TODO.md`): converts what
-- older runners wrote so the schemas can drop it. Idempotent.
-- `payload` stays json: other event types hold \u0000, which jsonb rejects, so each payload is
-- read only inside a CASE on its own type (Postgres may evaluate a bare json condition first).
-- A thread.started without `name` gets the thread id after its first `.` (run ids hold no `.`;
-- an example copy keeps the source run's thread ids under a new run id).
UPDATE "events"
SET "payload" = ("payload"::jsonb || jsonb_build_object('name', substr("thread_id", strpos("thread_id", '.') + 1)))::json
WHERE "type" = 'thread.started' AND CASE WHEN "type" = 'thread.started' THEN "payload"->>'name' END IS NULL;
--> statement-breakpoint
-- A claim that followed a provider outage (a reason no code writes now) followed a self-stop.
UPDATE "events"
SET "payload" = ("payload"::jsonb || '{"after": "self-stop"}'::jsonb)::json
WHERE "type" = 'claim.started' AND CASE WHEN "type" = 'claim.started' THEN "payload"->>'after' END = 'provider-outage';
--> statement-breakpoint
UPDATE "runs" SET "last_claim_end" = 'self-stop' WHERE "last_claim_end" = 'provider-outage';
