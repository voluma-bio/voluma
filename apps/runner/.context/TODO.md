# Runner TODO

- **Validate the input review cache on real Modal/R2 mounts ([#325](https://github.com/voluma-bio/voluma/pull/325)).** Andrew deferred this test and authorized merge after a fresh clean review on 2026-10-31; local OA6-1RK checks do not establish deployed mount behavior. After credentials and paid-resource approval are available, verify cold/warm reuse across independent mounts, concurrent and interrupted publication, cancellation, prefix permissions, and mounted-storage performance. Use a unique `dev/` prefix, preserve existing inputs, and clean up only the probe's objects and sandboxes.
- **Measure the live `/inputs` staging rate after #198.** Run a before/after A/B on the staging OA6-1RK prefix with the staging runner environment, recording `cp` stderr and elapsed time. The parent-directory race is reproduced and fixed locally; a real-Modal count would confirm it was the only cause. Do not lower `-P 32` without that measurement.
- **Staged `/inputs` is a writable local copy.** For tasks with `copyInputs`, `modal-sandbox.ts` mounts the source read-only under `/staged/inputs` but copies it to ordinary local files at `/inputs`. Commands run as root; the copy is not remounted read-only. The read-only instruction in the prompt is not enforcement, and an edit disappears on sandbox restart. Preserve the original input files; enforcing a read-only staged copy needs support in the sandbox image or mount options.

From the round-2 review of #40 (`voluma-bio/docs` `work/mvp-contracts-and-data/research/review-pr40-round2.md`):

- **`released` can miss the host's drain (60 s) under a slow API.** `lease.end` waits for an in-flight heartbeat and sends one more (up to 15 s each) before the report. Skip or shorten the final heartbeat when the report is `released`.
- **`redact.ts` header:** say that a run resumed from stored, redacted events can differ from the live one when a key appeared in content.

From the skillset move (`workflows/` in this repo):

- **The image a run begins on is this runner's, not the pinned commit's.** A run records its image on the root `thread.started` (`sandboxImage`) at its first claim and keeps it on every resume, so a deploy no longer moves a running run. A run that starts on a new runner whose workflow commit is older still gets the newest image. To tie them: tag the image with the hash of `workflows/core/requirements.txt` and resolve that tag from the requirements at the pinned commit.


- **Thinking level isn't in the events.** Pi records each reply's level in History (`thinkingLevel` on the assistant message), and the runner's boot line prints `RUNNER_THINKING`, but a run's events don't say which level a thread used. Per-role levels have landed (role files' `thinking`); record the level with the model on `thread.started` (a contract change) so a resume keeps it.

- **A correction's output backup (`runs/<id>/corrections/<reopen id>/`) is deleted only by the next claim after it, and a restored one stays.** A go's first claim copies the whole `/outputs` (`outputs-backup.ts`); the first claim of the next reopen after the correction finished deletes it, but a backup that was restored (the correction failed) is kept, and a run never reopened again keeps its last one. Delete restored backups too. Objects over 5 GB would need a multipart copy (`r2-outputs.ts` uses one `CopyObject`).
- **Per-attempt output folders** would end the restore: an attempt writes `/outputs/<task>/<attempt>/`, so an abandoned attempt never touches the kept one's files and nothing is copied or put back. Too large for the corrections PR (every path that names an output file, the sandbox mount, the prompts, the converter); revisit after the Nov 4 demo.
