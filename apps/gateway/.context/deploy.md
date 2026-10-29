# Deploying the gateway (Railway staging)

## Temporary state (p536 staging plumbing probe)

`GATEWAY_META_BASE_URL` is being set to a temporary Modal stub tunnel; it was unset before the probe.
Unset it and terminate the stub sandbox in this session, even on failure.

## Staging plumbing probe (2026-10-29)

A stub-SAM run stopped before segmentation; `GATEWAY_META_BASE_URL` was unset again and the stub
sandbox terminated. Railway routed `/health` by HTTP `Host` in both directions: a request with
gateway TLS/SNI and API Host reached the API, and one with API TLS/SNI and gateway Host reached
the gateway. The maximum stream duration was not measured.

## Setup

Set up on staging (2026-10-29): service `@voluma/gateway`, id `9d59dc78-573e-4892-9a25-3c21ddb81912`,
domain `https://volumagateway-staging.up.railway.app`. Same project and environment as the API
([../../api/.context/deploy.md](../../api/.context/deploy.md) has the project and the `gql` helper).
Created with `serviceCreate`, settings through `environmentPatchCommit`, the domain with
`serviceDomainCreate`, then `serviceInstanceDeployV2`. The table is what is set.

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

Keys live in this service's env only. The runner has `VOLUMA_GATEWAY_URL` (the domain above) and
the same `GATEWAY_TOKEN_SECRET`.

Checked on staging: `/health` 200; a POST on a route with no or a bad token 401; a path outside
the routes 403; boot log `up on :8080; keys for meta` (so the API's migrations 0005 and 0006 had run).

Things only staging can show (design §5): whether Railway's edge routes by `Host`, its maximum
request duration on a long stream, and the real size of Meta's `response.completed` line.
