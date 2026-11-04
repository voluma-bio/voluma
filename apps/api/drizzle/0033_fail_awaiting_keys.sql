UPDATE "runs" SET "state" = 'ended', "outcome" = 'failed', "ended_at" = now(), "sealed_keys" = NULL, "awaiting_since" = NULL,
  "error" = 'Voluma''s key secret changed; start the run again.'
WHERE "state" = 'awaiting-keys';
