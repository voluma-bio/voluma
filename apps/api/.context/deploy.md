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

**Settings live on the service, not in the repo.** `railway.json` is deprecated in Railway
(new services can't opt in; existing files stop being read on 2026-12-01), so the
settings below were set through the API and are the record. Moving them to
`.railway/railway.ts` is in [TODO.md](TODO.md).

| Setting | Value |
|---|---|
| Build | Railpack. Install is Railpack's; build command `pnpm --filter @voluma/web build`. Railpack prunes dev dependencies afterwards, so anything the server runs must be in `dependencies` (tsx, drizzle-orm) |
| Pre-deploy | `pnpm --filter @voluma/api db:migrate` (`src/migrate.ts`). The only place migrations run in production; a failure stops the deploy and prints the error |
| Start | `cd apps/api && exec node --import tsx src/index.ts`. `exec` makes node the container's process, so it gets SIGTERM; run from `apps/api` because that is where tsx resolves. Never `pnpm start` |
| Healthcheck | `/health` (liveness only; the deploy gate, not monitoring) |
| Draining | 30 s, above the API's `DRAIN_MS` (10 s) in `src/index.ts` |
| Restart | on failure, 10 retries |
| App Sleeping | off |
| Watch paths | `/apps/api/**`, `/apps/web/**`, `/packages/**`, `/pnpm-lock.yaml` |

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
(SIGKILL after the 30 s drain). No Railway dashboard access is needed; only Jimmy has a
seat (Hobby plan, one member).

To point the runner at it, export `VOLUMA_API_URL` and `VOLUMA_API_TOKEN` in the shell
for that command. Don't write the staging token into `.env`.

## Rotating secrets

Each takes minutes. After the Oct 2026 Railway incident, treat anything Railway held
before 2026-10-21 as exposed and rotate it.

| Secret | Lives in | Rotate |
|---|---|---|
| `VOLUMA_API_TOKEN` | Railway `@voluma/api` variables; whoever runs the runner | New value (`openssl rand -hex 32`) in Railway variables; the redeploy applies it. Give the new value to the runner's shell. Old token stops working at once |
| Postgres password | Railway `Postgres` variables (`POSTGRES_PASSWORD`, `PGPASSWORD`); `DATABASE_URL` follows by reference | `ALTER USER postgres PASSWORD '<new>'` over the private network, then set both variables to it and redeploy the API. Changing only the variables doesn't change a running database's password |
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
