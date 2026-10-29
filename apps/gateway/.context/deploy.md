# Deploying the gateway (Railway staging)

Not created yet: this is what has to be set. Same project and environment as the API
([../../api/.context/deploy.md](../../api/.context/deploy.md) has the project and the `gql` helper).

| Setting | Value |
|---|---|
| Service | `@voluma/gateway`, GitHub repo `voluma-bio/voluma`, branch `main`, root `/` |
| Build | Railpack, build command `echo gateway has no build step`; `tsx` is a runtime dependency |
| Pre-deploy | none. The API's pre-deploy runs the migration; the gateway exits at boot until it has run, so deploy the API first |
| Start | `cd apps/gateway && exec node --import tsx src/main.ts` (`exec`: node gets SIGTERM) |
| Healthcheck | `/health` (200 after `select 1`; 503 while draining) |
| Draining | 60 s, equal to `GATEWAY_DRAIN_SECONDS` (default 60); calls still running then are cut and keep their reservation |
| Replicas | one; restart on failure, 10 retries; App Sleeping off |
| Watch paths | `/apps/gateway/**`, `/packages/provider-calls/**`, `/pnpm-lock.yaml`, `/package.json`, `/.tool-versions`, `/tsconfig.base.json`, `/pnpm-workspace.yaml` |
| Domain | public (sandboxes reach it from Modal); the Modal allowlist names this host |

Variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | reference `${{Postgres.DATABASE_URL}}` (private URL) |
| `GATEWAY_TOKEN_SECRET` | `<kid>:<base64 of 32 random bytes>`, e.g. `k1:$(openssl rand -base64 32)`. Comma-separate to rotate: the first mints, all open. The runner gets the same value |
| `GATEWAY_META_API_KEY` | our Meta key (SAM) |
| `GATEWAY_ANTHROPIC_API_KEY`, `GATEWAY_OPENAI_API_KEY` | leave unset for now: those providers are disabled in code |
| `PORT` | `8080`, set explicitly |
| `GATEWAY_DRAIN_SECONDS` | optional, default 60 |
| `GATEWAY_<PROVIDER>_BASE_URL` | optional; only for pointing at a stub |

Keys live in this service's env only. The runner needs `VOLUMA_GATEWAY_URL` and
`GATEWAY_TOKEN_SECRET` once it mints tokens (lane 2).

Things only staging can show (design §5): whether Railway's edge routes by `Host`, its maximum
request duration on a long stream, and the real size of Meta's `response.completed` line.
