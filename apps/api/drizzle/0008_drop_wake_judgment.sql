-- The wake and judgment events and `by.judgment` left the contract with the main-agent run loop.
-- Stored runs (the seeded example) lose them; a judgment's task write reads as a check result.
DELETE FROM "events" WHERE "type" IN ('wake', 'judgment');--> statement-breakpoint
UPDATE "events" SET "payload" = jsonb_set("payload"::jsonb, '{by}', '{"kind":"rule","rule":"check-result"}')::json
  WHERE "type" = 'task' AND "payload"->'by'->>'kind' = 'judgment';
