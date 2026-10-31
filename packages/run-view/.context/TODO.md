# Run view: deferred work

- **Move `packages/run-view/src/chat/` to `packages/ui`** when the review chat wants the same transcript pieces.
- **Images and full tool output in the thread view.** `view_image` results keep text only (path, size, sha256) and a truncated `tool.result` keeps its head and tail; the full output and the images are in R2 but no API call serves them to the page.
- **Say which runtime message is the brief.** `threadRows` labels a thread's first `runtime`
  message "Task brief", and `packages/harness/src/thread-log.ts` skips it when counting deliveries: the
  same positional rule on both sides of the contract. Give the runtime sender a purpose (e.g.
  `{ kind: "runtime", purpose: "brief" | "nudge" }`) in a contracts PR, stamp it in
  `start-thread.ts`, and have both readers switch on it.
- **Rebuild only the live tail of the transcript per frame**, if a long run janks. `rows` reruns
  `threadRows`/`mainRows` over every event on each frame (about 1 ms today). Split each into a
  durable part memoized on `events` and a live tail on `live`, then `memo(RowView)`.
- **Label threads with the run's own plan titles.** The task graph and the scan review's panels use
  the plan's `title` from the run's log; `threadName` and the transcript rows still read the bundled
  `tasks.json` (`taskTitle`), so an older run's cards show today's titles.
- **Undo "Looks right".** The prototype offers Undo; the review API has no call to withdraw an
  acceptance.
- **A thumbnail rendition of QC images.** Each is 80 to 360 KB and the To check card draws them
  at most 160 px high; lazy loading keeps it to what is on screen.
- **Tag script warnings.** The prototype tags a To check item "Script warning" when a
  skill's script raised it. The stream can't say so: a checkpoint's `toCheck` has a title, a
  detail and a focus, and nothing records that a script raised it. It needs a field on `toCheck`
  (a contracts PR), and the skills' scripts' warnings written through it.
- **Resend a stored key from Home and the study dashboard too.** Only the run page sends the
  starter's stored Meta key by itself when a run waits for keys (`AwaitingKeys` in
  `apps/web/src/features/scan/scan-header.tsx`). Home and the dashboard list the waiting run and link
  to it, so a guest watching a batch still opens each scan. Move the once-per-wait send into a hook
  here and use it from both features.
