# Deploying the runner (Railway staging)

The runner is the second deployed service: it claims queued runs from the API over
Railway's private network and runs them (sandboxes on Modal, files in R2). It serves
nothing. Project, environment and the `gql` helper are in
[../../api/.context/deploy.md](../../api/.context/deploy.md); this file holds only what differs.

## How it is set up

Service `@voluma/runner` (id `ad12b6ff-b9c8-45cb-b9c1-af444e398749`), same project and
environment as the API. The service existed with no instance in `staging`: the project token
cannot `serviceConnect`, but `environmentPatchCommit` (config as a patch) created it. Settings:

| Setting | Value |
|---|---|
| Source | GitHub repo `voluma-bio/voluma`, root `/`, branch `jimyao/runner-deploy` while #59 is open. **At merge, change the branch to `main`** (`environmentPatchCommit` with `services.<id>.source.branch`), or the runner stops following pushes once the branch is deleted |
| Build | Railpack, build command `echo runner has no build step`. `tsx` is a runtime dependency, because Railpack prunes dev dependencies |
| Start | `cd apps/runner && exec node --import tsx src/main.ts`. `exec` makes node the container's process, so it gets SIGTERM |
| Draining | 60 s: above the runner's `SHUTDOWN_BUDGET_MS` (30 s), which is how long it waits for runs to report `released` |
| Restart | on failure, 10 retries |
| Healthcheck | none: the runner serves nothing, so a healthcheck would fail every deploy |
| Watch paths | `/apps/runner/**`, `/packages/harness/**`, `/packages/contracts/**`, `/pnpm-lock.yaml`, `/package.json`, `/.tool-versions`, `/tsconfig.base.json`, `/pnpm-workspace.yaml` |

Variables (names only; values never go in the repo):

| Variable | Source |
|---|---|
| `VOLUMA_API_URL` | `http://${{@voluma/api.RAILWAY_PRIVATE_DOMAIN}}:${{@voluma/api.PORT}}` (the API's `PORT` is set to 8080 explicitly, since a private URL needs a known port) |
| `VOLUMA_API_TOKEN` | reference `${{@voluma/api.VOLUMA_API_TOKEN}}`: rotating it on the API reaches the runner at its next deploy |
| `VOLUMA_META_API_KEY`, `RUNNER_MODEL`, `RUNNER_CONCURRENCY` | the model key; `RUNNER_MODEL=meta/muse-spark-1.3` (Standard mode: never a `-contributor` model on a deployed runner, Meta may train on what it is sent); 2 slots |
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | the Modal profile in `~/.modal.toml` |
| `RAILPACK_DEPLOY_APT_PACKAGES` | `ffmpeg`: installed in the runner's container (segment_sam needs it) |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_TOKEN` | as in `.env` |

Visitor runs use `RUNNER_VISITOR_MODEL` (default `meta/muse-spark-1.3`) with the visitor's key.

## The sandbox image

`sandbox/Dockerfile` is the one definition of the image. The "Sandbox image" workflow
(`.github/workflows/sandbox-image.yml`) builds it for linux/amd64 on a change to the Dockerfile
or by hand, pushes `ghcr.io/voluma-bio/voluma-sandbox:<commit>` and prints the digest. Put
that digest in `SANDBOX_IMAGE` (`src/config.ts`). A rebuild gives a new digest even for an
unchanged Dockerfile (image timestamps), so rebuild only when the contents change. The package
must be **public**, or a visitor's Modal workspace cannot pull it: GitHub, the org's Packages,
`voluma-sandbox`, Package settings, Danger Zone, Change visibility.

## Checked on staging (2026-10-28)

- **Sandbox start from GHCR, our workspace, create to first exec done:** 23.6 s the first time (Modal pulls and caches the image), 1.5 s warm (create call 0.17 s). A different workspace pulls its own copy on its first run.
- **A guest run** on the reference scan (`two-task-test`): claimed by the deployed runner within seconds, sandbox from the GHCR image, tool calls and results streamed over SSE.
- **A redeploy mid-run:** Railway sent SIGTERM; the old runner logged `releasing 1 run(s)`, ended its threads `cancelled` and reported `released` (15:06:44). The new instance claimed the run a second later, replayed the stored history, told the worker "You stopped, but segment-tibia is not finished", recreated the sandbox and ran the interrupted command again. One caveat: the old runner logged `sandbox did not close in time; terminating this claim's sandboxes` 15 s after the report; the sandbox was gone afterwards (`--dry-run` showed 0 for our runs).
- **Model errors, not infrastructure:** from about 15:07 Meta answered `404 model_not_found` for `muse-spark-1.3` on a share of calls that carry tools (2 of 10 in a local loop with the same key; the plain no-tools call never failed). The runner has no retry, so the worker thread fails; the supervisor's judgment left the task `to-check` and the run `ended completed` with nothing folded. For the run lane: retry transient provider errors.
- **Cleanup:** `sandboxes:clean --run <id>` for each of the 7 runs, then `--dry-run`: 0 of ours live (another agent's `probe6` sandbox was up).
