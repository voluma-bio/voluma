# Study feature

Studies (`/`, `studies-page.tsx`), Run on new samples (`/new`, `new-page.tsx`), Workflows
(`/workflows`, `workflows-page.tsx`) and a study's two pages (`/studies/:id` and
`/studies/:id/compare`, `study/`). On screen one scanned knee is a **sample** (agent-model `review.md`,
Naming: the mouse-OA workflow's noun). Write the word only through `INPUT_WORD` (`@voluma/ui`), so
a rename is one edit; code names and routes say `input` (`/studies/:id/inputs/:inputId`) and don't change with it. Every run
belongs to a study (`@voluma/contracts/study`); a study of one is a study whose input count is 1,
shown as its input and linked straight to its page (`/studies/:id/inputs/:inputId`, `inputHref`).

- **Studies** (design: the agent-model `review.md`, "The shell and the study pages"; mockup
  `q24/c-quad-graph/study.html`) is a list with a details pane, like a file browser: a click
  selects a study and the right side describes it; the chevron, a double-click, Enter or "Open
  study" opens it. The list reads `listStudies` alone (each input's newest run in brief), refetched
  every 5 s while a run is live; the pane reads the selected study's `getStudy`, which polls the
  same way once it holds a live run (both rules live in `studiesQuery`/`studyQuery`), and refetches
  when the list shows a new live run. A sample's
  picture is `Thumbnail` on its newest run's `runThumbnailUrl`, in the study's rows and the
  pane's Samples block (not in the Studies list rows). The API renders it once per run generation
  (`apps/api/src/domains/review/thumbnail.ts`), so a row costs one cached image request, never a
  3D view; a run with nothing converted yet gets 204 and the plain tile.
- **A sample's place** (`placeOf`): Needs you (To check, paused for keys, failed or stopped),
  Running (live or queued), Done, then Not started (no run). The group comes from one function,
  `placeOfStatus(status, example)` in run-view, which the tree, the Studies counts, the study
  page, Compare and "Next sample that needs you" all use, so a sample sits in the same group
  everywhere; an example's samples are always Done, since nobody can change an example.
  `?status=<place>` shows one group, on the study page and on Compare.
- **Measurements, names and units** come from the workflow's `outputs.yaml`, bundled
  (`outputCatalogOf`, through `measurementsOf` in `workflow-measurements.tsx`): every `value`
  entry, in catalog order, with its UCUM unit written as people write it (`unitAsWritten`), the
  form the study read carries values in. Headlines are the entries marked `headline`. The catalog
  has no grouping, so the bar and Compare list measurements flat.
- **A sample's bar** (`SampleBar`, rule in `study-model.ts`'s header and `segmentOf`): one segment
  per measurement of the workflow (29 for mouse OA today), in catalog order, each from the newest
  run's final outputs' status (`outputStatus`, from the API's output fold) and whether a value was
  reported; a measurement outside the run's final outputs reads as outside its plan. A run with no
  final outputs listed yet has no bar rather than an invented one.
- **Recent activity** is built from the runs' own times (created, started, ended); the
  study read has no event feed, so To check raised and corrections are not lines yet.
- **Run on new samples** keeps no outputs checklist and no notes: a study runs every output (the
  request sends no `selectedOutputs`). Grouping dropped files into scans is `input-files.ts` (the
  rule is its header); intake (mouse, knee, group from names and the sample sheet, no AI) is
  `intake.ts`, mouse-OA specific: the knee is stored as `attributes.knee`. With several scans,
  every row needs mouse, knee and group before Start; one scan needs none.
- **No page state at frame rate on `/new`**: intake is memoized on the scan names and the sheet,
  and upload bytes live in `uploads.ts`'s progress store, read only by each scan's `UploadBar`.
  A study-sized drop re-ran intake for every row on every progress frame before.
- **See measurements** on `/new` and the Workflows page list the workflow's measurements by name
  and unit. Never show a catalog entry's `description` or `expect`: they are written for the agents
  (paths, label numbers, deck references). See measurements links to Workflows in a new tab, since
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
  (`runStatus`, a word and a `StatusMark` state: Running, N to check, Checked, Failed,
  Stopped, Waiting, Needs your keys (paused)), `liveStatus` ("Running · N of M in" while a run
  runs, from `outputs`, its final outputs in),
  `inputStatus` (a sample's: its newest run's, "Not started" with no run), the Samples tree's data
  (`sampleTree`), `inputHref`, the formatters (`whenText` included), and visitor keys.
  `runStatus` takes a run's `state` and its review in brief: a `newestRuns` entry's or a study
  input's `review` (the run's open To check items on its final outputs and what they rest on,
  `OutputsFold.toCheck`, the sample page's "To check" count, worded "N to check" by `toCheckText`;
  a group of samples says its unit, "1 sample needs you", so a count of items and a count of
  samples never read alike). Every page uses this mapping; don't add another.
- **A study's pages** sit under `study/study-layout.tsx`, which loads the study once, renders the
  header line (breadcrumb, "Next sample that needs you") and the Samples tree on the left side
  (`SidePanel`, `SampleTree` from `@voluma/ui`), and hands the study to each page through
  `useStudy`. A page renders the centre and, if it has one, its right side beside the tree. They
  derive everything from one `StudyDetail` in `study/study-model.ts` (pure; its header states the
  far-from-group rule, the unit rule and the bar). Nothing on them judges or changes a result:
  every row, cell and dot opens the input review (Compare's cells on their measurement, `?output=`).
- **To check means needs you.** `toCheck` in the study read (the newest completed
  run's open To check items, each once: a value that only rests on one is not counted; it keeps its
  own status and says "rests on a To check") is what every "N to check" reads: a sample's status
  and "Next sample that needs you" (`needsYouOf`).
- **Links into the input review**: a sample opens at `inputHref`. Adding samples to an existing study isn't designed, so there is no
  "Add samples". The knee reads from `attributes.knee`, as intake stores it.
- **"N to check" on a row is a `StatusMark`** (status check); `Count` is only a bare number
  beside a heading.
