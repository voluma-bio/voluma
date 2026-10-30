# Deploying the gateway (Render staging)

The gateway is a web service on a public https URL (port 443, no port in `VOLUMA_GATEWAY_URL`:
the sandbox allowlist is computed from it). `render.yaml` is the record of its settings; the
workspace, ids and the `r()` helper are in
[../../api/.context/deploy.md](../../api/.context/deploy.md). The measurements below were taken on
Railway (to 2026-10-30); **none has been repeated on Render**, so the limits of Render's proxy are
open: its docs state only a 100-minute cap on one HTTP response. Re-measure at cutover with the
same worker-sandbox probes before trusting `MAX_CALL_MS` (30 min) and `KEEPALIVE_MS` (60 s).

## Staging plumbing run 3 (2026-10-29, p540, on Railway)

`dev-sandbox --run <id> --allow-remote` on a staging run, a worker sandbox, the real gateway, and
`GATEWAY_META_BASE_URL` pointing at a stub Meta in a Modal tunnel (unset again afterwards; the
variable delete alone did not redeploy on Railway; on Render check the deploys list and restart). No model was
called, and the masks are not results.

- **`segment_sam` through the gateway:** auto crop (492 frames) and `subVolume` (151 frames) both
  returned, each `requestId` equal to its sidecar's. The run read showed `providerCalls`: 6 calls
  (upload, response, delete, twice), $0.1286 for `dev.worker`, equal to the run read's `providerCalls`
  (643 frames at $0.0002). The gateway log has one line per call (`ok`, `ttfb`, duration).
- **A stream had two Railway limits (measured from the worker sandbox):**

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

## Staging plumbing probe (2026-10-29, on Railway)

A stub-SAM run stopped before segmentation; `GATEWAY_META_BASE_URL` was unset again and the stub
sandbox terminated. Railway routed `/health` by HTTP `Host` in both directions: a request with
gateway TLS/SNI and API Host reached the API, and one with API TLS/SNI and gateway Host reached
the gateway. The maximum stream duration was measured later (run 3, above).

## Setup

Service `voluma-gateway` (`<GATEWAY_ID>`), domain `https://voluma-gateway.onrender.com` (the
runner reads it as `RENDER_EXTERNAL_URL`). Settings, all in `render.yaml`:

| Setting | Value |
|---|---|
| Service | web service, GitHub repo `voluma-bio/voluma`, branch `main`, root `/` |
| Build | `pnpm install --frozen-lockfile`; no build step; `tsx` is a runtime dependency |
| Pre-deploy | none. The API's pre-deploy runs the migration; on a new database the gateway starts first, logs `waiting for the migration` with a backoff, and `/health` answers 503 until `provider_calls` exists |
| Start | `cd apps/gateway && exec node --import tsx src/main.ts` (`exec`: node gets SIGTERM) |
| Health check | `/health` (200 once `provider_calls` exists; 503 while it doesn't or while draining) |
| Shutdown delay | 90 s: above `GATEWAY_DRAIN_SECONDS` (60) plus the cleanup after it; calls still running when the drain ends are cut (cost unknown) |
| Instances | one |
| Build filter | `apps/gateway`, `packages/provider-calls`, and the root build files |
| Domain | public (sandboxes reach it from Modal); the Modal allowlist is derived from `VOLUMA_GATEWAY_URL` at run start, so a new URL needs no list edit |

Variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's direct connection string, `sslmode=require`, the same value as on `voluma-api` (`sync: false`) |
| `GATEWAY_TOKEN_SECRET` | `<kid>:<base64 of 32 random bytes>`, e.g. `k1:$(openssl rand -base64 32)`. Comma-separate to rotate: the first mints, all open. The runner reads it from here (`fromService`), so a rotated value reaches it at the next Blueprint sync |
| `GATEWAY_META_API_KEY` | our Meta key (SAM) |
| `GATEWAY_ANTHROPIC_API_KEY`, `GATEWAY_OPENAI_API_KEY` | not in the yaml: those providers are disabled in code |
| `PORT` | not set: Render's injected 10000 (the code's default is 8080) |
| `GATEWAY_DRAIN_SECONDS` | `60` (the code's default), written in the yaml next to the shutdown delay |
| `GATEWAY_<PROVIDER>_BASE_URL` | not in the yaml; only for pointing at a stub |
| `RENDER_INSTANCE_ID` | Render's; names the instance in `provider_calls.instance` |

Keys live in this service's env only. The runner has `VOLUMA_GATEWAY_URL` and the same
`GATEWAY_TOKEN_SECRET`.

Checks at cutover: `/health` 200; a POST on a route with no or a bad token 401; a path outside
the routes 403; boot log `up on :10000; keys for meta`, then `boot sweep done` (the API's migration had run).

Things only the deployed Render service can show: whether its proxy routes by `Host` (the
Railway result is above: a sandbox reached the API with the gateway's SNI and the API's `Host`;
guest sign-in stays closed until this is known), its maximum request duration on a long stream,
how long a response may stay silent, and the real size of Meta's `response.completed` line.
