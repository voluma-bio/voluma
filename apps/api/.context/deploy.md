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
| `@voluma/runner` | Created by the repo import, left undeployed until the runner is long-running |

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
| Watch paths | `/apps/api/**`, `/apps/web/**`, `/packages/**`, `/pnpm-lock.yaml`, `/package.json`, `/.tool-versions`, `/tsconfig.base.json`, `/pnpm-workspace.yaml` (root files that change the build or Node) |

Variables on `@voluma/api`:

| Variable | Value |
|---|---|
| `DATABASE_URL` | reference `${{Postgres.DATABASE_URL}}` (the private URL) |
| `VOLUMA_API_TOKEN` | random 32 bytes, hex |
| `APP_URL` | the origin browsers use, no trailing slash: the Railway domain today (`https://volumaapi-staging.up.railway.app`), `https://app.voluma.bio` after the DNS records. Must be https (the session cookie is then `Secure` and named `__Host-wos-session`). Builds the sign-in redirect and the `Origin` check |
| `WORKOS_CLIENT_ID`, `WORKOS_API_KEY` | WorkOS dashboard, API Keys (staging environment) |
| `WORKOS_COOKIE_PASSWORD` | `openssl rand -base64 32`; seals the session cookie |
| `WORKOS_LAB_ORGANIZATION_ID` | the Yao Lab organization's id (`org_...`); its members get scope `lab` |
| `GUEST_ORGANIZATION_ID`, `GUEST_SCOPE` | optional: let anyone in as a guest of this organization (`lab` or `self`, default `lab`). Staging runs open: the Demo organization (`WORKOS_DEMO_ORGANIZATION_ID`'s value) with `GUEST_SCOPE=self`; never the Yao Lab, whose data is for signed-in members only (startup throws if the guest organization is one members sign in to). Unset means the sign-in wall |
| `WORKOS_JUDGES_ORGANIZATION_ID` | optional: the Judges organization's id; its members get scope `self`. Unset means no Judges sign-in |
| `RUN_LIMITS_<ORG>_<LIMIT>` | what an organization may run, `<ORG>` one of `LAB`, `JUDGES`, `DEMO` (the guest organization) and `<LIMIT>` one of `PER_CALLER`, `CONCURRENT`, `PER_DAY`, `USD_PER_DAY`, `VISITOR_ACTIVE` (visitor runs queued or running, per org: a start or `/keys` past it is a 429; `awaiting-keys` runs don't count). Unset is no limit, so set them: Yao Lab `CONCURRENT=4`; Judges `CONCURRENT=2`, `PER_DAY=50`; Demo `PER_CALLER=1`, `CONCURRENT=2`, `PER_DAY=10`, `VISITOR_ACTIVE=4` while staging is open to guests (then `CONCURRENT=1`, `PER_DAY=2` for the hackathon). Read at start: a change is a restart, not a deploy of code |
| `PORT` | set by Railway |

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

- **One API replica.** The visitor-key vault and (soon) the live hub are in this process's memory, which is correct only while there is one replica. Do not scale the API out.
- **A deploy or restart** empties the vault. Every claim moves the queued `visitor` runs whose keys its process doesn't hold to `awaiting-keys` (so a run started on the old process during a deploy overlap is held too), and the browser resends the keys (`/keys`). Running `voluma` runs are unaffected; their leases are in Postgres.
- **An API outage of more than 45 s** (the runner's self-stop margin, `LEASE_SECONDS - HEARTBEAT_SECONDS`) stops every running run: the runner can't heartbeat. A `released` run is recovered at once when the API returns; a run whose lease the database expired counts one of its three recoveries. A `visitor` run goes to `awaiting-keys` either way, because its keys are gone.
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
| Postgres password | Railway `Postgres` variables (`POSTGRES_PASSWORD`; `PGPASSWORD`, `DATABASE_URL` reference it) | Railway's procedure: Database tab, Config, **Regenerate** (needs Jimmy's dashboard seat), then redeploy `@voluma/api`, then check `/health` and one authenticated call. Never edit the password variables or run `ALTER USER` by hand: each changes one side and leaves the variable and the database out of sync. The GraphQL schema has a `databasePasswordReset` mutation (input: `databaseType`, `environmentId`, `serviceId`); whether the project token may call it is untested. Try it only as a deliberate rotation. For a planned rotation with no suspected leak, Railway's [zero-downtime guide](https://docs.railway.com/guides/rotate-credentials-zero-downtime) uses a second role |
| `RAILWAY_TOKEN` (project token, `.env`) | the repo `.env` of whoever deploys | Dashboard, project settings, Tokens: create a new one, replace it in `.env`, delete the old |
| `WORKOS_COOKIE_PASSWORD` | Railway `@voluma/api` variables; `.env` | New value in Railway; the redeploy applies it. Every session cookie stops unsealing, so everyone signs in again. Rotate it whenever it may have leaked: it is the key to forging a session cookie, though a forged one still needs a token WorkOS signed |
| `WORKOS_API_KEY` | Railway `@voluma/api` variables; `.env` | Dashboard, API Keys: create a new key, replace it in Railway and redeploy, then delete the old one. It authorizes token refresh and session revocation |
| `WORKOS_CLIENT_ID`, `WORKOS_LAB_ORGANIZATION_ID`, `WORKOS_JUDGES_ORGANIZATION_ID`, `APP_URL` | Railway `@voluma/api` variables | Identifiers, not secrets; change only if the WorkOS environment or the domain changes |
| Model keys (`VOLUMA_OPENAI_API_KEY` and the others) | `.env` (runner) | Revoke and re-create in the provider console; replace in `.env`. Keep a spend cap on each |
| R2 keys, `CLOUDFLARE_API_TOKEN` | `.env` (runner) | Cloudflare dashboard: roll the token, replace in `.env`. Keep the R2 token limited to the `voluma-staging` bucket |
| Modal token | `.env` or `~/.modal.toml` | `modal token new`, revoke the old in the Modal dashboard |

Nothing but the API token, the database URL and the sign-in values is in Railway today. The runner's
keys enter Railway only when the runner is deployed; then add them to its variables and
this table.

## Least privilege

- The project token is scoped to one environment: it can edit variables, service settings
  and deployments there, nothing else in the account.
- Postgres has no public domain or TCP proxy; only services in the project reach it. Don't
  create a proxy except for the drill in [TODO.md](TODO.md), and remove it after.
- The API holds no model or storage keys.
