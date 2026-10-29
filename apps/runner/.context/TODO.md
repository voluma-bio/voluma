# Runner TODO

From the round-2 review of #40 (`voluma-bio/docs` `work/mvp-contracts-and-data/research/review-pr40-round2.md`):

- **`released` can miss Railway's 30 s drain under a slow API.** `lease.end` waits for an in-flight heartbeat and sends one more (up to 15 s each) before the report. Skip or shorten the final heartbeat when the report is `released`.
- **`redact.ts` header:** say that a run resumed from stored, redacted events can differ from the live one when a key appeared in content.

From the skillset move (`workflows/` in this repo):

- **The sandbox image does not follow the pinned commit.** The image is one digest in config (`SANDBOX_IMAGE`), so an old pin runs on the newest image. To tie them: tag the image with the hash of `workflows/core/requirements.txt`, have the runner resolve that tag from the requirements at the run's pinned commit, and record the image in the run's first event. Needs the workflow-packages lane's pin and the `/workflow` mount to read that file.

- **Models per role** are config (`RUNNER_MODEL` worker, `RUNNER_CHECK_MODEL`, `RUNNER_MAIN_MODEL`), not an alias table in `apps/api` as the format doc says, because the runner holds the keys. The per-workflow or per-org override is not built.
- **The main thread has no tools or sandbox.** At run start it sees the plan, the selection and the user's notes, not the workflow skill's text; the skillset's `microct-lead` names `view_image` and skills it would read, which needs the thread to have a sandbox. The `review` role is not started.
