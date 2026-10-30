# Study feature

Home (`/`, `home-page.tsx`), Run on new scans (`/new`, `new-page.tsx`), Workflows
(`/workflows`, `workflows-page.tsx`) and the study page (`/studies/:id`, `study-page/`) under
`StudyLayout` (their query client). Every run
belongs to a study (`@voluma/contracts/study`); a study of one is a study whose scan count is 1,
shown as its scan and linked straight to its run.

- **Home's data** is `listStudies` alone: each study carries each scan's newest run in brief
  (`newestRuns`: run id, state, a live run's tasks done, a completed run's `review`) and its
  `scansCompleted` and `toCheck`. It refetches every 5 s while any newest run is live. `toCheck`
  is each scan's newest *completed* run's open checks, which stay acceptable while that scan
  reruns, so they still ask for the researcher (a study of one too). "Across M scans" shows
  only when the newest runs hold every open check; under a rerun M is unknowable from
  `newestRuns`, so the row says just "N to check."
  Needs you has one row per study with one action; example studies are read-only and ask nothing.
  "Last activity" is a relative day, never a time.
- **Run on new scans** keeps no outputs checklist and no notes: a study runs every output (the
  request sends no `selectedOutputs`). Grouping dropped files into scans is `scan-files.ts` (the
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
  scan is removed. Leaving the page aborts and cancels unfinished uploads.
- **Pilot**: with more than two scans the default is "Run 2 first": the first scan of each of the
  first two groups, else the first two. The rest wait with no run; the study page starts them.
- **Time and cost** shown before Start come only from the lab's newest completed run of the
  workflow, not a seeded example (its wall time and `usage.modelCostUsd`); with none, nothing is shown. There is no
  budget cap, so the page never says a run stops at one.
- **Excel sample sheets**: `xlsx.ts` reads the first worksheet with `fflate` (unzip) and
  `DOMParser`, loaded only when an `.xlsx` is dropped.
- **Shared with `features/run`** through `@voluma/run-view`: the run and study status words
  (`runStatus`, `studyStatus`, each a word and a `StatusMark` state: Running, N to check, Checked, Reviewed, Failed,
  Stopped, Waiting, Needs your keys, Not started), the run link, the formatters, and visitor
  keys. `runStatus`, `studyStatus` and `runHref` take a run's `state` and `review`, which a full
  `Run` and a `newestRuns` entry both carry; a study of one reads as `runStatus` of its run.
  "Not started" is only a scan
  with no run; a stopped one reads "N stopped", joined with the
  rest ("1 stopped, 1 not started"). A study reads "Reviewed" once every scan's newest run is
  completed and reviewed. The study page uses
  the same mapping; don't add another.
- **The study page** derives everything from one `StudyDetail` in `study-page/study-model.ts`
  (pure; its header states the far-from-group rule and the unit rule). Every "Open in 3D" calls
  `StudyPage`'s `openChecks`, the check panel's one mount point; pass a real panel there rather
  than adding links. Adding scans to an existing study isn't designed, so the page has no
  "Add scans". The knee reads from `attributes.knee`, as intake stores it.
