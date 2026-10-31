# Runner TODO

- **Measure the live `/inputs` staging rate after #198.** Run a before/after A/B on the staging OA6-1RK prefix with the staging runner environment, recording `cp` stderr and elapsed time. The parent-directory race is reproduced and fixed locally; a real-Modal count would confirm it was the only cause. Do not lower `-P 32` without that measurement.
- **Staged `/inputs` is a writable local copy.** For tasks with `copyInputs`, `modal-sandbox.ts` mounts the source read-only under `/staged/inputs` but copies it to ordinary local files at `/inputs`. Commands run as root; the copy is not remounted read-only. The read-only instruction in the prompt is not enforcement, and an edit disappears on sandbox restart. Preserve the original input files; enforcing a read-only staged copy needs support in the sandbox image or mount options.

From the round-2 review of #40 (`voluma-bio/docs` `work/mvp-contracts-and-data/research/review-pr40-round2.md`):

- **`released` can miss the host's drain (60 s) under a slow API.** `lease.end` waits for an in-flight heartbeat and sends one more (up to 15 s each) before the report. Skip or shorten the final heartbeat when the report is `released`.
- **`redact.ts` header:** say that a run resumed from stored, redacted events can differ from the live one when a key appeared in content.

From the skillset move (`workflows/` in this repo):

- **The sandbox image does not follow the pinned commit.** The image is one digest in config (`SANDBOX_IMAGE`), so an old pin runs on the newest image. To tie them: tag the image with the hash of `workflows/core/requirements.txt`, have the runner resolve that tag from the requirements at the run's pinned commit, and record the image in the run's first event. Needs the workflow-packages lane's pin and the `/workflow` mount to read that file.


- **An ended run can leave review assets "preparing" when it fails before the conversion worker
  starts** (e.g. `loadWorkflow` throws on a resume whose log already holds outputs). Create the
  recorder and worker right after `storedEvents()`, or record `assets.failed` for pending outputs in
  `finally` when the report is `ended` and the worker is undefined. (review p528 of #184)
- **A stop between `drain`'s last abort check and its final flush** releases the run with its
  leftovers already `assets.failed`, so the next claim won't retry them. Have `drain` return whether
  it closed the queue and rebuild the report only when it didn't. (p528)
- An output appended after the drain's final scan (a thread stuck past the 5 s wind-down) gets no
  `assets.*` event. Narrow. (p529)
- **Thinking level isn't in the events.** Pi records each reply's level in History (`thinkingLevel` on the assistant message), and the runner's boot line prints `RUNNER_THINKING`, but a run's events don't say which level a thread used. Per-role levels have landed (role files' `thinking`); record the level with the model on `thread.started` (a contract change) so a resume keeps it.

- **A correction's output backup (`runs/<id>/corrections/<reopen id>/`) is deleted only by the next claim after it, and a restored one stays.** A go's first claim copies the whole `/outputs` (`outputs-backup.ts`); the first claim of the next reopen after the correction finished deletes it, but a backup that was restored (the correction failed) is kept, and a run never reopened again keeps its last one. Delete restored backups too. Objects over 5 GB would need a multipart copy (`r2-outputs.ts` uses one `CopyObject`).
- **Per-attempt output folders** would end the restore: an attempt writes `/outputs/<task>/<attempt>/`, so an abandoned attempt never touches the kept one's files and nothing is copied or put back. Too large for the corrections PR (every path that names an output file, the sandbox mount, the prompts, the converter); revisit after the Nov 4 demo.
