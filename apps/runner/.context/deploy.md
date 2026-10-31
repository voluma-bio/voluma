# Deploying the runner (Render staging)

The runner is a background worker: it claims queued runs from the API over Render's private
network and runs them (sandboxes on Modal, files in R2). It serves nothing. The workspace, the
ids, the API helper `r()` and the settings that apply to every service are in
[../../api/.context/deploy.md](../../api/.context/deploy.md); `render.yaml` is the record of this
service's settings. This file holds only what differs.

## Suspending the runner between runs (from 2026-11-04)

Render bills a running worker per second (about $0.035/hour at `1c-2g`). **Until Nov 4 the
runner stays on**: hackathon visitors start runs while nobody watches, and a suspended runner
would leave them queued. After Nov 4 it is **suspended unless a run is queued or running**. The
Blueprint has no field to create a service suspended, so suspend it by hand. With `r` and `$B`
from the API's deploy.md and `srv-dbideabl550s73bu5120` from its table (both paths are in Render's API
reference):

```bash
r -X POST "$B/services/srv-dbideabl550s73bu5120/resume"    # before starting a run
r -X POST "$B/services/srv-dbideabl550s73bu5120/suspend"   # when no run is queued or running
```

A run started while the runner is suspended is created `queued` and stays that way: nothing
claims it until the next resume, after which the runner claims it within its 2 s poll. Resume
takes the time of a start (the service boots), so resume first and check the log. Suspend only
after the last run reports `released` or ends: suspending mid-run sends SIGTERM, and the run
waits for the lease to lapse before the next claim resumes it. Automating this is later work.

The same suspend keeps it from claiming a plumbing run you start yourself with `dev-sandbox`.
A commit to `main` that touches the runner's build filter (including this file) redeploys it,
and a deploy of a suspended service is not started until it is resumed (not yet checked on
Render), so check the deploys list after a resume. The 2026-10-29 plumbing runs on Railway are
in [../../gateway/.context/deploy.md](../../gateway/.context/deploy.md).

## How it is set up

Service `voluma-runner` (`srv-dbideabl550s73bu5120`), same workspace and region as the API. Settings (the
yaml has them):

| Setting | Value |
|---|---|
| Source | GitHub repo `voluma-bio/voluma`, branch `main`, root `/` |
| Deploy trigger | `autoDeployTrigger: checksPass`: Render waits for the GitHub check suites before deploying |
| Build | `pnpm install --frozen-lockfile`. No build step; `tsx` is a runtime dependency |
| Start | `cd apps/runner && exec node --import tsx src/main.ts`. `exec` makes node the process, so it gets SIGTERM |
| Shutdown delay | 60 s: above the runner's `SHUTDOWN_BUDGET_MS` (30 s), which is how long it waits for runs to report `released` |
| Restart | Render restarts a worker that exits; the loop exits non-zero on a dead claim loop so it sees it |
| Plan | `1c-2g` (1 CPU, 2 GB). The runner is one Node thread and holds no volumes: `segment_sam` and the other data work run in the sandbox, so heavy work creeping back into it hits the limit and fails loudly instead of slowing heartbeats quietly |
| Health check | none: a background worker has no port |
| Instances | one. More share the queue (claims are leased through the API): raise `numInstances`; each holds its own `RUNNER_CONCURRENCY` slots |
| Build filter | `apps/runner`, `packages/harness`, `packages/workflow`, `packages/contracts`, `packages/provider-calls` (the runner imports it), `packages/voluma-sam` (the harness imports its input schema), `workflows` (the runner reads `workflows/` from its own checkout, so editing a workflow must redeploy it), and the root build files |
| Commit | `RENDER_GIT_COMMIT`, which Render sets; a run records it as the source of its workflow files |

Variables (names only; values never go in the repo):

| Variable | Source |
|---|---|
| `VOLUMA_API_URL` | `fromService` `voluma-api`, `property: hostport` (`host:port` on the private network, no scheme; `apiEndpoint()` in `config.ts` adds `http://`). Not the public URL: Render's web application firewall sits in front of `voluma-api.onrender.com` and answered a runner history write with a 403 "Blocked" page, which failed that agent's thread (2026-10-31). The cost of the private network: when an API deploy ends, requests fail for 30+ s while the hostname moves to the new instance. Runs held then self-stop and resume, and self-stops never count toward the no-progress limit |
| `VOLUMA_API_TOKEN` | `fromService` `voluma-api`'s variable: rotating it on the API reaches the runner at the next Blueprint sync |
| `VOLUMA_META_API_KEY`, `RUNNER_CONCURRENCY` | the model key; 2 slots. No `RUNNER_MODEL` or `RUNNER_THINKING`: each role takes its role file's alias (`wonder` = `meta/muse-wonder-1.0`, Standard mode) and thinking level (Jimmy, 31 Oct; a visitor run's main is on wonder too, its other roles on `RUNNER_VISITOR_MODEL`; until then staging forced every role onto `meta/muse-spark-1.3-contributor` at `medium`). A Blueprint sync never deletes a variable that is no longer in `render.yaml` (Render keeps existing env vars), so removing one from the yaml also needs it deleted on the `voluma-runner` service in the dashboard or API; check the service's variables after a change. Change the model when no member run is live: a resumed thread keeps its recorded model only while some role still uses it, so a run live at the change, or a run reopened later, restarts main without its earlier conversation. Contributor models let Meta train on what they are sent: never set one on a stack that carries uncleared scans |
| `GATEWAY_TOKEN_SECRET` | `fromService` `voluma-gateway`: its secret |
| `VOLUMA_GATEWAY_URL` | literal `https://voluma-gateway.onrender.com` (public https, no port: the sandbox allowlist is built from it). Must match the gateway's real subdomain, which Render can suffix: check at cutover |
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | the Modal profile in `~/.modal.toml` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_TOKEN` | as in `.env`; `R2_BUCKET` comes from the env group `voluma-shared` |
| `VOLUMA_<PROVIDER>_API_KEY` for any other provider | not in the yaml: add in the dashboard only when a role file or `RUNNER_MODEL_*` names that provider |

With `RUNNER_THINKING` unset, a role without a `thinking` key in its role file requests no effort.
Set it to one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; the runner refuses a
non-off level a model alias lacks (a role file's own `thinking` is checked when a run starts),
and the boot line prints it. `off` means no requested effort, not guaranteed disabled reasoning:
Muse uses its default; DeepSeek runs with thinking off. A role's explicit `thinking: off` overrides
global `high`. With `RUNNER_MODEL` set (every role forced onto one model), the role files' levels
are ignored and `RUNNER_THINKING` alone applies.

Agents never start a run on staging, and never test on wonder (Jimmy). An agent's test run is a local runner with `RUNNER_MODEL=deepseek/deepseek-v4-pro` (`deepseek/deepseek-flash` is too slow for a full run) or `meta/muse-spark-1.3-contributor`.

There is no fallback model. Pi is the only retry layer: it retries a 5xx, a 409, a network error or a 60 s wait for headers, up to 10 times. A worker or check whose call still fails ends `failed`, and main decides what to do. Main's own failure fails the run, except a reply cut off after its headers, which gets one resume of main (see `CONTEXT.md`). Visitor runs use `RUNNER_VISITOR_MODEL` (default `meta/muse-spark-1.3`) with the visitor's key for every role except main, which keeps its role file's model when that is a Standard-mode Meta model (with no `RUNNER_MODEL`, wonder), so a visitor's key without wonder access fails the run at its first call.

## The sandbox image

`sandbox/Dockerfile` is the one definition of the image: Python and its packages, `ffmpeg`, Node 24
and `voluma-sam` (the bundle of `packages/voluma-sam`, which the workflow builds first and passes as the
build context `sam`). The "Sandbox image" workflow
(`.github/workflows/sandbox-image.yml`) builds it for linux/amd64 on a change to the Dockerfile,
`packages/voluma-sam` or by hand, pushes `ghcr.io/voluma-bio/voluma-sandbox:<commit>` and prints the digest. Put
that digest in `SANDBOX_IMAGE` (`src/config.ts`). Every run of the workflow gives a new digest, even for the same contents (image timestamps), and it also runs when the workflow file or `requirements.txt` changes, so bump `SANDBOX_IMAGE` only when the contents changed. A run keeps the image of its first claim (`sandboxImage` on its first `thread.started`): a bump reaches runs that start after the deploy, not the ones in flight. If a run's recorded digest becomes unpullable (package deleted or made private), no runner bump reaches that run: start a new run instead. The package
must be **public**, or Modal cannot pull it: GitHub, the org's Packages,
`voluma-sandbox`, Package settings, Danger Zone, Change visibility.

## Checked on staging (2026-10-28, on Railway)

- **Sandbox start from GHCR, our workspace, create to first exec done:** 23.6 s the first time (Modal pulls and caches the image), 1.5 s warm (create call 0.17 s). A different workspace pulls its own copy on its first run.
- **A guest run** on the reference scan (`two-task-test`): claimed by the deployed runner within seconds, sandbox from the GHCR image, tool calls and results streamed over SSE.
- **A redeploy mid-run:** Railway sent SIGTERM; the old runner logged `releasing 1 run(s)`, ended its threads `cancelled` and reported `released` (15:06:44). The new instance claimed the run a second later, replayed the stored history, told the worker "You stopped, but segment-tibia is not finished", recreated the sandbox and ran the interrupted command again. One caveat: the old runner logged `sandbox did not close in time; terminating this claim's sandboxes` 15 s after the report; the sandbox was gone afterwards (`--dry-run` showed 0 for our runs).
- **Model errors, not infrastructure:** from about 15:07 Meta answered `404 model_not_found` for `muse-spark-1.3` on a share of calls that carry tools (2 of 10 in a local loop with the same key; a plain call never failed). With no retry the worker thread failed, the run left the task `to-check`, and the run `ended completed` with nothing folded. The call retry of the time (`model-retry.ts`, since deleted) then retried it; since the fail-fast decision a 404 fails the run at once (see [CONTEXT.md](CONTEXT.md)); not re-run on staging, because the Demo allowance was used up that day.
- **Cost is recorded, just not shown.** Pi's price table has `muse-spark-1.3` (input $1.25, output $4.25 per million tokens) and a reply's `usage.cost.total` is non-zero; the heartbeat carries it and the API adds it to `runs.model_cost_usd`. Nothing in the API's run response or the runner's log showed it; the runner now logs `model cost this claim` when it reports.
- **`sandbox did not close in time` after a release** is expected, not a bug: after a stop the close budget is 15 s, and Modal's terminate takes 20-30 s while a command runs (CONTEXT.md, item 1), so the runner terminates the claim's sandboxes by tag instead.
- **The image with pyvista (microct requirements):** in a real sandbox from the pinned digest, `pyvista` renders a PNG offscreen (31 KB) and numpy, scipy, skimage, SimpleITK, nibabel, pydicom and matplotlib import; first start 29 s.
- **Cleanup:** `sandboxes:clean --run <id>` for each of the 7 runs, then `--dry-run`: 0 of ours live (another agent's `probe6` sandbox was up).
