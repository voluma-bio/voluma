# Deploying the runner (Railway staging)

The runner is the second deployed service: it claims queued runs from the API over
Railway's private network and runs them (sandboxes on Modal, files in R2). It serves
nothing. Project, environment and the `gql` helper are in
[../../api/.context/deploy.md](../../api/.context/deploy.md); this file holds only what differs.

## Staging plumbing run 3 (2026-10-29, p540)

The runner was stopped (`deploymentStop` on its active deployment, 22:37:46 to 22:57:43 UTC) so it did
not claim the test run, then restored with `deploymentRedeploy` once `dev-sandbox` held the run's
lease; the log showed `up:` and the replica count was 1 throughout. Railway refuses `numReplicas`
0 on both `serviceInstanceUpdate` and `environmentPatchCommit` (minimum 1). A commit to `main` that
touches `apps/runner/**` (including this file) redeploys the runner, so a docs commit during a pause
would restart it. Results of the run: [../../gateway/.context/deploy.md](../../gateway/.context/deploy.md).

## Staging plumbing probe (2026-10-29)

Runner deployment `4a38210`'s source pins the sandbox image `sha256:b3ea9afc…`; actual image use
was not independently confirmed. Its Railway manifest confirms 2 vCPU and 2,000,000,000 bytes
memory, and its `/packages/**` watch path covers
`voluma-sam`. `RAILPACK_DEPLOY_APT_PACKAGES` was removed. A stub-SAM and DeepSeek run
(`68eb632f-44ac-4a80-9fa3-8b16bc4e1f03`) was stopped after 17 minutes while still in scan intake;
segmentation and restart recovery were not checked. Its checker hit `staging /inputs failed with
exit code 123` twice before a retry succeeded. During this intake-only interval the largest logged
event-loop delay was 96 ms. The DeepSeek key and model overrides were removed or restored, and
all probe sandboxes were terminated. Stub masks are not results.

## How it is set up

Service `@voluma/runner` (id `ad12b6ff-b9c8-45cb-b9c1-af444e398749`), same project and
environment as the API. The service existed with no instance in `staging`: the project token
cannot `serviceConnect`, but `environmentPatchCommit` (config as a patch) created it. Settings:

| Setting | Value |
|---|---|
| Source | GitHub repo `voluma-bio/voluma`, root `/`, branch `jimyao/runner-deploy` while #59 is open. **At merge, change the branch to `main`** (`environmentPatchCommit` with `services.<id>.source.branch`), or the runner stops following pushes once the branch is deleted |
| CI check suites | Enabled (`source.checkSuites: true`); Railway waits for GitHub check suites before deploying |
| Build | Railpack, build command `echo runner has no build step`. `tsx` is a runtime dependency, because Railpack prunes dev dependencies |
| Start | `cd apps/runner && exec node --import tsx src/main.ts`. `exec` makes node the container's process, so it gets SIGTERM |
| Draining | 60 s: above the runner's `SHUTDOWN_BUDGET_MS` (30 s), which is how long it waits for runs to report `released` |
| Restart | on failure, 10 retries |
| Limits | 2 vCPU / 2 GB (set in the service's settings). The runner is one Node thread and holds no volumes: `segment_sam` and the other data work run in the sandbox, so heavy work creeping back into it hits the limit and fails loudly instead of slowing heartbeats quietly. Railway's default for the service is its 8 vCPU / 8 GB ceiling |
| Healthcheck | none: the runner serves nothing, so a healthcheck would fail every deploy |
| Watch paths | `/apps/runner/**`, `/packages/harness/**`, `/packages/workflow/**`, `/packages/contracts/**`, `/packages/provider-calls/**` (the runner imports it), `/packages/voluma-sam/**` (the harness imports its input schema), `/workflows/**` (the runner reads `workflows/` from its own checkout, so editing a workflow must redeploy it), `/pnpm-lock.yaml`, `/package.json`, `/.tool-versions`, `/tsconfig.base.json`, `/pnpm-workspace.yaml` |

Variables (names only; values never go in the repo):

| Variable | Source |
|---|---|
| `VOLUMA_API_URL` | `http://${{@voluma/api.RAILWAY_PRIVATE_DOMAIN}}:${{@voluma/api.PORT}}` (the API's `PORT` is set to 8080 explicitly, since a private URL needs a known port) |
| `VOLUMA_API_TOKEN` | reference `${{@voluma/api.VOLUMA_API_TOKEN}}`: rotating it on the API reaches the runner at its next deploy |
| `VOLUMA_META_API_KEY`, `RUNNER_CONCURRENCY` | the model key; 2 slots. Until Jimmy says the infrastructure is ready, staging is a test stack: `RUNNER_MODEL=meta/muse-spark-1.3-contributor` and `RUNNER_THINKING=medium` force every role onto cheap Spark contributor (Jimmy's choice, 30 Oct). Contributor mode lets Meta train on what it is sent, so put only cleared scans (OA6-1RK, OA7) on staging while it is set. For real runs, unset both: each role then takes its role file's alias (`wonder` = `meta/muse-wonder-1.0`, Standard mode) and thinking level. Contributor is never right outside that test default |
| `GATEWAY_TOKEN_SECRET`, `VOLUMA_GATEWAY_URL` | the same secret as `@voluma/gateway`; the gateway's public domain (`https://volumagateway-staging.up.railway.app`). `RUNNER_MAX_RUN_COST_USD` is unset on staging: no spend cap on test runs |
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | the Modal profile in `~/.modal.toml` |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_TOKEN` | as in `.env` |

With `RUNNER_THINKING` unset, a role without a `thinking` key in its role file sends no level (Pi and the provider apply their default; DeepSeek runs with thinking off). Set it to one of `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; the runner will not start if a model alias or the fallback lacks the level (a role file's own `thinking` is checked when a run starts), and the boot line prints it. With `RUNNER_MODEL` set (every role forced onto one model), the role files' levels are ignored and `RUNNER_THINKING` alone applies.

`RUNNER_FALLBACK_MODEL` (unset: no fallback) is Jimmy's per-deploy choice, since it sends lab data to another provider. It covers every role; see `src/model-fallback.ts`. Visitor runs use `RUNNER_VISITOR_MODEL` (default `meta/muse-spark-1.3`) with the visitor's key.

## The sandbox image

`sandbox/Dockerfile` is the one definition of the image: Python and its packages, `ffmpeg`, Node 24
and `voluma-sam` (the bundle of `packages/voluma-sam`, which the workflow builds first and passes as the
build context `sam`). The "Sandbox image" workflow
(`.github/workflows/sandbox-image.yml`) builds it for linux/amd64 on a change to the Dockerfile,
`packages/voluma-sam` or by hand, pushes `ghcr.io/voluma-bio/voluma-sandbox:<commit>` and prints the digest. Put
that digest in `SANDBOX_IMAGE` (`src/config.ts`). Every run of the workflow gives a new digest, even for the same contents (image timestamps), and it also runs when the workflow file or `requirements.txt` changes, so bump `SANDBOX_IMAGE` only when the contents changed. The package
must be **public**, or a visitor's Modal workspace cannot pull it: GitHub, the org's Packages,
`voluma-sandbox`, Package settings, Danger Zone, Change visibility.

## Checked on staging (2026-10-28)

- **Sandbox start from GHCR, our workspace, create to first exec done:** 23.6 s the first time (Modal pulls and caches the image), 1.5 s warm (create call 0.17 s). A different workspace pulls its own copy on its first run.
- **A guest run** on the reference scan (`two-task-test`): claimed by the deployed runner within seconds, sandbox from the GHCR image, tool calls and results streamed over SSE.
- **A redeploy mid-run:** Railway sent SIGTERM; the old runner logged `releasing 1 run(s)`, ended its threads `cancelled` and reported `released` (15:06:44). The new instance claimed the run a second later, replayed the stored history, told the worker "You stopped, but segment-tibia is not finished", recreated the sandbox and ran the interrupted command again. One caveat: the old runner logged `sandbox did not close in time; terminating this claim's sandboxes` 15 s after the report; the sandbox was gone afterwards (`--dry-run` showed 0 for our runs).
- **Model errors, not infrastructure:** from about 15:07 Meta answered `404 model_not_found` for `muse-spark-1.3` on a share of calls that carry tools (2 of 10 in a local loop with the same key; a plain call never failed). With no retry the worker thread failed, the run left the task `to-check`, and the run `ended completed` with nothing folded. `model-retry.ts` now retries it (see [CONTEXT.md](CONTEXT.md)); not re-run on staging, because the Demo allowance was used up that day.
- **Cost is recorded, just not shown.** Pi's price table has `muse-spark-1.3` (input $1.25, output $4.25 per million tokens) and a reply's `usage.cost.total` is non-zero; the heartbeat carries it and the API adds it to `runs.model_cost_usd`. Nothing in the API's run response or the runner's log showed it; the runner now logs `model cost this claim` when it reports.
- **`sandbox did not close in time` after a release** is expected, not a bug: after a stop the close budget is 15 s, and Modal's terminate takes 20-30 s while a command runs (CONTEXT.md, item 1), so the runner terminates the claim's sandboxes by tag instead.
- **The image with pyvista (microct requirements):** in a real sandbox from the pinned digest, `pyvista` renders a PNG offscreen (31 KB) and numpy, scipy, skimage, SimpleITK, nibabel, pydicom and matplotlib import; first start 29 s.
- **Cleanup:** `sandboxes:clean --run <id>` for each of the 7 runs, then `--dry-run`: 0 of ours live (another agent's `probe6` sandbox was up).
