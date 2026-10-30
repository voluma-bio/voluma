# apps/api

Node server on Postgres. Architecture and the `seq` allocator: [.context/CONTEXT.md](../../.context/CONTEXT.md).

- Tables are Drizzle schemas, one file per domain (`src/domains/<domain>/schema.ts`).
  Change the schema, then `pnpm --filter @voluma/api db:generate` writes a `.sql`
  migration to `drizzle/`. Commit it. Never run `drizzle-kit push`.
- **After merging `origin/main`, delete your branch's unmerged generated migration
  (its `drizzle/*.sql` and the matching entry and snapshot in `drizzle/meta/`) and
  regenerate it, then `pnpm db:reset`.** The worktree's database still holds the old
  migration and cannot apply the new one; `db:reset` drops it and `pnpm dev` rebuilds it. Two branches that generate from the same base collide on the
  migration number, the journal and the snapshots.
- Migrations run from one place, `src/migrate.ts` (`pnpm db:migrate`): `pnpm dev` runs it
  locally, Render's pre-deploy command in production. Never at server start: `migrate()`
  takes no lock. It is not drizzle-kit, a devDependency.
- **A migration must work with the code that is deployed now.** Render migrates, then
  starts the new deployment beside the old one, which keeps serving until `/health`
  passes, and the migration stays applied if that deploy fails. So expand first (add
  nullable columns or tables, columns with defaults), and contract (drop, rename, add
  `NOT NULL`) in a later PR, after the code that stopped using the old shape is deployed.
  See [.context/deploy.md](.context/deploy.md).
- Anything the server or `migrate.ts` runs in production belongs in `dependencies`
  (Render doesn't prune today, but a host that builds once and prunes would).
- When `apps/web/dist` exists, `index.ts` also serves it (hashed `assets/` immutable,
  everything else `no-cache`, the app shell for extensionless non-`/api` GETs). Deploying to staging:
  [.context/deploy.md](.context/deploy.md).
- `pi_messages.message` stays `text`; `jsonb` would reorder keys and break the
  byte-for-byte history.
- Only `src/index.ts` reads env. It hands `createAuth` (`src/auth.ts`) the WorkOS values;
  AuthKit would otherwise read `WORKOS_*` from `process.env` itself.
- **Guests are principals too.** `GUEST_ORGANIZATION_ID`/`GUEST_SCOPE` (read in `index.ts`)
  make a browser holding a guest cookie a `user` with `account: "visitor"` and no email
  (`auth.ts`); `POST /api/auth/guest` is the only minter. `readerOf` is still the only
  place scope becomes a filter. Unset: 401.
- **Domains read the caller from the context, not the request.** The root authenticates
  once (`src/auth.ts`) and answers 401 when there is no principal. A domain app is
  `new Hono<AppEnv>()` (`src/domain.ts`) and reads `c.get("principal")`; the runner's
  ingest subtree is behind `requireService` (the runner's token only). A run read takes
  `requireReader` on its own route: a user reads through `readerOf`, the optional debug
  token (`VOLUMA_DEBUG_TOKEN`, principal `service`/`debug`) reads every lab's runs
  (`EVERY_LAB`) and writes nothing. A subtree for signed-in members is
  `new Hono<UserEnv>().use(requireUser)`, whose handlers read the narrowed
  `c.var.user` (`userId`, `email`, `name`, `labId`, `scope`) and never check `kind`. Any
  other kind gets 403. **Reads go through the reader:** a domain passes `readerOf(c.var.user)`
  (`src/domain.ts`: `{ labId, ownerId }`, `ownerId` null for a lab member and the user's id for
  a `self` user) into its store port's read methods, and the adapter applies it once
  (`labId = ? AND (ownerId IS NULL OR created_by = ownerId)`). Handlers never branch on
  `scope`, which is server-internal; no domain reads an organization id. A domain never reads cookies, tokens or `Origin`; the CSRF and Origin checks
  are the root's.
- Each domain's factory returns a Hono app, mounted by `index.ts` with `app.route`. Use
  Hono's routing and params; the root's JSON 404 and `onError` cover the domains.
- A domain's tables and their Postgres adapters live in the domain
  (`src/domains/<domain>/pg-*.ts`), constructed only by `index.ts`. `src/adapters/` is for
  adapters of the shared `src/ports/`.
- `pnpm dev` is the only launcher, and it starts the API with the repo `.env`.

## Run domain (`src/domains/run`)

- `index.ts` is a mount list: `runs.ts` (browser routes: reads `requireReader`, writes `requireUser`), `studies.ts` (create, list, get), `ingest.ts` (runner
  routes, `requireService`), and a file per later route group. The Postgres adapters:
  `pg-queue.ts` owns every state change of a run (start, resume, cancel, claim, lease,
  recovery) and the key vault, `pg-runs.ts` and `pg-studies.ts` the reads (one `resultsLoader` cache for both), and the lease-checked
  `pg-event-log.ts`/`pg-history.ts`; their port types are derived from them. `admission.ts`
  is the one limits check and the one message per limit.
- **Every run belongs to a study** (`studies`, `study_scans`; `runs.study_id` is not null), and
  the study owns the workflow. `readableStudies` (`pg-runs.ts`) is `readableRuns` on the study
  (guests share one lab, so `lab_id` alone is not enough); `queue.start` checks `studyId` with
  it. `queue.createStudy` inserts the study, its scans and the runs to start in one
  transaction under the lock: any refusal throws an `HTTPException` (status and text, where it is decided) and rolls the whole call back, and
  `startRuns` reads the counts once and raises them for each run it inserts. Every browser
  write (start, create, cancel, resume) goes through `attempt`: a refusal rolls it back and reaches the
  client (`onError` answers `{error}`), and `attempt` drops the visitor keys it held. `runs` has no workflow
  column: `pgRunQueue` gets `workflowOf` and resolves the pins and outputs from the study. The seeded example has
  its own study (`study-<exampleId>`, `example`), read-only like its run; `import:run` gives
  an imported run a study of one the same way.
- **Every transition holds one lock** (`QUEUE_LOCK`, a transaction advisory lock), so
  limit counts can't race. The lease is judged by the database's `now()`. An ingest write
  checks the run's lease token inside its own transaction (`assertLease`, `FOR SHARE`); a
  late write can't land after a takeover.
- **Recovery ends a claim with a reason** (`shutdown`, `self-stop`, `provider-outage` from the runner's `released`;
  `lease-expired` when the claim's sweep finds the lease gone). `recover` in `pg-queue.ts` stores it
  for the next claim's `previousClaim` and applies the no-progress limit (`claim-progress.ts`:
  the counting rule and the progress events). There is no other restart counter. A
  `provider-outage` release also sets `runs.claimable_after` (the delay rule is `outageDelayMinutes`);
  `claim` takes only runs with it null or past, and clears it.
- **A researcher's message reopens a finished run** (`messages.ts` in contracts is the rulebook;
  `queue.checkMessage`/`sendMessage` in `pg-queue.ts` call `corrections.ts`, which holds the
  rules; Review's `POST /runs/:id/messages` calls them through the `RunMessages` port after it
  checks and stores the snapshot PNG). `decideMessage` judges in the contract's order, under the
  queue lock for `sendMessage`. **Lock order, everywhere: the queue lock, then the run's event lock
  (`eventLock`), then row locks** (a runner's append takes the event lock before it shares the run
  row, so a transaction holding the row and then asking for the event lock deadlocks with it:
  `recover`, `heartbeat`, `report` and `decideMessage` take the event lock first, through the one
  `eventLock` in `pg-event-log.ts`; `decide` (review decisions) checks the run has ended before
  taking it, so an accept on a running run never holds it while loading the log). `decideMessage` refuses a message
  to a queued or running run (409: one message, one claim) and reopens an ended `completed` one: it
  writes `run.reopened`, clears `lastClaimEnd`, `stalledClaims` and the lease. A run is in a
  correction while `corrections(events).open` (`@voluma/contracts/fold`; `openCorrection`: no
  `correction.ended` since the latest `run.reopened`), so its claims are corrections. A correction never ends a run worse than `completed`: every way the queue would
  fail or cancel a run (`endUnfinished`: the runner's failed end, the no-progress limit, a refused
  claim or heartbeat, a user's cancel) ends it `completed` with `correction.ended` and its threads
  cancelled, the open ones and those that finished inside the correction (`cancelEnds`).
- **Visitor keys live only in `key-vault.ts`**, in memory, and only `pg-queue.ts` touches it,
  under the lock. Never store, log or return them, and log no body on a route that takes
  them. A transition holds the keys before the write that makes the run claimable commits;
  cancel, failure and the claim drop or hand them out; the claim moves any queued visitor
  run whose keys its process doesn't hold to `awaiting-keys`. The vault holds at most 100
  runs per org (429), and `index.ts` caps ordinary `/api` bodies at 256 KB (8 MB on
  `/api/run/ingest/*`, the trusted runner; 12 MiB only on screenshot POSTs).
- **Limits come from env** (`RUN_LIMITS_<ORG>_*`, read in `index.ts`); the workflow catalog
  (`@voluma/workflow/bundled`) is code. `seed:example --from <runId> [--backfill <dir|r2:prefix>] [--remote]` makes an example run (it copies the source's `evidence/`, `review/`, `scratch/person/` and `outputs/` under the example's prefix)
  (`src/domains/run/seed-example.ts`; it needs `GUEST_ORGANIZATION_ID`, the Demo organization, in `.env`). To get a run into a fresh local database:
  `export:run --id <runId> --out <dir|r2:dev/…>` dumps its rows to `run.json`, and
  `import:run --from <dir|r2:prefix> [--replace]` loads them (events are checked with
  `runEventSchema`; an existing run is refused without `--replace`). Evidence stays in R2.
  `archive:run --id <runId> [--out <dir>] --remote` (all three are in `src/ops/`, since they read both domains'
  tables) copies an ended run's rows to `~/.local/share/voluma-backups/runs/<runId>/` and deletes
  them; it refuses a non-local database without `--remote`, like `import:run`. See [.context/deploy.md](.context/deploy.md).
  `r2:put --from <dir> --to r2:dev/<prefix>` uploads a folder. An `r2:` location is a prefix in the
  `R2_BUCKET` the dev servers use (`r2-dir.ts`). Operator scripts use `DATABASE_URL`, else the
  database `pnpm dev` wrote to `.dev/env.json`; each prints its database and bucket first, writes to
  R2 only under `dev/`, and `import:run` / `seed:example` refuse a non-local database without
  `--remote`. R2 is shared with staging, so a local seed names its example
  `example-local-<runId>` (it refuses `example-<runId>`, the id staging reads, without `--remote`).
  Shared dev data: `dev/runs/<runId>/` (dump) and `dev/backfill/<runId>/` (backfill folder) for
  ce5a0f21-c948-4e20-a03f-04ff7f0e707b. Outage and restart behaviour: [.context/deploy.md](.context/deploy.md).

## Review domain (`src/domains/review`)

- `index.ts` is a mount list, like the run domain's. `runs.ts` serves `GET /runs/:runId`: the
  run's `ReviewRun` (`@voluma/contracts/review`), built on each read by `review-run.ts` from
  `fold` over the run's whole event log, plus what `fold` leaves to the API. It parses the
  result with `reviewRunSchema`, so a bad build is a 500, never invalid data.
- It reads runs and writes human decisions only through `RunRecords` (`src/ports`), wired
  to Run's `pg-run-records.ts`. Reads use one repeatable-read snapshot. Decisions hold
  the existing event-sequence lock **before** the run-row lock, then validate and append
  atomically; preserve that order to avoid deadlocking runner appends. Review owns policy;
  Run owns authorization filters, sequence allocation and persistence. No domain imports
  the other. `review-state` overlays acceptance on `fold` without changing scientific state.
- Accept check resolves one current task-result/check identity; only explicit Mark reviewed
  at zero remaining sets `reviewedAt`. Both are idempotent, shared across authorized
  readers, and forbidden on examples. The same derived summary is `Run.review` and
  `ReviewRun.review`; no persisted count is maintained. Unfinished/failed/cancelled runs
  have null summaries. Review mutations return/refetch snapshots; execution SSE closes
  at run end and does not continuously deliver human review changes.
- Run list/get and study reads memoize at most 2048 derived results (`{summary, tasks, values, toCheck}`, all from one `reviewState(log)`; least recently read out first), keyed by each run's latest
  event ID (ordered by sequence) in the same repeatable-read snapshot, including reseeded
  examples with reused sequence numbers. Cache misses load only fold/review
  events; hits load no event payloads. The event log remains the only durable human-decision state.
- `inputs.ts` owns `/inputs/:inputId/download` and `/inputs/:inputId/file`, guarded by
  `requireUser` only under `/inputs/:inputId/*`. Both authorize through `ReviewInputs`
  and `readerOf` before using `ReferenceArchive`. Reject HEAD before opening R2; keep
  the descriptor's ETag pin and stream the file without buffering.
- `runs.ts` also serves `GET /runs/:runId/files/:sha256`: one of the run's content-addressed
  files (`evidenceKey`) through `RunFiles` (`r2-run-files.ts`), after `RunRecords.readable`.
  No descriptor or ETag pin: the key is the content hash, so the bytes never change (`immutable`,
  a day). The leading bytes pick the type: JPEG and PNG inline, anything else an attachment,
  always `nosniff`, since the stored content type is whatever the sandbox mount wrote. HEAD is
  a 405 before storage is opened.
- `snapshots.ts` owns immutable screenshots, separate from scientific results and human
  decision events. Authorized readers may save them, including on examples and historical
  revisions. Review owns metadata; `RunFiles.put` publishes validated static PNGs before
  metadata is inserted. Retries keep the same UUID/pixels and return the original actor/time;
  conflicting captures return 409. Run's internal `generation` changes on example replacement:
  every snapshot query and insert uses it, so late saves cannot attach to the replacement.
- A screenshot is one grid-viewer pane (`slice` or `3d`) on a `gridId`. The API checks the
  grid has an image volume in the pinned revision, the crosshair lies on it, and every
  structure and focus reference belongs to the revision; it refuses new `acquired` (DICOM
  viewer) saves, which stay listed. `RUN_FILES_DIRECTORY` selects local run-file
  storage at the composition root; it never redirects the read-only reference archive.
- `runs.ts` serves `GET /runs/:runId/assets/:sha256/*`: a converted review asset
  (`reviewAssetKey`, written by the runner's conversion worker) as a 302 to a presigned R2 GET
  (`RunFiles.assetUrl`: signed at the start of a 4-minute window and valid 5 minutes, so repeat
  requests get the same URL; `ResponseCacheControl` makes R2's own response `immutable`, capped
  at a day like the files route). The 302 is `private` with a `max-age` 30 s below the URL's
  remaining validity, so the browser's cache serves the repeats (a viewer asks per chunk). Assets live under the
  run's own prefix, so the read check on the run is the whole scope check, and the route reads
  no event log (a viewer sends one request per chunk). The tail goes through `relativePathSchema`;
  the route does not check the object exists, so a missing chunk is R2's 404 on the redirect.
- `r2-reference-archive.ts` serves only the published reference scan. Deferred work:
  [.context/TODO.md](src/domains/review/.context/TODO.md).
