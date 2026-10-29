# Deploying the API (Railway staging)

The API is the one deployed service: it serves the built web app and `/api/*`. Postgres is
Railway's plain Postgres, reached only over the private network. Why Railway, and the
breach hygiene that goes with it: voluma-bio/docs `work/workos-auth/DIVERGENCE/2026-10-27-railway-backend.md`.

## How it is set up

Railway project `wonderful-abundance`, environment `staging`. Services:

| Service | State |
|---|---|
| `@voluma/api` | Deployed from the GitHub repo, branch `main`, root directory `/`. Railway domain, no custom domain yet (`app.voluma.bio` comes with the DNS records) |
| `Postgres` | Railway template, image `postgres-ssl`. No public domain, no TCP proxy |
| `@voluma/runner` | Deployed: claims runs over the private network. Settings, variables and the sandbox image: [../../runner/.context/deploy.md](../../runner/.context/deploy.md) |

**Settings live on the service, not in the repo.** Railway's config as code (a
`railway.json` file) is deprecated: new services can't opt in, and existing files stop being
read on 2026-12-01. So the settings below were set through the API and are the record.
Moving them to `.railway/railway.ts` is in [TODO.md](TODO.md).

| Setting | Value |
|---|---|
| Build | Railpack. Install is Railpack's; build command `pnpm --filter @voluma/web build`. Railpack prunes dev dependencies afterwards, so anything the server runs must be in `dependencies` (tsx, drizzle-orm) |
| Pre-deploy | `pnpm --filter @voluma/api db:migrate` (`src/migrate.ts`). The only place migrations run in production; a failure stops the deploy and prints the error |
| Start | `cd apps/api && exec node --import tsx src/index.ts`. `exec` makes node the container's process, so it gets SIGTERM; run from `apps/api` because that is where tsx resolves. Never `pnpm start` |
| Healthcheck | `/health` (liveness only; the deploy gate, not monitoring) |
| Draining | 30 s, above the API's `DRAIN_MS` (10 s) in `src/index.ts` |
| Restart | on failure, 10 retries |
| App Sleeping | off |
| Watch paths | `/apps/api/**`, `/apps/web/**`, `/packages/**`, `/pnpm-lock.yaml`, `/package.json`, `/.tool-versions`, `/tsconfig.base.json`, `/pnpm-workspace.yaml` (root files that change the build or Node). `/workflows/*/outputs.json` and `/workflows/*/tasks.json` (the web build bundles them: the start screen's outputs, the task titles). No other `/workflows/**`: the API never reads the workflow files; the runner snapshots them and records its own commit (`RAILWAY_GIT_COMMIT_SHA`) in each run. Set on the service |

Variables on `@voluma/api`:

| Variable | Value |
|---|---|
| `DATABASE_URL` | reference `${{Postgres.DATABASE_URL}}` (the private URL) |
| `VOLUMA_API_TOKEN` | random 32 bytes, hex |
| `VOLUMA_DEBUG_TOKEN` | optional; random 32 bytes, hex. Lets agents read every lab's runs (`GET /api/run/runs…`) and nothing else; unset turns it off |
| `APP_URL` | the origin browsers use, no trailing slash: the Railway domain today (`https://volumaapi-staging.up.railway.app`), `https://app.voluma.bio` after the DNS records. Must be https (the session cookie is then `Secure` and named `__Host-wos-session`). Builds the sign-in redirect and the `Origin` check |
| `WORKOS_CLIENT_ID`, `WORKOS_API_KEY` | WorkOS dashboard, API Keys (staging environment) |
| `WORKOS_COOKIE_PASSWORD` | `openssl rand -base64 32`; seals the session cookie |
| `WORKOS_LAB_ORGANIZATION_ID` | the Yao Lab organization's id (`org_...`); its members get scope `lab` |
| `GUEST_ORGANIZATION_ID`, `GUEST_SCOPE` | optional: let anyone in as a guest of this organization (`lab` or `self`, default `lab`). Staging runs open: the Demo organization (`WORKOS_DEMO_ORGANIZATION_ID`'s value) with `GUEST_SCOPE=self`; never the Yao Lab, whose data is for signed-in members only (startup throws if the guest organization is one members sign in to). Unset means the sign-in wall |
| `WORKOS_JUDGES_ORGANIZATION_ID` | optional: the Judges organization's id; its members get scope `self`. Unset means no Judges sign-in |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Optional as a group: enables Review's reference scan download, a run's files (`/api/review/runs/:runId/files/:sha256`, reads under `runs/<id>/evidence/`) and scan uploads. Use an Object Read & Write token scoped to `voluma-staging` (uploads presign PUTs to `uploads/` and move them to `inputs/`); only the server receives it. Missing or partial configuration leaves the API running and returns 503 for a reference scan download, a run file or an upload. `R2_BUCKET=voluma-staging`; object `reference/OA6-1RK/scan.zip` must be a plain ZIP with no `Content-Encoding` metadata. The descriptor's version pins the GET with `If-Match`; the API streams without buffering or redirecting to R2. The bucket's CORS allows `PUT` from any origin (rule `scan-upload-put`): the browser PUTs scan files straight to R2, and the presigned URL is the credential. A second rule, `review-asset-get`, allows `GET` from any origin: the review's asset route answers with a 302 to a presigned GET, and without the rule the browser blocks the redirected response (set on `voluma-staging` 2026-10-29; set it on any other bucket the API uses) |
| `UPLOAD_MAX_FILES`, `UPLOAD_MAX_BYTES`, `UPLOAD_MAX_OPEN` | optional: files and bytes per scan upload (default 5000 and 20 GB), and uncompleted uploads per member (default 3) |
| `RUN_LIMITS_<ORG>_<LIMIT>` | what an organization may run, `<ORG>` one of `LAB`, `JUDGES`, `DEMO` (the guest organization) and `<LIMIT>` one of `PER_CALLER`, `CONCURRENT`, `PER_DAY`, `USD_PER_DAY`, `VISITOR_ACTIVE` (visitor runs queued or running, per org: a start or `/keys` past it is a 429; `awaiting-keys` runs don't count). Unset is no limit, so set them: Yao Lab `CONCURRENT=4`; Judges `CONCURRENT=2`, `PER_DAY=50`; Demo `PER_CALLER=1`, `CONCURRENT=2`, `PER_DAY=10`, `VISITOR_ACTIVE=4` while staging is open to guests (then `CONCURRENT=1`, `PER_DAY=2` for the hackathon). Read at start: a change is a restart, not a deploy of code |
| `PORT` | `8080`, set explicitly: the runner's private URL (`http://volumaapi.railway.internal:8080`) needs a known port, and Railway's injected one is not readable. The public domain follows it |

The root `prepare` script skips `lefthook install` outside a git checkout, as in Railway's build.

Staging URL: `https://volumaapi-staging.up.railway.app`.

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

Merge to `main`: Railway builds, runs the migration, starts the new deployment alongside
the old one, moves traffic once `/health` answers, then sends the old one SIGTERM
(SIGKILL after the 30 s drain).

**The migration runs while the previous code still serves**, and stays applied if the new
deployment then fails its healthcheck. So every migration must work with the code that is
deployed now: expand first, contract in a later PR. The rule is in
[../AGENTS.md](../AGENTS.md).

## What a restart or outage does to runs

- **One API replica.** The visitor-key vault and the event stream's wake-ups (`notifier.ts`) are in this process's memory, which is correct only while there is one replica (the stream's 5 s poll would still catch events another replica appended). Do not scale the API out. Open event streams end at SIGTERM (`draining` in `src/index.ts`), so they don't hold the drain; `EventSource` reconnects with `Last-Event-ID`.
- **A deploy or restart** empties the vault. Every claim moves the queued `visitor` runs whose keys its process doesn't hold to `awaiting-keys` (so a run started on the old process during a deploy overlap is held too), and the browser resends the keys (`/keys`). Running `voluma` runs are unaffected; their leases are in Postgres.
- **An API outage of more than 45 s** (the runner's self-stop margin, `LEASE_SECONDS - HEARTBEAT_SECONDS`) stops every running run: the runner can't heartbeat. Both ways the claim ends are recovered, and the next claim resumes the cut-off threads. A `released` run (`shutdown`, `self-stop`) is recovered at once when the API returns; one whose lease the database expired is recovered at the next claim (`lease-expired`). Only `self-stop` and `lease-expired` can count toward the no-progress limit (see "A run that keeps cutting off its runner" below); a deploy (`shutdown`) never does. A `visitor` run goes to `awaiting-keys` either way, because its keys are gone.
- **A run that keeps cutting off its runner** ends `failed` after 3 claims in a row that end `self-stop` or `lease-expired` with no run-state progress (`claim-progress.ts`; progress is a `task`, `checkpoint`, `output`, `attempt.opened`, `assets.ready` or correcting `revision.started` event, or a `judgment`; model turns, tool calls and the first plan are not). The error names the call in flight: "Stopped: the server lost contact with the runner 3 times in a row without progress (last call: `segment_sam`)." The run row keeps `last_claim_end` (the next claim's `previousClaim`), `last_progress_seq` (moved by the event append), `claim_start_seq` (the log's last seq at the claim) and `stalled_claims`.
- **Guests share Demo's allowance.** The daily and dollar limits are per org, so a scripted guest (guests cost nothing to mint) can use up Demo's `PER_DAY` and `USD_PER_DAY` for every other guest. That is the design, not a bug: it bounds what open staging can spend. The same goes for `VISITOR_ACTIVE`: scripted guests can fill Demo's visitor cap and leave honest guests a 429 until those runs end. Both are accepted for open staging. `VISITOR_ACTIVE` bounds the keys the API holds and the runner slots Demo's visitors take; the claim's round-robin across orgs (the org claimed from least recently goes first) keeps them from starving Yao Lab's runs; the vault's 100-runs-per-org cap is a backstop for an org with no cap set.
- **A migration** takes no queue lock; the claim and the runs table follow the expand-first rule like any other.

## Operating staging

Everything below works with the project token (`RAILWAY_TOKEN` in `.env`). It is scoped to
the `staging` environment. Send it as a `Project-Access-Token` header (not `Authorization`)
to `https://backboard.railway.com/graphql/v2`. The `railway` CLI also reads
`RAILWAY_TOKEN`.

| Id | Value |
|---|---|
| Project | `68ca1d20-6640-44cf-bf0f-b955582b54d3` |
| Environment `staging` | `4593395e-9479-4375-a134-6151edba4037` |
| `@voluma/api` | `f43816d0-c3ca-4ecc-8beb-68fde1410720` |
| `Postgres` | `63ff9239-e839-4745-8ce7-3260c5dc482c` |

```bash
gql() { curl -s https://backboard.railway.com/graphql/v2 \
  -H "Project-Access-Token: $RAILWAY_TOKEN" -H 'Content-Type: application/json' -d "$1"; }
P=68ca1d20-6640-44cf-bf0f-b955582b54d3 E=4593395e-9479-4375-a134-6151edba4037 S=f43816d0-c3ca-4ecc-8beb-68fde1410720

# Latest deployments and their status (SUCCESS, FAILED, SKIPPED, ...); newest first
gql '{"query":"{ deployments(first:3, input:{projectId:\"'$P'\", environmentId:\"'$E'\", serviceId:\"'$S'\"}) { edges { node { id status createdAt } } } }"}'

# Logs of a deployment: runtime (deploymentLogs) or build (buildLogs; pre-deploy output is here)
gql '{"query":"{ deploymentLogs(deploymentId:\"<id>\", limit:100) { timestamp message } }"}'

# Read a variable (the whole set; every secret in it)
gql '{"query":"{ variables(projectId:\"'$P'\", environmentId:\"'$E'\", serviceId:\"'$S'\") }"}'

# Roll back: redeploy the image of a previous SUCCESS deployment
gql '{"query":"mutation { deploymentRollback(id:\"<id>\") }"}'
```

A rollback restores the old code, not the old schema: migrations have already run and
aren't reversed. It is safe only if the migrations since that deployment followed the
expand-then-contract rule. Otherwise fix forward.

The runner service (`pnpm --filter @voluma/runner start`) claims whatever is queued, so
pointing a local one at staging (`VOLUMA_API_URL`) takes a visitor's run and their keys. Run
it locally only against `pnpm dev`.

## Rotating secrets

Each takes minutes. After the Oct 2026 Railway incident, treat anything Railway held
before 2026-10-21 as exposed and rotate it.

| Secret | Lives in | Rotate |
|---|---|---|
| `VOLUMA_API_TOKEN` | Railway `@voluma/api` variables; whoever runs the runner | New value (`openssl rand -hex 32`) in Railway variables; the redeploy applies it. Old token stops working at once. Whoever runs the runner service updates its copy |
| `VOLUMA_DEBUG_TOKEN` | Railway `@voluma/api` variables; the agents that debug runs | Same as `VOLUMA_API_TOKEN`; only the agents' copies change |
| Postgres password | Railway `Postgres` variables (`POSTGRES_PASSWORD`; `PGPASSWORD`, `DATABASE_URL` reference it) | Railway's procedure: Database tab, Config, **Regenerate** (needs Jimmy's dashboard seat), then redeploy `@voluma/api`, then check `/health` and one authenticated call. Never edit the password variables or run `ALTER USER` by hand: each changes one side and leaves the variable and the database out of sync. The GraphQL schema has a `databasePasswordReset` mutation (input: `databaseType`, `environmentId`, `serviceId`); whether the project token may call it is untested. Try it only as a deliberate rotation. For a planned rotation with no suspected leak, Railway's [zero-downtime guide](https://docs.railway.com/guides/rotate-credentials-zero-downtime) uses a second role |
| `RAILWAY_TOKEN` (project token, `.env`) | the repo `.env` of whoever deploys | Dashboard, project settings, Tokens: create a new one, replace it in `.env`, delete the old |
| `WORKOS_COOKIE_PASSWORD` | Railway `@voluma/api` variables; `.env` | New value in Railway; the redeploy applies it. Every session cookie stops unsealing, so everyone signs in again. Rotate it whenever it may have leaked: it is the key to forging a session cookie, though a forged one still needs a token WorkOS signed |
| `WORKOS_API_KEY` | Railway `@voluma/api` variables; `.env` | Dashboard, API Keys: create a new key, replace it in Railway and redeploy, then delete the old one. It authorizes token refresh and session revocation |
| `WORKOS_CLIENT_ID`, `WORKOS_LAB_ORGANIZATION_ID`, `WORKOS_JUDGES_ORGANIZATION_ID`, `APP_URL` | Railway `@voluma/api` variables | Identifiers, not secrets; change only if the WorkOS environment or the domain changes |
| Model keys (`VOLUMA_OPENAI_API_KEY` and the others) | `.env` (runner) | Revoke and re-create in the provider console; replace in `.env`. Keep a spend cap on each |
| R2 keys, `CLOUDFLARE_API_TOKEN` | `.env` (runner) | Cloudflare dashboard: roll the token, replace in `.env`. Keep the R2 token limited to the `voluma-staging` bucket |
| Modal token | `.env` or `~/.modal.toml` | `modal token new`, revoke the old in the Modal dashboard |

The runner service holds the model key (`VOLUMA_META_API_KEY`), the Modal token and the R2 keys in
its own Railway variables (names in [../../runner/.context/deploy.md](../../runner/.context/deploy.md)); rotate them there as well as in `.env`. The API has its own R2 key (reference download, run files and scan uploads) in its variables; rotate that separately. The API holds no model keys.

## Least privilege

- The project token is scoped to one environment: it can edit variables, service settings
  and deployments there, nothing else in the account.
- Postgres has no public domain or TCP proxy; only services in the project reach it. Don't
  create a proxy except for the drill in [TODO.md](TODO.md), and remove it after.
- The API holds no model keys. Its R2 key reads and writes objects in `voluma-staging` only; no R2 key ever reaches the browser, which gets presigned URLs for one object each.

## Checked on staging (2026-10-28)

- `RUN_LIMITS_*` are set as in the table above and applied: a guest's second concurrent start answers 409 (`DEMO_PER_CALLER=1`).
- A Railway build can fail transiently (`frontend grpc server closed unexpectedly`); a redeploy fixes it, and the old deployment keeps serving meanwhile.
- A deploy with no healthcheck sits in DEPLOYING for about 2 minutes before SUCCESS; the previous deployment is removed after that.
