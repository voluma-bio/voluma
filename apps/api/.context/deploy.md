# Deploying the API (Render staging)

The API is the user-facing service: it serves the built web app and `/api/*`. Postgres is
Neon's free tier (AWS us-east-1, next to Render's Virginia), reached over the internet with TLS;
see "The database (Neon)". Staging moved from Railway to
Render on 2026-10-30 because Meta's API refuses Railway's network (`decisions.md`).

## How it is set up

Render workspace `Voluma Staging`, region Virginia for everything. **`render.yaml` at the repo
root is the record**: build, pre-deploy, start, health check, shutdown delay, build filter,
plan and every variable name, with the reason beside each. A change to those is a PR to that
file, and Render applies it when the Blueprint syncs (not on a service deploy). Services:

| Service | State |
|---|---|
| `voluma-api` | Web service, auto-deployed from `main`. `https://voluma-api.onrender.com` until a custom domain (`app.voluma.bio`) exists |
| `voluma-gateway` | Web service: the provider gateway. Notes: [../../gateway/.context/deploy.md](../../gateway/.context/deploy.md) |
| `voluma-runner` | Background worker, always on until 2026-11-04, then suspended between runs (its deploy.md). Claims runs over the private network (why not the public URL: runner deploy.md, `VOLUMA_API_URL`). Notes, variables and the sandbox image: [../../runner/.context/deploy.md](../../runner/.context/deploy.md) |

Things `render.yaml` holds that are easy to miss:

- **Start is `cd apps/api && exec node --import tsx src/index.ts`**: `exec` makes node the process that gets SIGTERM; run from `apps/api` because that is where tsx resolves. Never `pnpm start`. A bundled `tasks.json` or `outputs.json` that fails its schema stops the API from starting (the health check fails and the old deploy keeps serving); `pnpm check` parses them first (`packages/workflow/src/bundled.test.ts`).
- **Pre-deploy is `pnpm --filter @voluma/api db:migrate`** (`src/migrate.ts`), the only place migrations run in production; a failure stops the deploy and prints the error in the deploy log.
- **Health check `/health`** is liveness only (no database): the gate for moving traffic, not monitoring.
- **Shutdown delay 30 s**, above the API's `DRAIN_MS` (10 s) in `src/index.ts`.
- **Build filter** (the paths that redeploy the API): `apps/api`, `apps/web`, `packages`, the root build files, and `workflows/*/outputs.json` and `workflows/*/tasks.json` (`@voluma/workflow/bundled` imports them for the workflow catalog and the web build's outputs and task titles). No other `workflows/`: the API reads no other workflow file; the runner snapshots them and records its own commit (`RENDER_GIT_COMMIT`) in each run.
- **One instance** (`numInstances: 1`): see "What a restart or outage does to runs".
- The root `prepare` script skips `lefthook install` when `LEFTHOOK=0` (set in the env group `voluma-shared`, with `NODE_VERSION` and `R2_BUCKET`).
- **Render doesn't prune dev dependencies**, but keep everything the server runs in `dependencies` (tsx, drizzle-orm): [../AGENTS.md](../AGENTS.md).

Render has no variable interpolation, and an env group can't hold `sync: false` values. So
secrets are per-service `sync: false` (asked for once when the Blueprint is created; a variable
added to the yaml later must be set in the dashboard), and a secret two services share is read
from its owner with `fromService` (`VOLUMA_API_TOKEN` from the API, `GATEWAY_TOKEN_SECRET` from the
gateway). `fromService` values refresh on each Blueprint sync, not on the
instant the source changes.

Variables on `voluma-api` (names in `render.yaml`; values never go in the repo):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's direct (unpooled) connection string, `sslmode=require`; asked for when the Blueprint is created. The pooled host (`-pooler`) breaks prepared statements |
| `VOLUMA_API_TOKEN` | random 32 bytes, hex. The runner reads it from here |
| `VOLUMA_DEBUG_TOKEN` | optional; random 32 bytes, hex. Lets agents read every lab's runs (`GET /api/run/runs…`) and nothing else; unset turns it off |
| `APP_URL` | the origin browsers use, no trailing slash: today the service's own `RENDER_EXTERNAL_URL` (self-reference in the yaml); with a custom domain, replace it with that origin as a literal. Must be https (the session cookie is then `Secure` and named `__Host-wos-session`). Builds the sign-in redirect and the `Origin` check |
| `WORKOS_CLIENT_ID`, `WORKOS_API_KEY` | WorkOS dashboard, API Keys (staging environment) |
| `WORKOS_COOKIE_PASSWORD` | `openssl rand -base64 32`; seals the session cookie |
| `WORKOS_LAB_ORGANIZATION_ID` | the Yao Lab organization's id (`org_...`); its members get scope `lab` |
| `WORKOS_JUDGES_ORGANIZATION_ID` | the Judges organization's id; its members get scope `self`. Unset means no Judges sign-in |
| `GUEST_ORGANIZATION_ID`, `GUEST_SCOPE` | set on `voluma-api`: guest sign-in is on (below). Optional: let anyone in as a guest of this organization (`self` or `lab`, default `self`). Never the Yao Lab, whose data is for signed-in members only (startup throws if the guest organization is one members sign in to). Unset means the sign-in wall |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (and `R2_BUCKET=voluma-staging` from the group) | Optional as a group: enables a run's files (`/api/review/runs/:runId/files/:sha256`, reads under `runs/<id>/evidence/`) and scan uploads. Use an Object Read & Write token scoped to `voluma-staging` (uploads presign PUTs to `uploads/` and move them to `inputs/`); only the server receives it. Missing or partial configuration leaves the API running and returns 503 for a run file or an upload. The bucket's CORS has two rules, both for any origin: `scan-upload-put` allows `PUT` (the browser PUTs scan files straight to R2; the presigned URL is the credential) and `review-asset-get` allows `GET` and `HEAD` (review assets) |
| `UPLOAD_MAX_FILES`, `UPLOAD_MAX_BYTES`, `UPLOAD_MAX_OPEN` | not in `render.yaml`; optional: files and bytes per scan upload (default 5000 and 20 GB), and uncompleted uploads per member (default 3) |
| `RUN_LIMITS_<ORG>_<LIMIT>` | what an organization may run, `<ORG>` one of `LAB`, `JUDGES`, `DEMO` (the guest organization) and `<LIMIT>` one of `PER_CALLER`, `CONCURRENT`, `VISITOR_ACTIVE` (visitor runs queued or running, per org: a start or `/keys` past it is a 429; `awaiting-keys` runs don't count). Unset is no limit, so they are literals in `render.yaml`: Yao Lab `CONCURRENT=4`; Judges `CONCURRENT=2`; Demo `PER_CALLER=1`, `CONCURRENT=1`, `VISITOR_ACTIVE=4`. There is no daily limit (2026-10-30, Jimmy): guests run on their own Meta key, so their only cost to Voluma is Modal sandbox time, which the runner's two slots (`RUNNER_CONCURRENCY=2`) and the Modal workspace's spend limit bound; Demo's `CONCURRENT=1` keeps guests from holding both slots. A removed key stays on the service until deleted there (a Blueprint sync doesn't delete it). Read at start: a change is a restart, not a deploy of code |

**Guest sign-in is on on staging** (2026-10-30, Jimmy: staging shouldn't need a sign-in). `GUEST_ORGANIZATION_ID=org_01M609YS5PSWJSNT20NNKSTAA9` (the Demo organization) and `GUEST_SCOPE=self` are set on `voluma-api` in the dashboard; to close it, delete both and restart. Render routes by `Host`, so a sandbox can still reach the API through the gateway's domain (#236); that is accepted because a guest runs only on their own Meta key. Check: `POST /api/auth/guest` with `Origin` and `content-type: application/json` answers 200 when open, 404 when closed. Judges sign in through `WORKOS_JUDGES_ORGANIZATION_ID` either way.

**The client address for WorkOS** is read from one header, `CLIENT_IP_HEADER` in `src/auth.ts`. It is `true-client-ip`: Render's edge overwrites it with the caller's address, and passes a client's own `x-real-ip` through unchanged (checked 2026-10-30 with forged headers).

Staging URL: `https://voluma-api.onrender.com` (`srv-dbidaf3l550s73btnpg0`).

**In the WorkOS dashboard (staging), for each deployed origin:** add
`<APP_URL>/api/auth/callback` to Redirects (`http://localhost:*/api/auth/callback` is
already there for `pnpm dev`), and add `<APP_URL>/` as a sign-out redirect. Without the
sign-out redirect WorkOS ends the session but lands the browser on the app's homepage URL
(`https://voluma.bio/`), not the app. Set sign-up to invitation only: staging holds
unrelated users, and AuthKit lets any of them through sign-in; the API refuses non-members
after the fact (callback and every request), but invitation-only keeps them out of the
organization to begin with.

**Accepted risks.**
- Refresh tokens: on staging WorkOS did not rotate them (three refreshes with one cookie
  returned the same token). A copy of a sealed cookie therefore stays a session until the
  WorkOS session ends, which is why sign-out revokes it server-side. Unknown for
  production; check with one `curl` when production keys exist.
- The PKCE verifier cookies (`wos-auth-verifier-<hash>`) are named by the library and
  carry no `__Host-` prefix. A taken-over `*.voluma.bio` host could plant one together
  with its `state` (login CSRF into the attacker's own account, who must be a lab member).
  Not mitigated here.

## Deploying

Merge to `main`: Render builds, runs the migration, starts the new instance alongside the old
one, moves traffic once `/health` answers, then sends the old one SIGTERM (SIGKILL after the
30 s shutdown delay). A deploy that fails its health check leaves the old one serving.

**The migration runs while the previous code still serves**, and stays applied if the new
instance then fails its health check. So every migration must work with the code that is
deployed now: expand first, contract in a later PR. The rule is in
[../AGENTS.md](../AGENTS.md).

**Migrations 0008 (studies) and 0013 (drops `runs.forked_from`) are the exceptions** (decisions.md). 0008 adds `runs.study_id NOT NULL` and drops `runs.workflow_id` in one step, because there are no users and the nullable form would make the old code's run list throw. 0013 drops a column the old code selects, so it failed the same way until traffic moved: run claims returned 500 for 8 minutes. No migration may do this again: merges never wait for runs, so a drop ships in a later PR than the code that stops reading it (AGENTS.md). During the overlap every run read and write on the old process fails, because `workflow_id` is gone from the table (claim, heartbeat, list, get, start); runner heartbeats retry (`apps/runner/src/lease.ts`). If the new deploy fails `/health`, the whole run API is down until a fix deploys.

## What a restart or outage does to runs

- **One API replica.** The visitor-key vault and the event stream's wake-ups (`notifier.ts`) are in this process's memory, which is correct only while there is one replica (the stream's 5 s poll would still catch events another replica appended). Do not scale the API out. Open event streams end at SIGTERM (`draining` in `src/index.ts`), so they don't hold the shutdown; `EventSource` reconnects with `Last-Event-ID`.
- **A deploy or restart** empties the vault. Every claim moves the queued `visitor` runs whose keys its process doesn't hold to `awaiting-keys` (so a run started on the old process during a deploy overlap is held too), and the browser resends the keys (`/keys`). Running `voluma` runs are unaffected; their leases are in Postgres.
- **An API outage of more than 45 s** (the runner's self-stop margin, `LEASE_SECONDS - HEARTBEAT_SECONDS`) stops every running run: the runner can't heartbeat. Both ways the claim ends are recovered, and the next claim resumes the cut-off threads. A `released` run (`shutdown`, `self-stop`) is recovered at once when the API returns; one whose lease the database expired is recovered at the next claim (`lease-expired`). `lease-expired`, `loop-stalled` and `refused` count toward the no-progress limit (see "A run that keeps cutting off its runner" below); `shutdown` and `self-stop` never do. If the runner's release arrives after a claim swept its lease, the report takes the strike back (`struck_lease_token`). A `visitor` run goes to `awaiting-keys` either way, because its keys are gone.
- **A run that keeps cutting off its runner** ends `failed` after 3 claims in a row that end `lease-expired` (the runner vanished: a crash, an OOM), `loop-stalled` (the runner held only this run and its event loop was blocked for over half its self-stop window; with two runs live a block is a plain `self-stop` for both, so a run that blocks a shared runner is counted only once it is alone) or `refused` (the API answered a heartbeat with a 4xx a retry cannot fix, such as version skew during a deploy: one strike, and a body refused every time ends the run at the limit) with no run-state progress (`claim-progress.ts`; progress is a `task`, `checkpoint`, `output`, `attempt.opened`, `assets.ready`, `plan.changed` or correcting `revision.started` event; model turns, tool calls and the first plan are not). The error names the call in flight: "Stopped: the server lost contact with the runner 3 times in a row without progress (last call: `segment_sam`)." A model provider's error is not a release: it fails the run (`apps/runner/.context/CONTEXT.md`). The run row keeps `last_claim_end` (the next claim's `previousClaim`), `last_progress_seq` (moved by the event append), `claim_start_seq` (the log's last seq at the claim) and `stalled_claims`. A run held "AI unavailable" before provider errors failed fast (`last_claim_end` `provider-outage`) is claimed at the next claim after the deploy, and fails on the provider's next error if it persists.
- **Guests share Demo's allowance.** Limits are per org, so a scripted guest (guests cost nothing to mint) can hold Demo's one runner slot for every other guest. That is the design, not a bug. The same goes for `VISITOR_ACTIVE`: scripted guests can fill Demo's visitor cap and leave honest guests a 429 until those runs end. Both are accepted for open staging. `VISITOR_ACTIVE` bounds the keys the API holds and the runner slots Demo's visitors take; the claim's round-robin across orgs (the org claimed from least recently goes first) keeps them from starving Yao Lab's runs; the vault's 100-runs-per-org cap is a backstop for an org with no cap set.
- **A migration** takes no queue lock; the claim and the runs table follow the expand-first rule like any other. It runs with `lock_timeout` 5 s and retries a timed-out attempt up to 6 times (`src/migrate.ts`), so DDL waiting on a busy table fails fast instead of queueing every query behind it. A heartbeat and a report take no queue lock either (`pg-queue.ts`): a slow claim cannot delay them.

## Operating staging

Everything below works with a Render API key (`RENDER_API_KEY` in `.env`; Dashboard, Account
Settings, API Keys). A key reaches every workspace of the account, so create it with care and
rotate it below. The `render` CLI (`render login`, or `RENDER_API_KEY`) wraps the same API.
Reference: https://api-docs.render.com.

| Id | Value |
|---|---|
| Workspace `Voluma Staging` | `tea-d8maeebtqb8s73br9ev0` |
| `voluma-api` | `srv-dbidaf3l550s73btnpg0` |
| `voluma-gateway` | `srv-dbidaf3l550s73btnpfg` |
| `voluma-runner` | `srv-dbideabl550s73bu5120` |

```bash
r() { curl -s -H "Authorization: Bearer $RENDER_API_KEY" -H 'Content-Type: application/json' "$@"; }
B=https://api.render.com/v1 S=srv-dbidaf3l550s73btnpg0

# The ids (to fill in the table above)
r "$B/services?limit=20"

# Latest deploys and their status (live, build_failed, update_failed, deactivated, ...); newest first
r "$B/services/$S/deploys?limit=3"

# Logs: runtime and build (pre-deploy output is in the deploy's logs). ownerId is the workspace
r "$B/logs?ownerId=tea-d8maeebtqb8s73br9ev0&resource=$S&limit=100&direction=backward"

# One variable. GET /env-vars lists the whole set, every secret in it. PUT /env-vars (no key)
# REPLACES the whole set: use the per-key form
r "$B/services/$S/env-vars/GUEST_SCOPE"
r -X PUT "$B/services/$S/env-vars/GUEST_SCOPE" -d '{"value":"self"}'

# Roll back: redeploy a previous live deploy, then turn autodeploy off yourself (the API
# does not; the dashboard's rollback does). Turn it back on once the fix is merged
r -X POST "$B/services/$S/rollback" -d '{"deployId":"<id>"}'
r -X PATCH "$B/services/$S" -d '{"autoDeploy":"no"}'

# Restart (applies a changed variable)
r -X POST "$B/services/$S/restart"
```

After changing a variable, look at the deploys list: if no new deploy started, restart the
service to apply it (not yet checked on Render). A variable that `render.yaml` lists is reset to the yaml's
value on the next Blueprint sync, so change those in the yaml.

A rollback restores the old code, not the old schema: migrations have already run and
aren't reversed. It is safe only if the migrations since that deploy followed the
expand-then-contract rule. Otherwise fix forward. A rollback through the API leaves autodeploy on, so the next
merge would deploy over it: the `PATCH` above turns it off (not yet run here). Turn it back on
(`{"autoDeploy":"yes"}`, or the dashboard's Settings, Build & Deploy) once the fix is merged.

Gate: merge #333 (the run-keyed contract migration, 0017) only after #332's commit is live on
staging (check the API's deployed commit); the API before #332 can't run on the 0017 schema.

The runner service (`pnpm --filter @voluma/runner start`) claims whatever is queued, so
pointing a local one at staging (`VOLUMA_API_URL`) takes a visitor's run and their keys. Run
it locally only against `pnpm dev`.

An agent checks staging as a signed-in user with `POST /api/auth/password` (`WORKOS_TEST_EMAIL`,
`WORKOS_TEST_PASSWORD`) sending `Origin: <APP_URL>` and `Content-Type: application/json`: the
CSRF check answers any request that changes state without a bearer token, sign-in included,
`403 forbidden origin` without the first and `415` without the second. Keep every `Set-Cookie`
(`src/ops/upload-scan.ts` shows how). Reading runs needs no sign-in: `Authorization: Bearer
$VOLUMA_DEBUG_TOKEN` reads every lab's runs.

## The database (Neon)

Neon project in AWS us-east-1, Free plan (Jimmy's choice on 2026-10-30, for cost: Render bills
a database every hour it exists). Both `DATABASE_URL`s are its **direct** connection string
(Connect modal, pooling off), `sslmode=require`. Free-plan limits, from
https://neon.com/pricing on 2026-10-30:

| Limit | Free plan |
|---|---|
| Storage | 1 GB per project; at the limit writes are blocked |
| Compute | 100 CU-hours per month per project; when used up, compute pauses until the next period |
| Scale to zero | always on, can't be turned off: compute suspends after 5 minutes idle and resumes on the next connection |
| History retention | 6 hours (point-in-time restore), capped at 1 GB |

What that means here:

- **Size is the tighter limit.** Staging held 256 MB on 2026-10-30 (`pi_messages` 234 MB). One
  full mouse-oa run (9 tasks) added about 95 MB, nearly all model history: about 7 more full runs
  reach 1 GB for rows written before images moved to R2 (#255; later runs store image references). Check it (`select pg_size_pretty(pg_database_size(current_database()))`) now and then; [TODO.md](TODO.md) tracks it.
- **Compute hours.** The runner polls `claim` every 2 s, so with it
  running the compute never reaches its 5 idle minutes. At 0.25 CU that is about 6 CU-hours a
  day, about 180 a month against the 100 allowed; the 5 days to Nov 4 cost about 30. With the
  runner suspended, Render's gateway health checks still query Postgres: `render.yaml` sets
  `healthCheckPath: /health`, and `apps/gateway/src/gateway.ts` calls `isMigrated` (a SQL query)
  on every probe. [Render probes running services every few seconds](https://render.com/docs/health-checks),
  preventing five idle minutes even with no browser open. The gateway also sweeps every five
  minutes (`SWEEP_MS` in `apps/gateway/src/main.ts`); live run and study pages poll through the
  API. Lengthening the sweep alone cannot enable scale to zero: the health checks must stop
  querying Postgres too, with the runner suspended and no other database traffic. Past the cap
  compute pauses and every call fails. Launch
  (pay as you go) is $0.106 per CU-hour and $0.35 per GB-month. After Nov 4 check Neon's
  console usage ([TODO.md](TODO.md)).
- **Scale to zero** costs the first query after a suspend a cold start. Checked 2026-10-30: with
  the compute suspended through Neon's API, the API's next sign-in and runs list answered in 1.2 s
  with no connection error (postgres.js replaces the connections Neon closed).
- **Backups** are the 6-hour history only. Take a `pg_dump` before anything risky.

**A dump or restore** connects from the operator's machine to the direct URL (Neon has no
allow list by default). **Restoring a dump into Neon:** the API's pre-deploy has already
migrated it, so a plain restore collides with the existing tables. Suspend the API, gateway and
runner first (`r -X POST "$B/services/<ID>/suspend"` for each, so nothing writes while the
tables are replaced), run `pg_restore --clean --if-exists --no-owner --no-acl -d "$NEON_DIRECT_URL" dump`, then resume the API and gateway
(`.../resume`; the runner stays suspended until a run). Compare row counts with the source
(`runs`, `run_events`, `provider_calls`) before trusting it. Never print the URL.

**Archiving a run** frees space on the 1 GB database without losing the run. `archive:run --id <runId> --remote`
(with `DATABASE_URL` set to the direct URL) refuses an example, an unfinished run, unsettled provider calls,
or missing inputs/study metadata and unsupported workflows that prevent restoration. It reads one database snapshot
(`run.json`: run, study, study scans and their inputs, events, pi messages, review snapshots, provider calls),
writes `~/.local/share/voluma-backups/runs/<runId>/` (0600; refuses under 1 GB free), syncs the file and directory entries
to disk, and reads it back. Only then does it delete, holding the queue, event and run-row locks. Every deleted row,
including the run and any deleted study/scans, must match the archive, not merely its count; any difference rolls back.
Inputs stay (shared); the study and its scans go only when no other run is in it. A failed write, sync or validation
never deletes rows; an existing `run.json` is never overwritten. A failure may leave an incomplete file: retain it for
inspection and use a new output directory when retrying.

`import:run --from <that directory>` restores the original study identity and scan metadata, adding missing shared rows
and refusing conflicts rather than overwriting them. Legacy dumps without study metadata get a study of one, or keep
the replaced run's study only if its lab, workflow, example status and scan agree; input conflicts are refused too.
Every import creates a fresh local run generation and moves the dump's current screenshots to it. Older screenshot
generations stay historical. A save that validated before the import is refused instead of entering the restored run.

**Provider accounting must be final before archiving.** Only `settleCall` fills `duration_ms`, atomically with cost
and usage, and it never updates an already-settled row. Archive refuses `open` calls and any call with null duration,
including `cut` rows from shutdown or stale-call sweeping: those may still receive late settlement. A genuinely settled
`cut` with unknown cost is archivable; its cost stays null. A crashed call that never settles blocks archiving indefinitely.
Keep that run in the database (export is still available); do not fill a fake duration to bypass the guard. A separate
operator reconciliation policy is needed for abandoned calls ([TODO.md](TODO.md)). Use this archive only after gateways
have rolled onto the settle-once implementation.

The run's R2 files are neither copied nor touched: this is a database archive, not an independent backup of evidence.
Keep those R2 objects and the local archive; choose a persistent disk, not an ephemeral orb or `/tmp`, for an operational
archive. Filesystem sync does not protect against losing that disk. A `pg_dump` remains the backup for the whole database.

## Rotating secrets

Each takes minutes. After the Oct 2026 Railway incident, treat anything Railway held
before 2026-10-21 as exposed and rotate it; the Railway project was deleted on 2026-10-30, which
ended that exposure for what was only there.

| Secret | Lives in | Rotate |
|---|---|---|
| `VOLUMA_API_TOKEN` | `voluma-api` variables (the runner reads it from there) | New value (`openssl rand -hex 32`) on `voluma-api`; the restart applies it. Then the runner picks it up at the next Blueprint sync (`fromService`), or set it by hand and restart the runner. Old token stops working at once. A local runner updates its copy |
| `VOLUMA_DEBUG_TOKEN` | `voluma-api` variables; the agents that debug runs | Same as `VOLUMA_API_TOKEN`; only the agents' copies change |
| Postgres password | the Neon role; `DATABASE_URL` on `voluma-api` and `voluma-gateway` carries it | Neon console, project, branch, Roles, the role's menu, Reset password (it takes effect at once: the old password fails on the next connection). Copy the new connection string from Connect (direct, `sslmode=require`), set it on `voluma-api` and `voluma-gateway`, and restart both. Expect a short error window between the reset and the restart; check `/health` and one authenticated call |
| `RENDER_API_KEY` (`.env`) | the repo `.env` of whoever deploys | Dashboard, Account Settings, API Keys: create a new one, replace it in `.env`, delete the old |
| `WORKOS_COOKIE_PASSWORD` | `voluma-api` variables; `.env` | New value on `voluma-api`; restart. Every session cookie stops unsealing, so everyone signs in again. Rotate it whenever it may have leaked: it is the key to forging a session cookie, though a forged one still needs a token WorkOS signed |
| `WORKOS_API_KEY` | `voluma-api` variables; `.env` | Dashboard, API Keys: create a new key, replace it on `voluma-api` and restart, then delete the old one. It authorizes token refresh and session revocation |
| Test member's password (`WORKOS_TEST_PASSWORD`) | WorkOS user account; operators' secret stores and local environments used for probes | With the account owner's authorization, reset through AuthKit's password-recovery flow using the owner's mailbox, update the operators' secret copies, and revoke that user's existing WorkOS sessions. Verify a new sign-in without logging the password, cookies or tokens. This is separate from rotating `WORKOS_COOKIE_PASSWORD` or `WORKOS_API_KEY` |
| `WORKOS_CLIENT_ID`, `WORKOS_LAB_ORGANIZATION_ID`, `WORKOS_JUDGES_ORGANIZATION_ID`, `APP_URL` | `voluma-api` variables | Identifiers, not secrets; change only if the WorkOS environment or the domain changes |
| Model keys (`VOLUMA_OPENAI_API_KEY` and the others) | `.env` (runner) | Revoke and re-create in the provider console; replace in `.env`. Keep a spend cap on each |
| R2 keys, `CLOUDFLARE_API_TOKEN` | `.env` (runner) | Cloudflare dashboard: roll the token, replace in `.env`. Keep the R2 token limited to the `voluma-staging` bucket |
| Modal token | `.env` or `~/.modal.toml` | `modal token new`, revoke the old in the Modal dashboard |

For a reported test-password exposure ([#132](https://github.com/voluma-bio/voluma/issues/132)),
record the operator and time of the reset, session revocation and successful verification,
never the credential values. A working sign-in or a move to a new host does not establish
that the exposed password changed; leave that item open until the owner or an authorized
operator supplies that evidence.

The runner service holds the model key (`VOLUMA_META_API_KEY`), the Modal token and the R2 keys in
its own variables (names in [../../runner/.context/deploy.md](../../runner/.context/deploy.md)); rotate them there as well as in `.env`. The API has its own R2 key (run files and scan uploads) in its variables; rotate that separately. The API holds no model keys.

## Least privilege

- A Render API key reaches every workspace of the account, not one environment; keep it in `.env` only.
- Neon is reachable from the internet (TLS and the password only; no allow list on the free plan). Keep the direct URL in the two services' variables and the operator's shell, never in the repo or a log.
- The API holds no model keys. Its R2 key reads and writes objects in `voluma-staging` only; no R2 key ever reaches the browser, which gets presigned URLs for one object each.

## Checked on Render (2026-10-30, at cutover)

- `/health` 200 on the API and gateway; the copied database served the test account's runs and studies.
- Client IP: `true-client-ip` (above). Host routing: a request with the gateway's SNI and the API's `Host`
  reaches the API (#236); accepted while a guest runs only on their own key.
- A full mouse-oa run (OA7-1R, 778f0937) completed across two API redeploys with no run effect.
- Neon: the first query after a forced suspend answered in 1.2 s with no error.
