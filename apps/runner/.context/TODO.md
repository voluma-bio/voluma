# Runner TODO

From the round-2 review of #40 (`voluma-bio/docs` `work/mvp-contracts-and-data/research/review-pr40-round2.md`):

- **A sandbox create still in flight after release can kill the reclaiming runner's sandbox.** `createSandbox` terminates every live sandbox tagged with the run and name before creating (`modal-sandbox.ts`), and takes no abort signal. Pass the run's signal in, check it before that terminate and before `sandboxes.create`, and correct the header's "runs only once this runner holds the run's lease". Costs one lost command and one extra start; no data loss.
- **`released` can miss Railway's 30 s drain under a slow API.** `lease.end` waits for an in-flight heartbeat and sends one more (up to 15 s each) before the report. Skip or shorten the final heartbeat when the report is `released`.
- **Sandbox seconds start at `ready`, not `starting`** (`run.ts`), so the dollar ceiling under-counts creation and staging.
- **`redact.ts` header:** say that a run resumed from stored, redacted events can differ from the live one when a key appeared in content.

From the skillset move (`workflows/` in this repo):

- **The sandbox image does not follow the pinned commit.** The image is chosen by name in config, so an old pin runs on the newest image. To tie them: publish under a tag from the hash of `workflows/microct-analysis/requirements.txt`, have the runner resolve that tag from the requirements at the run's pinned commit, and record the image in the run's first event. Needs the workflow-packages lane's pin and the `/workflow` mount to read that file.
- **The deploy lane's `sandbox/Dockerfile`** (branch `jimyao/runner-deploy`) still has an inline pip line; when both land, `COPY` `workflows/microct-analysis/requirements.txt` and `pip install --no-deps -r` it (the file's header says why `--no-deps`).
