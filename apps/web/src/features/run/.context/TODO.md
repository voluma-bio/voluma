# Run feature: deferred work

- **Move `chat/` to `packages/ui`** when the review chat wants the same transcript pieces.
- **Images and full tool output in the thread view.** `view_image` results keep text only (path, size, sha256) and a truncated `tool.result` keeps its head and tail; the full output and the images are in R2 but no API call serves them to the run page.
- **Say which runtime message is the brief.** `threadRows` labels a thread's first `runtime`
  message "Task brief", and `packages/harness/src/thread-log.ts` skips it when counting wakes: the
  same positional rule on both sides of the contract. Give the runtime sender a purpose (e.g.
  `{ kind: "runtime", purpose: "brief" | "nudge" }`) in a contracts PR, stamp it in
  `start-thread.ts`, and have both readers switch on it.
- **Rebuild only the live tail of the transcript per frame**, if a long run janks. `rows` reruns
  `threadRows`/`mainRows` over every event on each frame (about 1 ms today). Split each into a
  durable part memoized on `events` and a live tail on `live`, then `memo(RowView)`.
- **Label tasks with the run's own plan titles.** Every label on the page (`taskTitle`) reads the
  bundled `tasks.json`, so an older run shows today's titles. The plan in the run's first
  `revision.started` carries the titles it ran with. Build the title lookup from it in `runView` and
  pass it to the graph, attention, `threadName`, the transcript rows and the spend list.
