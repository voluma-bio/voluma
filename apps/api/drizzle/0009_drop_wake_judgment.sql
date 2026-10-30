-- The wake and judgment events and `by.judgment` left the contract with the main-agent run loop.
-- Stored runs (the seeded example) lose them. A judgment's task write was the old main thread's
-- decision (accept, redo, fail), which the main agent's tools now write as `by: agent`; written as
-- that, an accepted task keeps its "Marked to check" item (a check-result write would clear it).
DELETE FROM "events" WHERE "type" IN ('wake', 'judgment');--> statement-breakpoint
UPDATE "events" SET "payload" = jsonb_set("payload"::jsonb, '{by}', '{"kind":"agent"}')::json
  WHERE "type" = 'task' AND "payload"->'by'->>'kind' = 'judgment';
