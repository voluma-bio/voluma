# Deploying the gateway (Railway staging)

## Staging plumbing run 3 (2026-10-29, p540)

`dev-sandbox --run <id> --allow-remote` on a staging run, a worker sandbox, the real gateway, and
`GATEWAY_META_BASE_URL` pointing at a stub Meta in a Modal tunnel (unset again afterwards; the
variable delete alone does not redeploy, so run `serviceInstanceRedeploy` after it). No model was
called, and the masks are not results.

- **`segment_sam` through the gateway:** auto crop (492 frames) and `subVolume` (151 frames) both
  returned, each `requestId` equal to its sidecar's. The run read showed `providerCalls`: 6 calls
  (upload, response, delete, twice), $0.1286 for `dev.worker`, equal to the heartbeat's `spentUsd`
  (643 frames at $0.0002). The gateway log has one line per call (`ok`, `ttfb`, duration).
- **A stream has two Railway limits (measured from the worker sandbox):**

  | Stream | Result |
  |---|---|
  | No bytes for 5 min (quiet, headers unsent) | cut at 300.0 s: the edge answers 502 `upstream error`, the gateway row ends `cut` after 300000 ms |
  | 280 s quiet | completed (`done`) |
  | First byte at 20 s, then quiet | cut at 320.2 s: the limit is 300 s without a response byte, not time to first byte |
  | A byte every 30 s | cut at 900.1 s (15 min); the row ends `cut`, 899978 ms |

  The same quiet stream straight to the stub's Modal tunnel (from outside) ran its 1680 s to a
  clean 200, so the cut is Railway's edge, not Modal or the stub. A call past 15 minutes cannot
  finish through Railway, whatever `MAX_CALL_MS` says; a call whose reply goes quiet for 5 minutes
  is cut too. A cut row was then charged its reservation ($3), and the run read's cost went from $0.13 to
  $15.14 with five cut calls.
- **Host from the sandbox:** the gateway domain with `Host:` set to the API reaches the API from a
  worker sandbox. `/health` answered the API's `ok`, and `POST /api/auth/guest` minted a guest
  and `GET /api/run/inputs` with that cookie answered 200. The gateway token is not an API
  credential (401 on the API's routes). Only SNI to the API's own name is refused (connection
  reset). Anything the API serves unauthenticated, a worker can call.
- **A worker sandbox shuts down 300 s after its last exec:** `idleSeconds` is 300, and a detached
  process does not count. A running exec does (a foreground `sleep 420` outlived it), so real
  `segment_sam` calls, which are execs, are safe.
- `curl` is not in the sandbox image; `node` is.

Everything was reverted: `GATEWAY_META_BASE_URL` unset and the gateway redeployed, the stub and all
run sandboxes terminated, the runs' R2 objects deleted.

## Staging plumbing probe (2026-10-29)

A stub-SAM run stopped before segmentation; `GATEWAY_META_BASE_URL` was unset again and the stub
sandbox terminated. Railway routed `/health` by HTTP `Host` in both directions: a request with
gateway TLS/SNI and API Host reached the API, and one with API TLS/SNI and gateway Host reached
the gateway. The maximum stream duration was measured later (run 3, above).

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
| Draining | 60 s, equal to `GATEWAY_DRAIN_SECONDS` (default 60); calls still running then are cut (cost unknown) |
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
