# Runner TODO

From the round-2 review of #40 (`voluma-bio/docs` `work/mvp-contracts-and-data/research/review-pr40-round2.md`):

- **A sandbox create still in flight after release can kill the reclaiming runner's sandbox.** `createSandbox` terminates every live sandbox tagged with the run and name before creating (`modal-sandbox.ts`), and takes no abort signal. Pass the run's signal in, check it before that terminate and before `sandboxes.create`, and correct the header's "runs only once this runner holds the run's lease". Costs one lost command and one extra start; no data loss.
- **`released` can miss Railway's 30 s drain under a slow API.** `lease.end` waits for an in-flight heartbeat and sends one more (up to 15 s each) before the report. Skip or shorten the final heartbeat when the report is `released`.
- **Sandbox seconds start at `ready`, not `starting`** (`run.ts`), so the dollar ceiling under-counts creation and staging.
- **`redact.ts` header:** say that a run resumed from stored, redacted events can differ from the live one when a key appeared in content.
- Model aliases: an agent definition's `model:` alias is parsed but not used; every role runs on the runner's configured model. Add the server-side alias table and the per-workflow override (spec: workflow-md-format.md).
- Roles `main` and `review` are parsed but not started; `checker`'s tools and instructions apply to check threads only.
- The importer needs `GITHUB_TOKEN` for private repos and fetches one file per request; a package with hundreds of resource files wants the tarball instead.
