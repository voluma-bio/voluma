# TODO

- **No total storage cap on guest uploads (for Jimmy to decide).** Guests may upload (#533); the only
  limits are per scan (5,000 files, 20 GB) and 3 uploads in progress per user (`inputs.ts`).
  Finished uploads are never capped and guests cost nothing to mint. Add a total-bytes cap per
  user or organization, or rate-limit guest minting.
- **Constrain sealed keys after #533 is live.** Add `CHECK (state <> 'ended' OR sealed_keys IS NULL)`
  on `runs`; before that, the old code's end writes would fail during the deploy overlap.
- **Let converted runs be reopened (step 2 of retiring the task loop).** `messageRefusal`
  (`domains/run/corrections.ts`) refuses a run holding a `convert:<runId>:outputs` event, because
  its R2 snapshot is the task loop's. Delete that lookup once the deletion PR's snapshot fallback
  is live and the 7 old `.snapshot-done` markers are deleted ([convert-task-runs.md](convert-task-runs.md)).
- **Reconcile abandoned provider calls before archiving their runs.** Archive now refuses
  calls without a completed settlement (`duration_ms IS NULL`), including swept `cut` rows.
  Late settlement is preserved; genuinely settled unknown-cost calls remain archivable.
  A crashed handler that never settles leaves its run retained indefinitely. Decide how an
  operator proves no settlement can arrive and records unknown accounting before permitting
  removal; don't fabricate duration/cost or add an age-based override. Export remains available.
- **Neon after the freeze.** Moves to Launch on 2026-11-04 (always-on passes Free's 100
  CU-hours; [deploy.md](deploy.md)). After judging (about Nov 18) the new staging gets its own
  Neon project; downgrade or delete this one then. Launch has no 1 GB cap, so watch the bill, not storage.
- **Postgres migration drill.** Before the lab relies on the database: `pg_dump` from
  Neon (direct URL, see [deploy.md](deploy.md)), restore into a fresh local Postgres, run the app against the copy. Proves the "portable Postgres" rule.
- **Scheduled `pg_dump` to R2**, so backups don't depend on the host.
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
  object there too. The bucket's lifecycle rule deletes `uploads/` objects after 2 days (set
  3 Nov 2026, with `work/` after 7 days); still to do: delete `uploading` rows older than the URL lifetime (6 h, `inputs.ts`) on a schedule. Also
  delete `inputs/<id>/` for any id with no `ready` row: a complete cancelled or abandoned
  part way through its copy leaves files there.

- **`seed:example --backfill` checks focus ids after its R2 writes.** `copyEvidence` and
  `uploadBackfill` run before `backfillRows`'s focus check, so a bad id uploads ~2 GB under an unused
  example id before refusing. Move the check into `readBackfill` and run it first; also check each
  id's kind as the fold does (`volumeId` must be a labels volume). (review p563 of #178)
- **`devWritePrefix` is a plain prefix match:** `r2:dev` writes at the root of `dev/`, and
  `r2:dev//x` and `r2:dev/../runs/x` pass (R2's own 403 stopped the last). Require a segment after
  `dev/` and reject empty, `.` and `..` segments. (p563)
- `backfill.py`'s scan-grid ruler assert can't fail (both sides use the same transform); compare
  against the `points` `export.py`'s `ruler()` writes. (p563)
- **Copied runs read the source's scratch images.** `seed:example` copies `pi_messages` verbatim, and
  history rows hold R2 image keys under the source run's `runs/<runId>/scratch/…`. Fine for a read-only
  example; give a copy its own keys (or resolve them per run) before an example can be rerun or reopened.
- **View snapshots on an example run.** Since #435 every org reads example runs, and `POST /review/runs/:id/snapshots` checks only readability. So any reader can save a snapshot on the example, and every reader lists them, `by` included, guests too. Refuse saves on `run.example`, or list only the caller's own on an example. No UI calls these endpoints yet.
- **The example on Studies.** Its sample counts as Done (#454), but its progress mark and the Samples tree's glyph are still amber To check, which nobody can act on. A neutral "Example" mark would read better.
- **Example studies hold only reference inputs.** Reading a study reads every input in it. `seed:example` and `import:run` should assert that an example study has only the reference input.
- **Mark and view caps count characters.** `MAX_MARK_BYTES` and `MAX_VIEW_BYTES` (`runs.ts`) measure `JSON.stringify(...).length`, so a note of multi-byte characters can be up to 3× the cap; `browserLimit` (256 KB) still bounds the request. Measure UTF-8 bytes.
- **Delete `readOldDump` in `src/ops/import-run.ts`** once no run dump written before the
  `studyMembers` key remains (those have `studyScans` for the study rows and `studyInputs` for
  the input rows, e.g. `r2:dev/runs/732a2eea…`).
- **Delete the `scans` alias** in `createStudyRequestSchema` (`packages/contracts/src/study.ts`)
  once the deploy that renamed it to `inputs` is live and old `/new` tabs are gone.
- **Heartbeat after cancel drops usage.** A heartbeat that arrives after the run is cancelled does not add its cost to `runs.model_cost_usd`, so the org spend limit undercounts that tail. Decide whether the cancel path should accept a final usage report.
