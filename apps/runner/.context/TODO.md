# Runner TODO

From the round-2 review of #40 (`voluma-bio/docs` `work/mvp-contracts-and-data/research/review-pr40-round2.md`):

- **A sandbox create still in flight after release can kill the reclaiming runner's sandbox.** `createSandbox` terminates every live sandbox tagged with the run and name before creating (`modal-sandbox.ts`), and takes no abort signal. Pass the run's signal in, check it before that terminate and before `sandboxes.create`, and correct the header's "runs only once this runner holds the run's lease". Costs one lost command and one extra start; no data loss.
- **`released` can miss Railway's 30 s drain under a slow API.** `lease.end` waits for an in-flight heartbeat and sends one more (up to 15 s each) before the report. Skip or shorten the final heartbeat when the report is `released`.
- **Sandbox seconds start at `ready`, not `starting`** (`run.ts`), so the dollar ceiling under-counts creation and staging.
- **`redact.ts` header:** say that a run resumed from stored, redacted events can differ from the live one when a key appeared in content.
- **Tool granting (from #56):** `view_image` is offered to every thread and `segment_sam` whenever a Meta key exists, set in `supervise-run.ts`. Both move to #57's tool registry, granted only through an agent's `tools:` list, once it lands.
- **`segment_sam` holds the volume in runner memory** (~1.3 GB peak per call on an OA6-1RK-sized stack, review of #56). If staging shows memory pressure, move the heavy parts into the sandbox: the sandbox encodes the slice stack to MP4 in `/scratch`, the runner only uploads it to Meta and writes the raw response to `/scratch`, and the sandbox decodes and pastes the masks in Python. The key still never enters the sandbox. Workers or Durable Objects don't fit (128 MB per isolate, no native ffmpeg).

From the skillset move (`workflows/` in this repo):

- **The sandbox image does not follow the pinned commit.** The image is one digest in config (`SANDBOX_IMAGE`), so an old pin runs on the newest image. To tie them: tag the image with the hash of `workflows/microct-analysis/requirements.txt`, have the runner resolve that tag from the requirements at the run's pinned commit, and record the image in the run's first event. Needs the workflow-packages lane's pin and the `/workflow` mount to read that file.
- **Models per role.** Every role runs on the runner's configured model. The server-side alias table and the per-workflow override (spec: `workflow-format.md`) are not built.
- **Roles `main` and `review` are not started.** The main-thread lane builds them; `adaptPlan` in `packages/workflow/src/plan.ts` is its seam for the run's notes.
