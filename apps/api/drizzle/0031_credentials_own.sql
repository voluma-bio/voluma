-- A run's "whose key" is `own`, not `visitor`. Idempotent: a second run matches no row.
UPDATE "runs" SET "credentials" = 'own' WHERE "credentials" = 'visitor';
