# Runner TODO

- **Measure the live `/inputs` staging rate after #198.** Run a before/after A/B on the staging OA6-1RK prefix with the staging runner environment, recording `cp` stderr and elapsed time. The parent-directory race is reproduced and fixed locally; a real-Modal count would confirm it was the only cause. Do not lower `-P 32` without that measurement.

From the round-2 review of #40 (`voluma-bio/docs` `work/mvp-contracts-and-data/research/review-pr40-round2.md`):

- **`released` can miss Railway's 30 s drain under a slow API.** `lease.end` waits for an in-flight heartbeat and sends one more (up to 15 s each) before the report. Skip or shorten the final heartbeat when the report is `released`.
- **`redact.ts` header:** say that a run resumed from stored, redacted events can differ from the live one when a key appeared in content.

From the skillset move (`workflows/` in this repo):

- **The sandbox image does not follow the pinned commit.** The image is one digest in config (`SANDBOX_IMAGE`), so an old pin runs on the newest image. To tie them: tag the image with the hash of `workflows/core/requirements.txt`, have the runner resolve that tag from the requirements at the run's pinned commit, and record the image in the run's first event. Needs the workflow-packages lane's pin and the `/workflow` mount to read that file.

- **Models per role** are config (`RUNNER_MODEL` worker, `RUNNER_CHECK_MODEL`, `RUNNER_MAIN_MODEL`), not an alias table in `apps/api` as the format doc says, because the runner holds the keys. The per-workflow or per-org override is not built.
- **The main thread has no tools or sandbox.** At run start it sees the plan, the selection and the user's notes, not the workflow skill's text; the skillset's `microct-lead` names `view_image` and skills it would read, which needs the thread to have a sandbox. The `review` role is not started.

- **An ended run can leave review assets "preparing" when it fails before the conversion worker
  starts** (e.g. `loadWorkflow` throws on a resume whose log already holds outputs). Create the
  recorder and worker right after `storedEvents()`, or record `assets.failed` for pending outputs in
  `finally` when the report is `ended` and the worker is undefined. (review p528 of #184)
- **A stop between `drain`'s last abort check and its final flush** releases the run with its
  leftovers already `assets.failed`, so the next claim won't retry them. Have `drain` return whether
  it closed the queue and rebuild the report only when it didn't. (p528)
- An output appended after the drain's final scan (a thread stuck past the 5 s wind-down) gets no
  `assets.*` event. Narrow. (p529)
- **A hung read on the mount blocks thread start for up to an hour.** `stage()` runs through `#run` with a 3600 s deadline and no `timeout -k`; a `cp` stuck in the R2 mount isn't killed and retries can't help. Wrap staging like `exec()` (process group under `timeout -k`) or run each `cp` under `timeout`.
