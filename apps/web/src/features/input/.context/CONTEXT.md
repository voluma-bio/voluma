# Input review

One screen, `/studies/:studyId/inputs/:inputId` (the user's theme, dark image wells): one input's run, live while it goes and for review once
it ends. The page shows the input's newest run in that study (from the study read, `studyQuery`); `?run=<runId>` opens an earlier run of it. The study is in the URL because one input can be in several studies, so the input alone can't pick the run. A run of the agent loop gets the outputs review (last section). A task-loop run keeps the
review below, inside the shell's rail. The grid viewer fills the main area; Study, To check, Report and Agents dock on the left, View,
Marks and The AI on the right (`ShellPanel`s, shortcuts s, t, r, a, v, m, i (c on agent-loop runs); Marks only while you have a mark). Study replaces the left panel
without navigating; To check keeps its URL selection and panel scroll position when reopened.
Each visit to an input opens To check and The AI, including after Home or a reload. Panel choices
last only for that visit; the shell saves widths and stacked splits, not open panels.
Study highlights the current input and links to the study overview only when it has multiple inputs:
a study of one redirects to its input, so neither this panel nor the breadcrumb links there.
`/scans/:runId`, `/runs/:id/live` and
`/runs/:runId` redirect here (`index.tsx` reads the run for its study and input, and adds `?run=` only when the run isn't the input's newest), keeping their search. Links use `inputHref` and `itemHref`
(`@voluma/run-view`); they never carry `?run=` unless they mean an earlier run.

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

A task is shown on its own grid (`reviewGrid`); mouse-oa has two, the Scan and the aligned tibia
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
  There is no Redo button: the AI talks a problem through and offers a redo (`reply.offer`).
  This offer/go flow is the interim: review moves to one conversation with the scan's main agent,
  with no button outside it and no "redo" in researcher-facing text (`.context/decisions.md`,
  2026-10-31, two modes; issue #400). Build nothing new on the offer/go flow.
  "Yes, redo <task>" and "No, keep it" under the open offer (`openOffer`: the AI's latest reply,
  with no message of the person's after it; an outcome after it leaves it open) never send on
  their own: they make the box an answer to that offer, where the person can add detail. Send
  sends a `go` on the task with the words, or a message on the task (the words, else
  "No, keep it."). The answer is page state, never written into the box, so the saved draft holds
  only the person's words. An answer carries no picture and no marks. The buttons stay gone once
  answered, and the answer drops once the offer is no longer open. A message carries the To check item you picked (`itemId`) when the fold lists
  it, and the task in view as `taskId`: the AI is told the person was reviewing it, and the chat
  labels it "on <task>", never "about". A refusal shows the server's own words when it gave some.
- **How a correction ended** is the AI's last item in the chat (`conversation`'s `outcome`): the
  root's closing summary ("Redid <task>" with a link to it when another is in view, only when an
  attempt of the task opened after the go; else "Done"), or
  the failure or stop and its reason, with the note that the task's earlier results stand. The
  running mark ("The AI is answering", "Redoing <task>") shows only while the run has not ended
  and the latest message has no outcome after it.
- **Your marks** go through one store-backed path (`useMarking` over a `MarkStore`): the task
  review's are page state (`useLocalMarks(MAX_MARKS)`, `input-page.tsx`), lost on reload; the
  outputs review's are the run's log (`useRunMarks`), an example run's page state, uncapped. The tool strip on
  the viewer's bar (`TOOLS` in `marks-panel.tsx`: Navigate, Point, Box, Line, Lasso; Esc, P, B,
  L, O) picks what a click or drag makes (`@voluma/viewer/grid`'s `tool`). Esc first drops a mark
  being drawn, then puts the tool away, then (the shell's) leaves Full view: one thing per press.
  A new mark names the grid's image volume (`ReviewGrid.imageId`) and gets a tag (P1, B1, L1, O1);
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

## The outputs review (agent-loop runs)

`outputs-review.tsx`, for a run whose log has final outputs (`isAgentsRun`). It lays out the
shell's two `SidePanel`s around the centre. Left: Conversation (default; badged with the
calls main still holds, `openApprovals`) and Samples (`INPUT_WORD.Many`; the shared `SampleTree`, from `sampleTree`
over `listStudies`). Right: Final outputs (`outputs-panel.tsx`), whose head holds Needs you and
Whole run. The value picked opens in place under its row: its version line and Report, its open
To check items (with those of what it rests on), and Rests on (direct links, ordered measured
on, beside, made from, drawn on) with Further back (the rest of `trailOf`, nearest first, each
saying which row it feeds). A row there opens its report under it and frames the panes on it;
the value's items carried by that row shrink to one line. Reports and items are
`version-report.tsx`.

While the run goes, Final outputs adds what a run going shows and nothing after it ends: on top,
Running, "last news <age>" (the newest stored event, on a timer) and the latest `activity` sentence
(`run-news.tsx`, unnamed, mounted by `OutputsReview`); each value's "rests on" chain
(`OutputRow.chain`), hollow links ticking as they are published, under its row (under an opened value only until its trail is published, then
its Rests on); "not yet" for nothing published; "N of M in" in the panel head (the scan header
says only Running), with Needs you only once something does; and "Other outputs so far" under the
values (`OutputsReview.others`), each opening like a Rests on row; one open when the run ends
stays open until Esc. A section's tick waits for every value in it. The centre says the run is going and the
AI is still setting up (its plan comes in the conversation) until the value has a version, is marked missing, or something
on its chain has a version; then it shows the nearest such link, the scene bar saying "<value>
rests on". `studiesQuery` refetches while a run is live, so the Samples tab
(`samples-tab.tsx`) keeps up.

The URL keeps `output` (the value open), `trail` (an output it rests on, open), `item` and
`centre` (`run` for the whole run, `agents`). An `output` that isn't a listed value opens under
the first value resting on it (`show`, also what a click in the whole run does). A published ruler or point in view (an item's own focus wins) puts the slices through its first end (`rulerFocus`, `focusPoint`), where a Navigate drag can take it; the end is drawn as a dot and shows a grab cursor. The panes'
layout (`QuadLayout`) is page state and holds across grids. A full pane is the shell's Full view
(both sides folded) plus that pane: the page keeps only which view fills and derives the rest
from the shell, so leaving Full view by any means gives the panes back. The whole run folds Final
outputs while it is up and unfolds it after (the shell's `useFoldWhile`); unfolding the strip
during it leaves it. Esc goes, one thing per press: a mark being drawn, the tool, Full view (the shell), the whole
run or agents, an open row. W toggles the whole run. The panes stay mounted (hidden) under the
whole run and the agents. The docked bar's tools are `QUAD_TOOLS` (`marks-panel.tsx`): Navigate
(V), Point with a note (P), Ruler (L), Angle (A), Outline (O), Probe (I). Your marks are kept in the run (`run-marks.ts`: `mark.placed` / `mark.deleted` through
`POST`/`DELETE /api/review/runs/:runId/marks`, folded from the stream; a write shows at once, and an example run keeps them in the page only). Everyone who opens the run sees them; others' have no delete. Save view posts `view.saved`
(`POST /api/review/runs/:runId/views`); the conversation lists each one and the scene bar's
"Saved views" menu reopens it on its grid. The trail's data is `@voluma/run-view`
`outputs-trail.ts`.

### Talking to main (`main-conversation.tsx`, `use-main-message.ts`)

The conversation is the only place anything on the run changes (design review.md, "Corrections",
"Approvals"). It shows main's messages to the researcher, yours with the marks they carried, the
views you saved and the calls main holds for your yes (`ApprovalCard`, `@voluma/run-view`: what the
call does in code's words, what it changes and what it makes out of date, by catalog name; Yes and No with optional words through
`answerApproval`; then the answer, and only the outcome's word: `approval.settled`'s text is
written for main). `conversation()` (contracts)
gives the items. While the run is live and the last word was yours, "main is on it".

**Editing a mark is a correction, and nothing reaches main until Send.** A new mark, a moved one
(Navigate: drag an end of your point, line or angle in a slice; a click on an end picks the mark),
a deleted one (Delete or Backspace on the picked mark) and a published ruler's end dragged (a new
line mark of yours, tag R<n>, `output` the ruler's) are written to the log at once and wait as chips
beside the box. Which marks wait is derived, never kept: `useRunMarks`'s `changes` judges each of your
marks by the API's own rule (`toldMarks`, `changeOf` in `review-state.ts`): a mark no message of
yours carried, one changed since, and one main was told of that you deleted. Someone who can't
write to main sees no waiting chips.
x on a chip undoes the change (a new mark goes; a moved or deleted one goes back to what main saw).
Nothing is written into the box: main gets each attached mark with its change and positions, and
the empty box shows what the marks say. Tags are never reused in a run (`MarkStore.tags`): a message
may name a deleted one. A send waits for the writes of the marks it names (`settled`), since the API
freezes them from the log; if one failed, nothing is sent.

A message carries the words, the waiting marks by id (`markIds`; the API freezes them), the output
in view (`output`), the panes' view as Save view keeps it (`view`, dropped over `MAX_VIEW_BYTES`), a
PNG of the panes when "With <output>, as you see it" is on (`QuadViewerHandle.snapshot` through
`SceneHandle`), and the To check item it answers (`toCheck`, set by "Tell main what's wrong" on an
item). Both composers send through `message-send.ts` (`useIdempotentSend`): a retry keeps the id
and the exact request; refusals show the API's words. A message or an
answer to an ended run reopens it: the page reconnects the stream and reads the run again.

A run with a call open that you can answer (`openApprovals`) reads "Waiting on you" in the heading
(from the log, not the row); a No is final and ends the call. The Samples tree, the Studies list and the
study rows say it too, from `waiting` on the study reads (`studyRunSummarySchema`, `studyInputDetailSchema`): the open calls
(`openApprovals`) counted in the run fold, kept only when the caller can answer (`cannotMessage` null). Waiting on you is its own group, ahead of Needs you, in the Samples tree, the Studies row counts and the study page (`placeOfStatus`, run-view `samples.ts`: one rule, so every count agrees). An answer invalidates the study reads (`useAnswers`), since the run ended and nothing polls them.

