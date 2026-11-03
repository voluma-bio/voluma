# Study feature

Studies (`/`, `studies-page.tsx`), Run on new scans (`/new`, `new-page.tsx`), Workflows
(`/workflows`, `workflows-page.tsx`) and a study's two pages (`/studies/:id` and
`/studies/:id/compare`, `study/`). On screen one scanned knee is a **sample** (agent-model `review.md`,
Naming: the mouse-OA workflow's noun). Write the word only through `INPUT_WORD` (`@voluma/ui`), so
a rename is one edit; code names and routes say `input` (`/studies/:id/inputs/:inputId`) and don't change with it. Every run
belongs to a study (`@voluma/contracts/study`); a study of one is a study whose input count is 1,
shown as its input and linked straight to its page (`/studies/:id/inputs/:inputId`, `inputHref`). `/scans/:runId` and `/runs/:runId(/live)` redirect to it (`features/input/index.tsx`).
The deleted study pages' paths redirect (`index.tsx`): `check` to `?status=needs-you`, `results` to
Compare, `scans`, `details` and `workflow` to the study. Links to them are out in the world (the
hackathon judges' notes link the example's study), so keep these until there is a reason not to.

- **Studies** (design: the agent-model `review.md`, "The shell and the study pages"; mockup
  `q24/c-quad-graph/study.html`) is a list with a details pane, like a file browser: a click
  selects a study and the right side describes it; the chevron, a double-click, Enter or "Open
  study" opens it. The list reads `listStudies` alone (each scan's newest run in brief), refetched
  every 5 s while a run is live; the pane reads the selected study's `getStudy`, which polls the
  same way once it holds a live run (both rules live in `studiesQuery`/`studyQuery`), and refetches
  when the list shows a new live run. A scan's
  picture is `Thumbnail` on its newest run's `runThumbnailUrl`, in the study's rows and the
  pane's Scans block (not in the Studies list rows). The API renders it once per run generation
  (`apps/api/src/domains/review/thumbnail.ts`), so a row costs one cached image request, never a
  3D view; a run with nothing converted yet gets 204 and the plain tile.
- **A scan's place** (`placeOf`): Needs you (To check, paused for keys, failed or stopped),
  Running (live or queued), Done, then Not started (no run). The group comes from one function,
  `placeOfStatus(status, example)` in run-view, which the tree, the Studies counts, the study
  page, Compare and "Next scan that needs you" all use, so a scan sits in the same group
  everywhere; an example's scans are always Done, since nobody can change an example.
  `?status=<place>` shows one group, on the study page and on Compare.
- **A sample's bar** (`SampleBar`, rule in `study-model.ts`'s header and `segmentOf`): one segment
  per measurement of the workflow (29 for mouse OA today, the mockup's "28" plus bone threshold),
  in task order, each from the study read's own fields: its task's state in the newest run
  (`taskState`, `needsYou`), and whether the newest completed run reported a value. An agent-loop
  run (`harness: agents`) has no tasks: its segments come from its final outputs' status
  (`outputStatus`, from the API's output fold), and a measurement outside its final outputs reads
  as outside the plan. A run with neither yet has no bar rather than an invented one. Its values
  are its final values, in the units `outputs.json` writes (`unitAsWritten`), so Compare and the
  headline read them as they read the task loop's.
- **Recent activity** is built from the runs' own times (created, started, ended, reviewed); the
  study read has no event feed, so To check raised and corrections are not lines yet.
- **Run on new scans** keeps no outputs checklist and no notes: a study runs every output (the
  request sends no `selectedOutputs`). Grouping dropped files into scans is `input-files.ts` (the
  rule is its header); intake (mouse, knee, group from names and the sample sheet, no AI) is
  `intake.ts`, mouse-OA specific: the knee is stored as `attributes.knee`. With several scans,
  every row needs mouse, knee and group before Start; one scan needs none.
- **No page state at frame rate on `/new`**: intake is memoized on the scan names and the sheet,
  and upload bytes live in `uploads.ts`'s progress store, read only by each scan's `UploadBar`.
  A study-sized drop re-ran intake for every row on every progress frame before.
- **Task text** for researchers is each task's `summary` in `tasks.json`, shown in See tasks and
  on Workflows; a task without one shows its title and measurements. Never show `instructions`:
  they are the agent's (paths, skill names). See tasks links to Workflows in a new tab, since
  leaving `/new` drops its uploads.
- **Uploads** (`uploads.ts`) run one scan at a time under the server's open-upload limit, so a
  study of many never hits its 429; the old single-scan panel's machinery (4 PUTs at once, 3
  tries, Retry of the failed files, complete, cancel) lives there. Start pressed during uploads
  arms the page: it starts when the last upload completes and disarms if one fails or the last
  scan is removed. Leaving the page aborts and cancels unfinished uploads. A deploy's reload
  (`shell/deploys.ts`) waits on `holdLeave` while a scan uploads, a start is armed, or
  `createStudy` is in flight.
- **Pilot**: with more than two scans the default is "Run 2 first": the first scan of each of the
  first two groups, else the first two. The rest wait with no run; the study page starts them.
- **Time and cost** shown before Start come only from the lab's newest completed run of the
  workflow, not a seeded example (its wall time and `usage.modelCostUsd`); with none, nothing is shown. There is no
  budget cap, so the page never says a run stops at one.
- **Excel sample sheets**: `xlsx.ts` reads the first worksheet with `fflate` (unzip) and
  `DOMParser`, loaded only when an `.xlsx` is dropped.
- **Shared with `features/input`** through `@voluma/run-view`: the run status words
  (`runStatus`, a word and a `StatusMark` state: Running, N to check, Checked, Reviewed, Failed,
  Stopped, Waiting, Needs your keys (paused)), `liveStatus` ("Task N of M" while a task-loop run runs, "Running · N of M in" while an agent-loop
  run does, from `outputs`, its final outputs in),
  `inputStatus` (a sample's: its newest run's, "Not started" with no run), the Samples tree's data
  (`sampleTree`), the run and item links, `ItemToCheck`, the formatters (`whenText` included), and visitor keys.
  `runStatus` and `inputHref` take a run's `state` and `review`. A `newestRuns` entry and a study
  scan's `review` hold it for either loop (an agent-loop run's final outputs that need a person, `needingYou`, the sample page's "Needs you" count, worded "N to check" by `toCheckText`; a group of samples says its unit, "1 sample needs you", so a count of items and a count of samples never read alike);
  a full `Run`'s `review` is the task loop's only, so `inputStatus` reads the scan's. Every page uses this mapping; don't add another.
- **A study's pages** sit under `study/study-layout.tsx`, which loads the study once, renders the
  header line (breadcrumb, "Next scan that needs you") and the scan tree on the left side
  (`SidePanel`, `SampleTree` from `@voluma/ui`), and hands the study to each page through
  `useStudy`. A page renders the centre and, if it has one, its right side beside the tree. They
  derive everything from one `StudyDetail` in `study/study-model.ts` (pure; its header states the
  far-from-group rule, the unit rule and the bar). Nothing on them judges or changes a result:
  every row, cell and dot opens the scan review (Compare's cells at their task, `?task=`).
- **Task states come from the server**: the study read's `taskState` per scan is `taskStates`
  (`@voluma/contracts/review-state`) over the scan's newest run, the rule the scan review uses.
  It takes the run's state and threads and derives the rest itself. During a correction both read
  the correction's own revision (`openCorrectionRevision` on the server), while the study's values
  and open checks stay on the last completed result. Don't re-derive a task's state here; a
  workflow task missing from it is outside the run's plan. Each task's items that need a person
  come with it (`needsYou`, counted as the scan review counts them, from the same run), and
  `shownStatus` turns state and count into the status every page shows.
- **To check means needs you.** Two counts, named apart in contracts: `needsYou` (what needs a
  person: open checks plus the card of a To check task with no check, such as one the second AI
  sent back) is what every "N to check" reads: a scan's status and "Next scan that needs you"
  (`inputNeedsYou` / `needsYouOf`). `acceptable` is only what "Looks right" can accept, which only
  the scan review offers; here it gives a sample's line its items' titles (`waitsOn`, with each
  card nobody can accept as "<task>: <why>"). A live or stopped rerun's items show on its tasks,
  not in the counts.
- **Links into the scan review**: a sample opens at `inputHref`; a Needs you sample opens at its
  first open item (`reviewHref`, `itemHref`: `?task=&item=`), so the review shows exactly that
  item. Adding scans to an existing study isn't designed, so there is no
  "Add scans". The knee reads from `attributes.knee`, as intake stores it.
- **"N to check" on a row is a `StatusMark`** (status check); `Count` is only a bare number
  beside a heading.
