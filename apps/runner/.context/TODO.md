# Runner TODO

- **An output appended after the drain's final scan** (a thread stuck past the 5 s wind-down after a failure) gets no `assets.*` event. Narrow.

- **Validate the input review cache on real Modal/R2 mounts ([#325](https://github.com/voluma-bio/voluma/pull/325)).** Andrew deferred this test and authorized merge after a fresh clean review on 2026-10-31; local OA6-1RK checks do not establish deployed mount behavior. After credentials and paid-resource approval are available, verify cold/warm reuse across independent mounts, concurrent and interrupted publication, cancellation, prefix permissions, and mounted-storage performance. Use a unique `dev/` prefix, preserve existing inputs, and clean up only the probe's objects and sandboxes.

From the round-2 review of #40 (`voluma-bio/docs` history: `git show 101a8b09:work/mvp-contracts-and-data/research/review-pr40-round2.md`):

- **`released` can miss the host's drain (60 s) under a slow API.** `lease.end` waits for an in-flight heartbeat and sends one more (up to 15 s each) before the report. Skip or shorten the final heartbeat when the report is `released`.
- **`redact.ts` header:** say that a run resumed from stored, redacted events can differ from the live one when a key appeared in content.

From the skillset move (`workflows/` in this repo):

- **The image a run begins on is this runner's, not the pinned commit's.** A run records its image on the root `thread.started` (`sandboxImage`) at its first claim and keeps it on every resume, so a deploy no longer moves a running run. A run that starts on a new runner whose workflow commit is older still gets the newest image. To tie them: tag the image with the hash of `workflows/core/requirements.txt` and resolve that tag from the requirements at the pinned commit.


- **Thinking level isn't in the events.** Pi records each reply's level in History (`thinkingLevel` on the assistant message), and the runner's boot line prints `RUNNER_THINKING`, but a run's events don't say which level a thread used. Per-role levels have landed (role files' `thinking`); record the level with the model on `thread.started` (a contract change) so a resume keeps it.

- **Every Meta request hashes every inline image** (`meta-images.ts`, `fileIdFor`): about 54 ms of event-loop time per 40 images of 1 MiB, plus short-lived copies. Cache the hash per image if it ever competes with the lease timers.
