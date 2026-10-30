# TODO

- **Postgres migration drill.** Before the lab relies on the database: `pg_dump` from
  Railway (needs a temporary TCP proxy or `railway ssh`; remove it after), restore into a
  fresh local Postgres, run the app against the copy. Proves the "portable Postgres" rule.
- **Scheduled `pg_dump` to R2**, so backups don't depend on Railway.
- **Move the service settings into `.railway/railway.ts`** (Railway's Infrastructure as
  Code, GA; applied with `railway config plan` then `apply`, not on deploy; project tokens
  work with `RAILWAY_TOKEN`). Unblocked. Move the build, pre-deploy, start, healthcheck,
  draining, restart, sleeping and watch-path settings and the `DATABASE_URL` reference from
  [deploy.md](deploy.md)'s tables; leave secret values (`VOLUMA_API_TOKEN`) on the service.
  Then shrink those tables to a pointer. Until then they exist only on the service and drift.
- **Run streams: end them on sign-out.** An open run stream (server-sent events,
  `GET /api/run/runs/:id/stream`) is authenticated once, when it opens, so it outlives
  sign-out, a revoked session and a refresh that drops the user from the lab. To close
  streams on sign-out, the stream route needs the session id: add `sessionId` to the user
  `Principal` (`core.parseTokenClaims(accessToken).sid` in `auth.ts`), not as a second root
  variable. Or cap a stream's lifetime (say 5 min, the access-token lifetime) and let the
  client reconnect with `Last-Event-ID`, which re-authenticates it with no new code in
  `auth.ts`. Decide once, for both domains.
- **"Sign in with another account" can't force an account chooser.** After `not-a-member`,
  `/api/auth/login` passes no `prompt`, so Google may sign the same account straight back
  in. Email and password showed the email form again, which is fine. `createSignIn` takes
  `prompt: "select_account"`. Wiring it needs a `signIn` option in `@voluma/api-client`
  (a contract PR) and a `prompt` query parameter on `/login`.
- **Clean up abandoned scan uploads.** An upload never completed leaves an `uploading`
  row and objects under `uploads/<inputId>/`; a PUT URL used after complete leaves a stray
  object there too. Add an R2 lifecycle rule deleting `uploads/` objects after 2 days, and
  delete `uploading` rows older than the URL lifetime (6 h, `inputs.ts`) on a schedule. Also
  delete `inputs/<id>/` for any id with no `ready` row: a complete cancelled or abandoned
  part way through its copy leaves files there.

- **Drop the `runs.recoveries` column.** Nothing reads or writes it since the no-progress limit
  (`claim-progress.ts`) replaced it, but it stays in `schema.ts` so the previous deploy's code,
  which still selects it, keeps working while a migration runs. Drop it in a later PR, once that
  code is drained.

- **`seed:example --backfill` checks focus ids after its R2 writes.** `copyEvidence` and
  `uploadBackfill` run before `backfillRows`'s focus check, so a bad id uploads ~2 GB under an unused
  example id before refusing. Move the check into `readBackfill` and run it first; also check each
  id's kind as the fold does (`volumeId` must be a labels volume). (review p563 of #178)
- **`devWritePrefix` is a plain prefix match:** `r2:dev` writes at the root of `dev/`, and
  `r2:dev//x` and `r2:dev/../runs/x` pass (R2's own 403 stopped the last). Require a segment after
  `dev/` and reject empty, `.` and `..` segments. (p563)
- `backfill.py`'s scan-grid ruler assert can't fail (both sides use the same transform); compare
  against the `points` `export.py`'s `ruler()` writes. (p563)
- **Drop `runs.cost_cap_usd` and `provider_calls.reserved_usd`.** Nothing writes or reads either
  (the spend cap and reservations are gone; both are nullable). The previous deploy's API still selects
  `cost_cap_usd` by name, so drop them in a PR after the no-spend-cap PR is live, with both
  columns out of `apps/api/src/domains/run/schema.ts` and `packages/provider-calls/src/schema.ts`,
  and the migration check in `apps/gateway/src/main.ts` unchanged (it names neither).
