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
| `PORT` | set by Railway |

The root `prepare` script skips `lefthook install` outside a git checkout, as in Railway's build.

Staging URL: `https://volumaapi-staging.up.railway.app`.

## Deploying

Merge to `main`: Railway builds, runs the migration, starts the new deployment alongside
the old one, moves traffic once `/health` answers, then sends the old one SIGTERM
(SIGKILL after the 30 s drain).

**The migration runs while the previous code still serves**, and stays applied if the new
deployment then fails its healthcheck. So every migration must work with the code that is
deployed now: expand first, contract in a later PR. The rule is in
[../AGENTS.md](../AGENTS.md).

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

The runner needs the staging `VOLUMA_API_TOKEN`: read it with the variables query above.
Put it, with `VOLUMA_API_URL=https://volumaapi-staging.up.railway.app`, in a temp copy of
`.env` and run the one command with `VOLUMA_ENV_FILE=<temp file>` (the runner reads its
settings only from that file, not from the shell). Delete the file after; the staging token
never goes into `.env`.

## Rotating secrets

Each takes minutes. After the Oct 2026 Railway incident, treat anything Railway held
before 2026-10-21 as exposed and rotate it.

| Secret | Lives in | Rotate |
|---|---|---|
| `VOLUMA_API_TOKEN` | Railway `@voluma/api` variables; whoever runs the runner | New value (`openssl rand -hex 32`) in Railway variables; the redeploy applies it. Old token stops working at once. Whoever runs the runner puts the new value in their temp `VOLUMA_ENV_FILE` ([Operating staging](#operating-staging)) |
| Postgres password | Railway `Postgres` variables (`POSTGRES_PASSWORD`; `PGPASSWORD`, `DATABASE_URL` reference it) | Railway's procedure: Database tab, Config, **Regenerate** (needs Jimmy's dashboard seat), then redeploy `@voluma/api`, then check `/health` and one authenticated call. Never edit the password variables or run `ALTER USER` by hand: each changes one side and leaves the variable and the database out of sync. The GraphQL schema has a `databasePasswordReset` mutation (input: `databaseType`, `environmentId`, `serviceId`); whether the project token may call it is untested. Try it only as a deliberate rotation. For a planned rotation with no suspected leak, Railway's [zero-downtime guide](https://docs.railway.com/guides/rotate-credentials-zero-downtime) uses a second role |
| `RAILWAY_TOKEN` (project token, `.env`) | the repo `.env` of whoever deploys | Dashboard, project settings, Tokens: create a new one, replace it in `.env`, delete the old |
| Model keys (`VOLUMA_OPENAI_API_KEY` and the others) | `.env` (runner) | Revoke and re-create in the provider console; replace in `.env`. Keep a spend cap on each |
| R2 keys, `CLOUDFLARE_API_TOKEN` | `.env` (runner) | Cloudflare dashboard: roll the token, replace in `.env`. Keep the R2 token limited to the `voluma-staging` bucket |
| Modal token | `.env` or `~/.modal.toml` | `modal token new`, revoke the old in the Modal dashboard |

Nothing but the API token and the database URL is in Railway today. The runner's
keys enter Railway only when the runner is deployed; then add them to its variables and
this table.

## Least privilege

- The project token is scoped to one environment: it can edit variables, service settings
  and deployments there, nothing else in the account.
- Postgres has no public domain or TCP proxy; only services in the project reach it. Don't
  create a proxy except for the drill in [TODO.md](TODO.md), and remove it after.
- The API holds no model or storage keys.
