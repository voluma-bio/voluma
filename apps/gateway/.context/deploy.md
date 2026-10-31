# Deploying the gateway (Render staging)

The gateway is a web service on a public https URL (port 443, no port in `VOLUMA_GATEWAY_URL`).
Staging still uses a domain allowlist; the dedicated-IP cutover below is not deployed.
`render.yaml` is the record of its settings; the
workspace, ids and the `r()` helper are in
[../../api/.context/deploy.md](../../api/.context/deploy.md). The measurements below were taken on
Railway (to 2026-10-30); **the stream measurements have not been repeated on Render**, so the limits of Render's proxy are
open: its docs state only a 100-minute cap on one HTTP response. Re-measure at cutover with the
same worker-sandbox probes before trusting `MAX_CALL_MS` (30 min) and `KEEPALIVE_MS` (60 s).

## Dedicated-IP cutover (#236; awaiting approval)

**Render still permits the Host-header escape.** The issue's 30 Oct check and a read-only
recheck from an orb on 31 Oct agree: `GET /api/run/runs` at the gateway URL gives 403
`unknown route`; the same URL with `Host: voluma-api.onrender.com` gives the API's 401
`unauthorized`. The recheck made no guest, run, or provider call. The earlier worker-sandbox
probe is below; no new paid sandbox was started for this recheck.

[Modal matches TLS SNI, not HTTP Host](https://modal.com/docs/guide/sandbox-networking).
The gateway never sees requests the edge routes elsewhere, so a Host check in Node cannot
fix this. Own-key guest runs limit provider-key abuse, not scan exfiltration or API reachability.
A custom domain alone is not verified isolation. Pinning Render's shared ingress IP also
admits other tenants; [Render dedicated IPs are outbound only](https://render.com/docs/dedicated-ips).

Options reviewed against the current stack (Postgres is now Neon, not Railway):

| Option | Isolation and remaining check |
|---|---|
| Fly gateway with dedicated inbound IPv4 | Managed deployment; [shared IPv4 routes by domain, dedicated IPv4 is opt-in](https://fly.io/docs/networking/services/). The IP is [$2/month plus compute and traffic](https://fly.io/docs/about/pricing/). Release the shared address. Prove that foreign SNI/Host cannot reach another app through the dedicated IP before trusting it. [HTTP idle timeout is configurable](https://fly.io/docs/reference/configuration/#http_servicehttp_optionsidle_timeout), but the docs do not establish a 30-minute maximum or absence of a total cap: replay both stream probes. |
| Small VM with exclusive IPv4 and Caddy | Strongest straightforward isolation: only our gateway listens on the allowed address, with TLS terminated on the VM and no shared HTTP edge. More patching/operations. Obtain current VM/IP pricing before purchase. |
| Render shared edge, Cloudflare proxy/tunnel, or shared Fly IPv4 | Not suitable for the dedicated `/32` boundary. A new hostname does not make a shared endpoint exclusive. |

Prefer Fly for managed hosting **only if the dedicated-IP isolation and stream probes pass**;
use the VM if they fail. Do not add a second proxy, move the database, or change the gateway API
for this fix. Neon already exposes a TLS endpoint; giving the new host its database credential
and provider/token secrets is an explicit access decision.

The local code accepts `VOLUMA_GATEWAY_IPV4`, one bare IPv4 (no CIDR or list). With it, the
runner carries the address through `sandboxGateway` and `workerSandboxSpec` to Modal's
`outboundCidrAllowlist: ["<ip>/32"]`, **without a domain allowlist**: Modal combines those
lists as a union, not an intersection. Invalid addresses fail closed. Without the setting,
the current SNI policy is unchanged. The local launcher's quick tunnel ignores inherited IP
settings. Checkers, converters and workers without a gateway still use `blockNetwork`.

This closes the shared-edge path only with an exclusive endpoint. CIDR permits **any protocol
and port** to that IP, so expose only the gateway's TLS service to sandbox clients (restrict
administration separately). Modal still permits arbitrary DNS lookups with an allowlist;
this is **not a claim of complete exfiltration prevention**. A stronger boundary needs a
separately reviewed DNS policy or trusted proxy/sidecar, not this cutover.

Approval gates, in order; preserve Render until they pass:

1. Approve the host, paid instance/IP budget, credentials and any DNS/firewall/access changes.
   Provision alongside Render; do not replace or delete the staging service.
2. On the candidate, verify TLS and A-record resolution to the dedicated IPv4 (no dependency
   on an unallowed IPv6/shared address). From an approved temporary Modal worker with the
   `/32` policy, verify gateway health, invalid token 401, unknown route 403, direct API/other
   internet IP refusal, and gateway SNI plus API/foreign Host refusal. Test foreign SNI too.
   Check R2 mount reads/writes under this policy. Terminate only the probe's sandboxes.
3. Replay the quiet and keepalive stub streams for the gateway's 30-minute call window,
   checking first-byte, idle and total duration. Use an isolated stub configuration, not a
   change to staging's Meta base URL. Real SAM calls need their own approval.
4. Approve cutover: update the runner's gateway URL and IPv4 together, retaining its matching
   token secret; deploy/restart the runner when no old claim is live. Existing sandboxes keep
   their creation policy. Only after verification approve retiring the old gateway. Rollback
   restores the old URL and unsets the IPv4 together (and knowingly restores the escape).

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
  is cut too. At the time a cut row was charged its reservation ($3; reservations are gone now), and the run read's cost went from $0.13 to
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

Service `voluma-gateway` (`srv-dbidaf3l550s73btnpfg`), domain `https://voluma-gateway.onrender.com` (the
runner reads it as `RENDER_EXTERNAL_URL`). Settings, all in `render.yaml`:

| Setting | Value |
|---|---|
| Service | web service, GitHub repo `voluma-bio/voluma`, branch `main`, root `/` |
| Build | `pnpm install --frozen-lockfile`; no build step; `tsx` is a runtime dependency |
| Pre-deploy | none. The API's pre-deploy runs the migration; on a new database the gateway starts first, logs `waiting for the migration` with a backoff, and `/health` answers 503 until `provider_calls` exists |
| Start | `cd apps/gateway && exec node --import tsx src/main.ts` (`exec`: node gets SIGTERM) |
| Health check | `/health` (200 once `provider_calls` exists; 503 while it doesn't or while draining) |
| Shutdown delay | 300 s (Render's cap): above `GATEWAY_DRAIN_SECONDS` (240) plus the cleanup after it. The longest staging Meta request was 72 s (`POST /v1/responses`, 58 MB); the drain is over three times that. Calls still running when it ends are cut (cost unknown); `voluma-sam` retries a cut call once |
| Instances | one |
| Build filter | `apps/gateway`, `packages/provider-calls`, and the root build files |
| Domain | public (sandboxes reach it from Modal); staging derives its SNI allowlist from `VOLUMA_GATEWAY_URL`. A dedicated-IP cutover also sets `VOLUMA_GATEWAY_IPV4` on the runner |

Variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's direct connection string, `sslmode=require`, the same value as on `voluma-api` (`sync: false`) |
| `GATEWAY_TOKEN_SECRET` | `<kid>:<base64 of 32 random bytes>`, e.g. `k1:$(openssl rand -base64 32)`. Comma-separate to rotate: the first mints, all open. The runner reads it from here (`fromService`), so a rotated value reaches it at the next Blueprint sync |
| `GATEWAY_META_API_KEY` | our Meta key (SAM) |
| `GATEWAY_ANTHROPIC_API_KEY`, `GATEWAY_OPENAI_API_KEY` | not in the yaml: those providers are disabled in code |
| `PORT` | not set: Render's injected 10000 (the code's default is 8080) |
| `HOST` | not set (all interfaces); `pnpm dev` sets 127.0.0.1 |
| `GATEWAY_DRAIN_SECONDS` | `240` (the code's default), written in the yaml next to the shutdown delay |
| `GATEWAY_<PROVIDER>_BASE_URL` | not in the yaml; only for pointing at a stub |
| `RENDER_INSTANCE_ID` | Render's; names the instance in `provider_calls.instance` |

Keys live in this service's env only. The runner has `VOLUMA_GATEWAY_URL` and the same
`GATEWAY_TOKEN_SECRET`.

Checks at cutover: `/health` 200; a POST on a route with no or a bad token 401; a path outside
the routes 403; boot log `up on :10000; keys for meta`, then `boot sweep done` (the API's migration had run).

Render's proxy routes by `Host`, as Railway's did: a request with the gateway's SNI and the API's
`Host` reaches the API (checked 2026-10-30, #236); accepted while a guest runs only on their own key.
Still unmeasured on Render: its maximum request duration on a long stream,
how long a response may stay silent, and the real size of Meta's `response.completed` line.
