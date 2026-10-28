# Runner TODO

From the round-2 review of #40 (`voluma-bio/docs` `work/mvp-contracts-and-data/research/review-pr40-round2.md`):

- **A sandbox create still in flight after release can kill the reclaiming runner's sandbox.** `createSandbox` terminates every live sandbox tagged with the run and name before creating (`modal-sandbox.ts`), and takes no abort signal. Pass the run's signal in, check it before that terminate and before `sandboxes.create`, and correct the header's "runs only once this runner holds the run's lease". Costs one lost command and one extra start; no data loss.
- **`released` can miss Railway's 30 s drain under a slow API.** `lease.end` waits for an in-flight heartbeat and sends one more (up to 15 s each) before the report. Skip or shorten the final heartbeat when the report is `released`.
- **Sandbox seconds start at `ready`, not `starting`** (`run.ts`), so the dollar ceiling under-counts creation and staging.
- **`redact.ts` header:** say that a run resumed from stored, redacted events can differ from the live one when a key appeared in content.
- **`segment_sam` holds the volume in runner memory** (~1.3 GB peak per call on an OA6-1RK-sized stack, review of #56). If staging shows memory pressure, move the heavy parts into the sandbox: the sandbox encodes the slice stack to MP4 in `/scratch`, the runner only uploads it to Meta and writes the raw response to `/scratch`, and the sandbox decodes and pastes the masks in Python. The key still never enters the sandbox. Workers or Durable Objects don't fit (128 MB per isolate, no native ffmpeg).

- Model aliases live in the runner's config (`config.ts`: defaults plus `RUNNER_MODEL_ALIASES`), not in `apps/api` as workflow-md-format.md says, because the runner is what holds model keys. The per-workflow override (a JSON on the catalog entry) is not built.
- The main thread is a tool-less model call per wake. The skillset's `microct-lead` names `view_image` and skills it would read; that needs the thread to have a sandbox. Until then the main thread gets its agent's instructions and the workflow intro only, and an agent's `tools:` on `main` are checked for names but not given. The `review` role is parsed, not started.
- The importer needs `GITHUB_TOKEN` for private repos and fetches one file per request; a package with hundreds of resource files wants the tarball instead.
