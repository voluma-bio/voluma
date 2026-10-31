# Scan review

One screen, `/scans/:runId` (the user's theme, dark image wells): one scan's run, live while it goes and for review once
it ends. The grid viewer fills the main area; Study, To check, Report and Agents dock on the left, View,
Marks and The AI on the right (`ShellPanel`s, shortcuts s, t, r, a, v, m, i). Study replaces the left panel
without navigating; To check keeps its URL selection and panel scroll position when reopened.
Each visit to a scan opens To check and The AI, including after Home or a reload. Panel choices
last only for that visit; the shell saves widths and stacked splits, not open panels.
Study highlights the current scan and links to the study overview only when it has multiple scans:
a study of one redirects to its scan, so neither this panel nor the breadcrumb links there.
`/runs/:id/live` and
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

## Each grid keeps its viewer

A task is shown on its own grid (`taskGrid`); mouse-oa has two, the Scan and the aligned tibia
grid. `TaskViewer` keeps one `GridViewer` per grid shown, at most two mounted at any commit
(`MAX_KEPT`: each holds four WebGL contexts, and Chrome allows 16 per page), and hides the others
(`hidden`). One function, `keep`, decides what is kept, both for what mounts in a render and for
the `kept` state: viewers whose image is still in the revision, least recently shown first, the
shown one last; the oldest goes past the cap. Each kept entry carries its viewer's readiness, so
an evicted or retired viewer takes its readiness with it. Going back to a grid is instant: camera,
crosshair, window, meshes and slices are as they were, and a picked item still moves the crosshair
to its place. Showing a grid moves its viewer to the end of the DOM; a moved canvas keeps its
WebGL context. A hidden viewer keeps the scene it last showed, draws nothing, and reports
readiness for its own grid; only the shown one has the tools, the snapshot `ref` and `onMark`. A
redo that replaces an image drops its viewer and frees its place. Leaving the page, or picking a
task with no results yet ("No views for … yet"), still unmounts them all.

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
  sent. A 403 or 409 shows the server's text. Signing in does not let a guest reopen their old
  run: the account has a different identity and lab, and only the starter may send. A retry keeps
  the message id and the exact request including its picture, so the server stores it once.
  Submission freezes the task, text, marks and capture before a mutation can pause offline.
  Changing the task, the offer a go accepts, marks,
  text or image/grid makes a new message; moving the camera alone does not replace a retry's
  picture. The submission guard is synchronous, including keyboard/form submissions.
  `ScanReview` owns `useMessage`: draft, prepared retry and pending/error state survive panel
  replacement, closing and Full view. `AiPanel` only renders them; the keyed run page resets them
  when leaving the run, except the draft, which is kept per run in sessionStorage so a reload
  (by hand, or onto a new deploy) keeps it, and cleared by a successful send. Keep capture, retry identity and the submission guard in that page lifetime.
  There is no Redo button: the AI talks a problem through and offers a redo (`reply.offer`);
  "Yes, redo <task>" under its latest reply sends a `go` for that task and nothing else, and stays
  gone once accepted. A message carries the To check item you picked (`itemId`) when the fold lists
  it. A refusal shows the server's own words when it gave some.
- **Your marks** are page state (`useMarking`, `scan-page.tsx`), lost on reload. The tool strip on
  the viewer's bar (`TOOLS` in `marks-panel.tsx`: Navigate, Point, Box, Line, Lasso; Esc, P, B,
  L, O) picks what a click or drag makes (`@voluma/viewer/grid`'s `tool`). Esc first drops a mark
  being drawn, then puts the tool away, then (the shell's) leaves Full view: one thing per press.
  A new mark names the grid's image volume (`TaskGrid.imageId`) and gets a tag (P1, B1, L1, O1);
  its local identity also pins the image hash, grid id, shape and affine. A redo that replaces
  the image cannot inherit its old marks just because it reuses a block id. The viewer draws
  and sends only marks matching that identity; other marks stay listed for inspection/deletion.
  The focus handed to a newly mounted viewer is keyed the same way: it starts at that grid's
  target or centre, never the previous grid's voxel while an effect catches up.
  Marks lists them; a row moves the views to the mark,
  opening its task first when it is on another grid ("on <task>"). At `MAX_MARKS` the tools are
  held off with the reason. A message to the AI carries the marks on the views shown when those
  are its subject's, and a PNG of them (`GridViewer`'s `snapshot`, in the room the rest of the
  body leaves, at most `MAX_MESSAGE_SNAPSHOT_BYTES`); the marks it carried leave the list. A go
  carries neither. The tags reach the AI only through the picture: the contract's marks have no
  names.
- Thread kinds are shown as labels only; nothing here branches on a kind or a role name.
