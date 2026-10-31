# Scan review

One screen, `/scans/:runId` (dark theme): one scan's run, live while it goes and for review once
it ends. The grid viewer fills the main area; To check, Report and Agents dock on the left, View
and The AI on the right (`ShellPanel`s, shortcuts t, r, a, v, i). `/runs/:id/live` and
`/runs/:runId` redirect here with their search kept. Links to a run use `runHref`
(`@voluma/run-view`).

## One selection, in the URL

Search params, set with `replace`:

- `item=<checkId>`: the To check item open. The id is `NeedItem.id`, the check id
  `acceptCheck` takes and the study's To check list carries. An item names its own task; a
  `task` that disagrees is replaced in the URL.
- `task=<taskId>`: the task in view (viewer, View, Report, The AI's subject). Without `item`,
  the open item is the first open one of this task, so the card and the views never disagree;
  a task with no item shows none.
- `agent=<threadId>`: the agent whose steps show; none follows the one working now.

Without `item` or `task`, the task in view is the first open item's, else the plan's first.

## Two sources

- **The run's stream** (`use-run-stream.ts` into the run store, then `runView`) gives tasks,
  agents, items and the conversation. `getRun` is polled every 3 s until the run ends: queue
  place and state aren't events.
- **The review payload** (`getReviewRun`) gives what the viewer draws, the values, references and
  files, plus authoritative check acceptance for the same task result. It is refetched on tab
  return and reconnect even after execution SSE closes. It is fetched again (once things settle,
  after 1 s) when the stream shows a task's
  state, tries or values changing, and when the run ends. It is polled only while it answers 409
  (no plan yet) and while assets are still being converted, until ten minutes after the end. A task with no review data yet
  shows "No views for <task> yet"; the viewer never falls back to another task.

## The stream reconnects without losing what it has

Every connection appends to the same events and resumes with `subscribe(..., after = last seq)`.
It reconnects after a successful message, when the run resumes or its completed revision changes, including a correction
completed in another tab, and, with a backoff (1 s to 30 s),
when the browser gives up on the stream while the run still goes (an EventSource closes for good
on a non-200 answer, as during a deploy). An ended run's stream closes after its backlog and stays
closed until a message is sent or the run or its completed revision changes; the
end is applied only then (`haltOf(state, closed)`), so a reload never shows a finished thread as
stopped.

## Decisions and messages

- **Looks right** names the displayed review revision and the item's `resultRevisionId`, only
  on a completed run that isn't an example. The item and viewer must describe the same task
  result. The API compares both revisions before deduplicating or recording the acceptance.
  Mutation responses update the review cache; there is no component-local accepted set. The
  page reconciles each item's status by task, result revision and check id, never by id alone,
  while scientific progress stays on SSE. A refusal shows the shared mutation's error message;
  a 409 refetches the run, review and study reads.
- **The AI** writes through `sendRunMessage`; who may write and when is the API's rule, and the
  box says why it is off. Something's wrong makes the message about the item's task and opens
  The AI beside what is open; that subject holds until the task in view changes or the message is
  sent. A 409 shows the server's text. A retry keeps the message id, so the server stores it
  once; editing after a failure makes a new message.
- Thread kinds are shown as labels only; nothing here branches on a kind or a role name.
