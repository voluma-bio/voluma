-- Step 2 of narrowing three stored shapes (`check-limit` needs no SQL: no stored event carries it):
-- 0019 again, for rows an older runner wrote after 0019 ran. Idempotent; the CASE guards are as in 0019.
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
