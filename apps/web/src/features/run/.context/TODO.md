# Run feature: deferred work

- **Move `packages/run-view/src/chat/` to `packages/ui`** when the review chat wants the same transcript pieces.
- **Images and full tool output in the thread view.** `view_image` results keep text only (path, size, sha256) and a truncated `tool.result` keeps its head and tail; the full output and the images are in R2 but no API call serves them to the run page.
- **Say which runtime message is the brief.** `threadRows` labels a thread's first `runtime`
  message "Task brief", and `packages/harness/src/thread-log.ts` skips it when counting deliveries: the
  same positional rule on both sides of the contract. Give the runtime sender a purpose (e.g.
  `{ kind: "runtime", purpose: "brief" | "nudge" }`) in a contracts PR, stamp it in
  `start-thread.ts`, and have both readers switch on it.
- **Rebuild only the live tail of the transcript per frame**, if a long run janks. `rows` reruns
  `threadRows`/`mainRows` over every event on each frame (about 1 ms today). Split each into a
  durable part memoized on `events` and a live tail on `live`, then `memo(RowView)`.
- **Label threads with the run's own plan titles.** The flowchart, Overview and task view use the
  plan's `title` from the run's log; `threadName` and the transcript rows still read the bundled
  `tasks.json` (`taskTitle`), so an older run's cards show today's titles.
- **Undo "Looks right".** The prototype offers Undo; the review API has no call to withdraw an
  acceptance.
- **A thumbnail rendition of QC images.** Each is 80 to 360 KB and the Needs your eye cards draw
  them at 88 px; lazy loading keeps it to what is on screen.
- **Tag script warnings.** The prototype tags a Needs your eye item "Script warning" when a
  skill's script raised it. The stream can't say so: a checkpoint's `toCheck` has a title, a
  detail and a focus, and nothing records that a script raised it. It needs a field on `toCheck`
  (a contracts PR), and the skills' scripts' warnings written through it.
