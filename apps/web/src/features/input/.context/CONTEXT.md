# Input review

One screen, `/studies/:studyId/inputs/:inputId` (the user's theme, dark image wells): one input's
run, live while it goes and for review once it ends, always as the outputs review (below). The
page shows the input's newest run in that study (from the study read, `studyQuery`);
`?run=<runId>` opens an earlier run of it. The study is in the URL because one input can be in
several studies, so the input alone can't pick the run. Links use
`inputHref` (`@voluma/run-view`); they never carry `?run=` unless they mean an earlier run.

## The run's stream and the run read

`use-run-stream.ts` feeds the run's durable events into the run store (`@voluma/run-view`
`RunStoreProvider`, read with `useEvents`); everything on the page is derived from them. `getRun` is polled every 3 s until
the run ends: queue place and state aren't events.

Every connection appends to the same events and resumes with `subscribe(..., after = last seq)`.
It reconnects after a successful message or answer, when the run resumes, and, with a backoff
(1 s to 30 s), when the browser gives up on the stream while the run still goes (an EventSource
closes for good on a non-200 answer, as during a deploy). An ended run's stream closes after its
backlog and stays closed until a message is sent or the run resumes.

## Each grid keeps its viewer

An output is shown on its own grid (`reviewGrid`, `viewer.tsx`'s `SceneViewer`); mouse-oa has two,
the Scan and the tibia long-axis grid. `SceneViewer` keeps one `QuadViewer` per grid shown, at most
two mounted at any commit (`MAX_KEPT`: each holds four WebGL contexts, and Chrome allows 16 per
page), and hides the others (`hidden`). One function, `keep`, decides what is kept, both for what
mounts in a render and for the `kept` state: viewers whose image is still among the blocks, least
recently shown first, the shown one last; the oldest goes past the cap. Each kept entry carries
its viewer's readiness, so an evicted or retired viewer takes its readiness with it. Going back to
a grid is instant: camera, crosshair, window, meshes and slices are as they were. Showing a grid
moves its viewer to the end of the DOM; a moved canvas keeps its WebGL context. Only the shown
viewer has the tools, the snapshot `ref` and `onMark`. A new version that replaces an image drops
its viewer and frees its place.

## Your marks

One store-backed path (`useMarking` over a `MarkStore`, `marking.tsx`): the run's log
(`useRunMarks`), or the page on an example run (`useLocalMarks`), whose writes are refused. Esc
first drops a mark being drawn, then puts the tool away, then (the shell's) leaves Full view: one
thing per press. A new mark names the grid's image volume (`ReviewGrid.imageId`) and gets a tag;
its identity (`gridKeyOf`) also pins the image hash, grid id, shape and affine, so a new version
that replaces the image cannot inherit its old marks just because it reuses a block id. The viewer
draws only marks matching that identity. The focus handed to a newly mounted viewer is keyed the
same way: it starts at that grid's target or centre, never the previous grid's voxel while an
effect catches up.

## The outputs review

`outputs-review.tsx` lays out the shell's two `SidePanel`s around the centre. Left: Conversation (default; badged with the
calls main still holds, `openApprovals`) and Samples (`INPUT_WORD.Many`; the shared `SampleTree`, from `sampleTree`
over `listStudies`). Right: Final outputs (`outputs-panel.tsx`), whose head holds To check (the open items, `OutputsFold.openItems`, whose size is `toCheck`; the "To check" filter lists the rows whose own items are open plus a "Behind the values" row for each open item no value row owns (`rowsToCheck`); a value resting on one keeps its own status and says "rests on a To check") and
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
stays open until Esc. A section's tick waits for every value in it. Until the value has a version or is
marked missing, the centre shows the nearest link on its chain with a version (the scene bar saying
"<value> is based on"), else the output published last whose whole scene has blocks to draw (the scan, from intake
on; the bar saying "Made so far, not final:"), so what the run has made shows as soon as it has; the
run is going and the AI is still setting up only while nothing drawable is published. `studiesQuery` refetches while a run is live, so the Samples tab
(`samples-tab.tsx`) keeps up.

The URL keeps `output` (the value open), `trail` (an output it rests on, open), `item`,
`centre` (`run` for the whole run, `agents`) and `agent` (the agent's thread name open in the agents view; none opens main, else the agent working now, else the first). An `output` that isn't a listed value opens under
the first value resting on it (`show`, also what a click in the whole run does). A published ruler or point in view (an item's own focus wins) puts the slices through its first end once on selecting it, through the one-shot `marking.jump` (not the To check `focus`, so later events and your own panning are left alone), where a Navigate drag can take it; the end is drawn as a dot and shows a grab cursor. The panes'
layout (`QuadLayout`) is page state and holds across grids. A full pane is the shell's Full view
(both sides folded) plus that pane: the page keeps only which view fills and derives the rest
from the shell, so leaving Full view by any means gives the panes back. The whole run folds Final
outputs while it is up and unfolds it after (the shell's `useFoldWhile`); unfolding the strip
during it leaves it. Esc goes, one thing per press: a mark being drawn, the tool, Full view (the shell), the whole
run or agents, an open row. W toggles the whole run. The panes stay mounted (hidden) under the
whole run and the agents. The agents view (`run-agents.tsx`) is a list of agents beside the picked agent's whole thread (header: state, worked clock, outputs reported; body: run-view's `AgentThread`, see its `.context`); `outputs-review.tsx` builds the entries once (`agentEntries`) and hands the same names to the conversation, where inline code in main's replies that is exactly an agent's name opens its thread. The docked bar's tools are `TOOLS` (`marking.tsx`): Navigate
(V), Point with a note (P), Ruler (L), Angle (A), Outline (O), Line, drawn freehand (D: an open path, tag L), Probe (I). Your marks are kept in the run (`run-marks.ts`: `mark.placed` / `mark.deleted` through
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
A finished own-key run holds no key, so `RunAlert` shows a key form (`ReopenKeys`) until this browser has one saved, and every message and answer to such a run carries it (`keysToReopen`).

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
item). It sends through `message-send.ts` (`useIdempotentSend`): a retry keeps the id
and the exact request; refusals show the API's words. A message or an
answer to an ended run reopens it: the page reconnects the stream and reads the run again.

A run with a call open that you can answer (`openApprovals`) reads "Waiting on you" in the heading
(from the log, not the row); a No is final and ends the call. The Samples tree, the Studies list and the
study rows say it too, from `waiting` on the study reads (`studyRunSummarySchema`, `studyInputDetailSchema`): the open calls
(`openApprovals`) counted in the run fold, kept only when the caller can answer (`cannotMessage` null). Waiting on you is its own group, ahead of Needs you, in the Samples tree, the Studies row counts and the study page (`placeOfStatus`, run-view `samples.ts`: one rule, so every count agrees). An answer invalidates the study reads (`useAnswers`), since the run ended and nothing polls them.

