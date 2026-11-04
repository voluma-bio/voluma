# TODO

- **Finish deleting `awaiting-keys` (step 2, after the PR that removed it is live).** Delete the
  `stuck` sweep in `sweep` (`domains/run/pg-queue.ts`) and the `awaiting-keys` case in `toRun`
  (`pg-runs.ts`); drop `"awaiting-keys"` from the `runs.state` enum and drop the `awaiting_since`
  column in `schema.ts`, with a migration. Step 1 left both so an API built before it, live in a
  deploy overlap, cannot strand a run.
- **A new guest cookie is a fresh upload cap: accepted until after the Nov 4 demo (Jimmy, 3 Nov).**
  The per-person cap (`UPLOAD_LIMIT_PER_USER_GB`, [deploy.md](deploy.md)) counts per user id, and
  guests cost nothing to mint, so clearing cookies gives 50 GB more. After the demo: a combined cap
  on the guest organization's total, or a per-IP limit on minting guests.
- **Let converted runs be reopened (step 2 of retiring the task loop).** `messageRefusal`
  (`domains/run/corrections.ts`) refuses a run holding a `convert:<runId>:outputs` event. The
  snapshot is no longer the blocker (a run with no `.snapshot-done` marker re-cuts it on claim, and
  the pin check passes: 0026 renamed the pin). The log is. ce5a0f21's marker was re-written on
  2026-11-04 by the local reopen below (commit `b8a0237b`), so delete it again before relying on that. Lifting only the refusal, on a local
  copy of ce5a0f21 (2026-11-04), gave a failed correction: `pinOf` (`packages/harness/src/supervise-run.ts`)
  throws "made by an older version", because the root `thread.started` has no `sandboxImage` and its id
  is `<runId>.supervisor`, not `threadIdOf(runId, ROOT_NAME)`. With `pinOf` also relaxed, the claim
  minted a second root, re-wrote the opening `outputs.changed` (keyed to the new root), pinged every
  task-loop worker as idle (they ended `completed`, never `closed`) and resumed them (they failed only
  on a model mismatch), and started main with the new-run brief, not a review handover: there is
  no earlier main to hand over from. So lift the refusal only together with: closing the task
  threads (`thread.ended` `closed`, a migration for converted runs); taking the root from the stored
  root `thread.started`, not deriving it, in `superviseRun`, `pinOf` and the loop's `${root}:outputs`;
  no image pin for a root that recorded none; and a review main that starts with a handover when no
  main came before it (`startMain`/`handoverOf` in `packages/harness/src/loop.ts`, `NO_SUMMARY`).
  Check it with a local reopen of `import:run --from r2:dev/runs/ce5a0f21-c948-4e20-a03f-04ff7f0e707b`,
  first setting the local copy's `runs.model` to `deepseek/deepseek-flash`: a reopen keeps the run's
  stored model, `RUN_MODEL_OVERRIDE` applies only at creation, and with none stored the runner falls
  back to its default model. The imported run keeps its id, so the local runner writes
  `runs/<id>/…` keys that staging's copy also reads (#564).
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

- **`devWritePrefix` is a plain prefix match:** `r2:dev` writes at the root of `dev/`, and
  `r2:dev//x` and `r2:dev/../runs/x` pass (R2's own 403 stopped the last). Require a segment after
  `dev/` and reject empty, `.` and `..` segments. (p563)
- **Copied runs read the source's scratch images.** `seed:example` copies `pi_messages` verbatim, and
  history rows hold R2 image keys under the source run's `runs/<runId>/scratch/…`. Fine for a read-only
  example; give a copy its own keys (or resolve them per run) before an example can be rerun or reopened.
- **The example on Studies.** Its sample counts as Done (#454), but its progress mark and the Samples tree's glyph are still amber To check, which nobody can act on. A neutral "Example" mark would read better.
- **Example studies hold only reference inputs.** Reading a study reads every input in it. `seed:example` and `import:run` should assert that an example study has only the reference input.
- **Mark and view caps count characters.** `MAX_MARK_BYTES` and `MAX_VIEW_BYTES` (`runs.ts`) measure `JSON.stringify(...).length`, so a note of multi-byte characters can be up to 3× the cap; `browserLimit` (256 KB) still bounds the request. Measure UTF-8 bytes.
- **Delete `readOldDump` in `src/ops/import-run.ts`** once no run dump written before `credentials: "visitor"` became `"own"` or the
  `studyMembers` key remains (those have `studyScans` for the study rows and `studyInputs` for
  the input rows, e.g. `r2:dev/runs/732a2eea…`).
- **Delete the `scans` alias** in `createStudyRequestSchema` (`packages/contracts/src/study.ts`)
  once the deploy that renamed it to `inputs` is live and old `/new` tabs are gone.
- **Heartbeat after cancel drops usage.** A heartbeat that arrives after the run is cancelled does not add its cost to `runs.model_cost_usd`, so the org spend limit undercounts that tail. Decide whether the cancel path should accept a final usage report.
- **Delete `POST /ingest/runs/:id/live`** (`domains/run/ingest.ts`), accepted and dropped for runners built before live frames were deleted; once none is live.
- **Drop the task loop's deploy-overlap leftovers** once no runner or API built before "Delete the task loop" is live: the claim's `harnesses` field (`packages/contracts/src/runner.ts`, `adapters/http/hand-off.ts` in the runner, `ingest.ts`), the `runs.harness` column (`domains/run/schema.ts`, written `agents` by `startRuns` in `pg-queue.ts`) and its migration. `thread.started.harness` in stored events is stripped by the parser; no migration is needed.
