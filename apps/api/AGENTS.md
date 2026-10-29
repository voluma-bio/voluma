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
  locally, Railway's pre-deploy step in production. Never at server start: `migrate()`
  takes no lock. It is not drizzle-kit, a devDependency that Railway prunes.
- **A migration must work with the code that is deployed now.** Railway migrates, then
  starts the new deployment beside the old one, which keeps serving until `/health`
  passes, and the migration stays applied if that deploy fails. So expand first (add
  nullable columns or tables, columns with defaults), and contract (drop, rename, add
  `NOT NULL`) in a later PR, after the code that stopped using the old shape is deployed.
  See [.context/deploy.md](.context/deploy.md).
- Anything the server or `migrate.ts` runs in production belongs in `dependencies`
  (Railway prunes dev dependencies after the build).
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

- `index.ts` is a mount list: `runs.ts` (browser routes: reads `requireReader`, writes `requireUser`), `ingest.ts` (runner
  routes, `requireService`), and a file per later route group. The Postgres adapters:
  `pg-queue.ts` owns every state change of a run (start, resume, cancel, claim, lease,
  recovery) and the key vault, `pg-runs.ts` the reads, and the lease-checked
  `pg-event-log.ts`/`pg-history.ts`; their port types are derived from them. `admission.ts`
  is the one limits check and the one message per refusal.
- **Every transition holds one lock** (`QUEUE_LOCK`, a transaction advisory lock), so
  limit counts can't race. The lease is judged by the database's `now()`. An ingest write
  checks the run's lease token inside its own transaction (`assertLease`, `FOR SHARE`); a
  late write can't land after a takeover.
- **Recovery ends a claim with a reason** (`shutdown`, `self-stop` from the runner's `released`;
  `lease-expired` when the claim's sweep finds the lease gone). `recover` in `pg-queue.ts` stores it
  for the next claim's `previousClaim` and applies the no-progress limit (`claim-progress.ts`:
  the counting rule and the progress events). There is no other restart counter.
- **Visitor keys live only in `key-vault.ts`**, in memory, and only `pg-queue.ts` touches it,
  under the lock. Never store, log or return them, and log no body on a route that takes
  them. A transition holds the keys before the write that makes the run claimable commits;
  cancel, failure and the claim drop or hand them out; the claim moves any queued visitor
  run whose keys its process doesn't hold to `awaiting-keys`. The vault holds at most 100
  runs per org (429), and `index.ts` caps every `/api` body at 256 KB (8 MB on `/api/run/ingest/*`, the trusted runner).
- **Limits come from env** (`RUN_LIMITS_<ORG>_*`, read in `index.ts`); the workflow catalog
  (`catalog.ts`) is code. `seed:example --from <runId>` makes an example run
  (`src/domains/run/seed-example.ts`). Outage and restart behaviour: [.context/deploy.md](.context/deploy.md).

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
- Run list/get reads memoize at most 256 derived summaries, keyed by each run's latest
  event ID (ordered by sequence) in the same repeatable-read snapshot, including reseeded
  examples with reused sequence numbers. Cache misses load only fold/review
  events; hits load no event payloads. The event log remains the only durable review state.
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
- `runs.ts` also serves `GET /runs/:runId/assets/:sha256/<path>`: a converted review asset
  (`reviewAssetKey`), after `RunRecords.readable`, as a 302 to a 10-minute presigned GET
  (`RunFiles.assetUrl`) with `Cache-Control: no-store` on the redirect; R2's response says
  `immutable`. The path is checked segment by segment from the raw URL. Missing keys are R2's 404s,
  which a zarr reader takes as empty chunks.
- `r2-reference-archive.ts` serves only the published reference scan. Deferred work:
  [.context/TODO.md](src/domains/review/.context/TODO.md).
