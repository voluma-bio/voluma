# Input review

One screen, `/studies/:studyId/inputs/:inputId` (the user's theme, dark image wells): one input's
run, live while it goes and for review once it ends, always as the outputs review (below). The
page shows the input's newest run in that study (from the study read, `studyQuery`);
`?run=<runId>` opens an earlier run of it. The study is in the URL because one input can be in
several studies, so the input alone can't pick the run. Links use
`inputHref` (`@voluma/run-view`); they never carry `?run=` unless they mean an earlier run.

The shell keeps global destinations separate from `InputBreadcrumb` (Studies / study / sample).
`InputHeading` renders the page h1 outside navigation, explicit Group metadata, run state and
the output fold's outstanding-check count in a compact single row, wrapping only when space
runs out. Run details stays at the right. “Run finished” means computation ended, not that
results are checked. An earlier run is labelled beside its status. Run details holds the source
filename and troubleshooting facts; the study member's `inputLabel` is the page identity.

The Samples tab reads complete `StudyDetail.inputs` from the same current-study query as the
heading, never `StudySummary.newestRuns` (which omits members without runs). `sampleTree` in
run-view uses `inputLabel`/`inputStatus`, including Not started; those rows open and focus the
overview row rather than a no-run review error. Search counts say Showing N of the full total.
All studies returns to the study list; a failed background refresh retains the last membership.

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
draws only marks matching that identity. Visible mark tags in slices and 3D are native selection
buttons (click, Tab then Enter/Space), exposing Delete for your own selection above the viewer.
Activating the selected tag again clears the selection, as does a Navigate click away from tags
and editable endpoints; drags and slice stepping keep it. Deselecting never changes the mark.
The focus handed to a newly mounted viewer is keyed the
same way: it starts at that grid's target or centre, never the previous grid's voxel while an
effect catches up.

## The outputs review

`outputs-review.tsx` lays out the shell's two `SidePanel`s around the centre. Left: Conversation (badged with the
calls main still holds, `openApprovals`), Labels (`labels-panel.tsx`: what each colour in the views is, from the
shown grid's `legend`; a label's volume only from the catalog's one mm³ value measured on that label alone
(`labelVolumes`), else none; and the page's `LabelDisplay`, which hides and fades context labels only, never the
output's own region or a check's; the viewer's bar says how many are hidden, with Show all)
Agents (`run-agents.tsx`: the run's workers, then a picked worker's whole thread with All agents to go back; main is not listed, since Conversation is its thread), and Samples (`INPUT_WORD.Many`; the shared `SampleTree`, from `sampleTree` over the current `StudyDetail.inputs`). The side
opens on Conversation (Jimmy, Nov 4: it is where the researcher steers the AI) and changes tab only when the researcher picks one, or Tell the AI what's wrong or a worker's name in main's thread opens one. Right: Final outputs (`outputs-panel.tsx`), whose head holds To check (the open items, `OutputsFold.openItems`, whose size is `toCheck`: only items of outputs a value rests on; the filter lists the rows with such items of their own) and
Whole run. The panel is a list over the selection's details, each scrolling on its own with a
resize bar between (Jimmy, Nov 4: the old panel opened a value in place, grew under the pointer and
reacted differently per click spot). The list: main's sections of values, "Not in the workflow",
then "Steps behind the values" (`OutputsReview.steps`, every other published output), every row
one line (mark, name, value or "N to check"). Clicking any output's name, in the list or the
details, makes it the selection (`show` in `outputs-review.tsx`: a value is `output`; another
output is `trail` under the value in view when that rests on it, else under the first value
resting on it). Each To check item is drawn and decided in one place: under the output it is
about. A reported value resting on an output with open items shows as in (a tick: Jimmy, Nov 4, the
hollow waiting glyph read as not done), and its details show one line per such output, "N to check
on <output>", which selects it (`rowStatus().waits`; the chip has the same line). The details: name
and value, description, the version line with Report (which holds the kept reason), its own open
items, those lines, and Based on, folded, last (Jimmy: "probably not that important to a
researcher"): the direct links ordered measured on, beside, made from, drawn on, then Earlier
steps. Show on an item opens the output it is about (as `trail` unless it is the value) and frames
the panes on its region; it is a history entry, so Back returns to the item before. Reports and
items are `version-report.tsx`.

The centre has no bar of its own: a chip (`SceneChip`) names the output in view, its value and its
status (with a "To check on <output>" button per output it rests on with open checks), only while Final outputs is folded (open, its selected row says the same; Jimmy, Nov 4). On the panes it sits in
the top-left pane's corner (`QuadViewer`'s `heading`), under the viewer's notes, which stay in the
flow above the panes; over a file, a list, an empty centre or a grid still preparing it sits above,
in the flow. The whole run gets a bar with the way back. Delete mark and Undo delete
get a row above the panes only while one of yours is picked or a deletion can be undone.

While the run goes, Final outputs adds what a run going shows and nothing after it ends: on top,
Running, "last news <age>" (the newest stored event, on a timer) and the latest `activity` sentence
(`run-news.tsx`, unnamed, mounted by `OutputsReview`); each value's "rests on" chain
(`OutputRow.chain`), hollow links ticking as they are published, in its details until its trail is published, then
its Based on; "not yet" for nothing published; "N of M in" in the panel head (the scan header
says only Running), with Needs you only once something does; and the steps list grows as outputs are published. A section's tick waits for every value in it. Until the value has a version or is
marked missing, the centre shows the nearest link on its chain with a version (the scene chip saying
"<value> is based on"), else the output published last whose whole scene has blocks to draw (the scan, from intake
on; the bar saying "Made so far, not final:"), so what the run has made shows as soon as it has; the
run is going and the AI is still setting up only while nothing drawable is published. `studyQuery` refetches while a run is live, so the Samples tab
(`samples-tab.tsx`) keeps up.

The URL keeps `output` (the value open), `trail` (an output it rests on, open), `item`,
`centre` (`run` for the whole run) and `agent` (the agent's thread name open in the Agents tab; none lists them). With no `output`, review opens on the output of the first open check (the bone labels when the checks are about what the values rest on), else the first final output with an open item, else the first. An `output` that isn't a listed value opens under
the first value resting on it (`show`, also what a click in the whole run does). A published ruler or point in view (an item's own focus wins) puts the slices through its first end once on selecting it, through the one-shot `marking.jump` (not the To check `focus`, so later events and your own panning are left alone), where a Navigate drag can take it; the end is drawn as a dot and shows a grab cursor. The panes'
layout (`QuadLayout`) is page state and holds across grids. A full pane is the shell's Full view
(both sides folded) plus that pane: the page keeps only which view fills and derives the rest
from the shell, so leaving Full view by any means gives the panes back. The whole run folds Final
outputs while it is up and unfolds it after (the shell's `useFoldWhile`); showing a panel only
changes its visibility, not the centre. Esc goes, one thing per press: a mark being drawn, the tool, Full view (the shell), the whole
run, an open row, only within its focused workspace and never while typing elsewhere.
Visible Whole run / Back to the views controls switch the centre. The panes stay mounted (hidden) under the
whole run. The Agents tab's thread has a header (state, worked clock, outputs reported) over run-view's `AgentThread` (see its `.context`); `outputs-review.tsx` builds the entries once (`agentEntries`) and hands the same names to the conversation, where inline code in main's replies that is exactly an agent's name opens its thread in the Agents tab. The same links carry each worker's thread ids (`ids`), so a "Started worker" row in the Conversation expands into that worker's thread in place; the Agents tab is unchanged. The docked bar's tools are `TOOLS` (`marking.tsx`), all on the bar as icons named in their
tooltips (Jimmy, Nov 4): Navigate, Point, Ruler, Angle, Outline, Freehand line (an open path, tag L) and Probe (`viewer.tsx`).
They have no command-key bindings. Point notes have no editor or display; old stored
note fields remain readable and intact when a mark moves or is restored. Probe values still show.
Your marks are kept in the run (`run-marks.ts`: `mark.placed` / `mark.deleted` through
`POST`/`DELETE /api/review/runs/:runId/marks`, folded from the stream; a write shows at once, and an example run keeps them in the page only). Everyone who opens the run sees them; others' have no delete. Save view posts `view.saved`
(`POST /api/review/runs/:runId/views`). The viewer bar's Views menu holds Save this view and
every view saved in the run, of any output, each named with its output and time; picking one opens
that output (`show`) and the view on its grid (#594: the old menu only showed the in-view output's
views, and only while Final outputs was folded). The Conversation does not list views: main never
receives one (Jimmy, Nov 4). The trail's data is `@voluma/run-view`
`outputs-trail.ts`.

### Talking to main (`main-conversation.tsx`, `use-main-message.ts`)

The conversation is the only place anything on the run changes (design review.md, "Corrections",
"Approvals"). It is main's whole thread (Jimmy, Nov 4: the filtered chat hid the AI's working, which
a researcher needs to trust a number): run-view's `AgentThread` over main's ids with
`conversation` set. Main's words are one voice, "The AI" (its prose and its `message` calls to you
alike; Jimmy: a proper conversation, as in Claude.ai), the workers it starts and the outputs it
reports are rows of their own, its other tool runs fold closed under its `activity` lines, its
instructions and the run's news fold quieter, and a worker's name opens its thread in Agents in one
click (the tab switches once the URL's `agent` lands: the router applies URL changes in a
transition, after the click's own state). The page puts
in, by log position (`slots`), what the thread doesn't hold: your messages with the marks they
carried (each `person` slot, which takes what main got with it as a quiet disclosure), a request
that didn't finish, and the calls main holds for your yes (`ApprovalCard`, `@voluma/run-view`: what the
call does in code's words, what it changes and what it makes out of date, by catalog name; Yes and No with optional words through
`answerApproval`; then the answer, and only the outcome's word: `approval.settled`'s text is
written for main); a held call has no row of its own but its card. `conversation()` (contracts)
gives those items; main's words are the thread. It opens at the newest line. The live line says only what is true of the run (Jimmy, Nov 4:
a queued run said "The AI is on it"): queued, "Waiting to start · place N in line" with no pulse;
running with main working, main's newest `activity` line this turn (or "Working"); running with a
call you approved and main idle (its job runs outside any thread), "Doing what you approved";
otherwise none.
A finished own-key run holds no key, so `RunAlert` shows a line (`ReopenKeys`) saying whether this browser has the user's keys saved, with a link that opens Settings to add them; every message and answer to such a run carries them (`keysToReopen`).

**Editing a mark is a correction, and nothing reaches main until Send.** A new mark, a moved one
(Navigate: drag an end of your point, line or angle in a slice; a click on an end picks the mark),
a deleted one (the visible Delete mark action on your picked mark) and a published ruler's end dragged (a new
line mark of yours, tag R<n>, `output` the ruler's) are written to the log at once and wait as chips
beside the box. Which marks wait is derived, never kept: `useRunMarks`'s `changes` judges each of your
marks by the API's own rule (`toldMarks`, `changeOf` in `review-state.ts`): a mark no message of
yours carried, one changed since, and one main was told of that you deleted. Someone who can't
write to main sees no waiting chips.
x on a chip undoes the change (a new mark goes; a moved or deleted one goes back to what main saw).
This is distinct from Undo delete: the persistent session action restores the exact immediately
pre-delete mark, including unsent edits, through `place` and the existing per-mark write queue.
Undo stays available after a failed restore; a replaced image cannot inherit the old mark.
It offers the newest still-restorable deletion; replaced grids or marks restored elsewhere do not
block older deletions. Successful Undo returns to the mark's output and slice and focuses Delete.
Restoring after Send is a new correction, not a retraction of the sent message. Reloading or leaving
the run clears deletion history. No mark undo keyboard binding is installed.
Nothing is written into the box: main gets each attached mark with its change and positions, and
the placeholder stays a writing prompt instead of repeating the mark chips. Tags are never reused in a run (`MarkStore.tags`): a message
may name a deleted one. A send waits for the writes of the marks it names (`settled`), since the API
freezes them from the log; if one failed, nothing is sent.

A message carries the words, the waiting marks by id (`markIds`; the API freezes them), the output
in view (`output`), the panes' view as Save view keeps it (`view`, dropped over `MAX_VIEW_BYTES`), a
PNG of the panes when "With <output>, as you see it" is on (`QuadViewerHandle.snapshot` through
`SceneHandle`), and the To check item it answers (`toCheck`, set by "Tell the AI what's wrong" on an
item). It sends through `message-send.ts` (`useIdempotentSend`): a retry keeps the id
and the exact request; refusals show the API's words. A message or an
answer to an ended run reopens it: the page reconnects the stream and reads the run again.

A run with a call open that you can answer (`openApprovals`) reads "Waiting on you" in the heading
(from the log, not the row); a No is final and ends the call. The Samples tree, the Studies list and the
study rows say it too, from `waiting` on the study reads (`studyRunSummarySchema`, `studyInputDetailSchema`): the open calls
(`openApprovals`) counted in the run fold, kept only when the caller can answer (`cannotMessage` null). Waiting on you is its own group, ahead of Needs you, in the Samples tree, the Studies row counts and the study page (`placeOfStatus`, run-view `samples.ts`: one rule, so every count agrees). An answer invalidates the study reads (`useAnswers`), since the run ended and nothing polls them.
