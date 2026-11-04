-- Step 3 of the `visitor` -> `own` rename: an API instance from before step 2 may have inserted `visitor` during that deploy's overlap. Idempotent.
UPDATE "runs" SET "credentials" = 'own' WHERE "credentials" = 'visitor';
