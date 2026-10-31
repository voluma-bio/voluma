# Study feature

Home (`/`, `home-page.tsx`), Run on new scans (`/new`, `new-page.tsx`), Workflows
(`/workflows`, `workflows-page.tsx`) and a study's pages (`/studies/:id/*`, `study/`). Every run
belongs to a study (`@voluma/contracts/study`); a study of one is a study whose scan count is 1,
shown as its scan and linked straight to its scan review (`/scans/:runId`, `runHref`).

- **Home's data** is `listStudies` alone: each study carries each scan's newest run in brief
  (`newestRuns`: run id, state, a live run's tasks done, a completed run's `review`) and its
  `scansCompleted` and `needsYou`. It refetches every 5 s while any newest run is live.
  `needsYou` sums each scan's `scanNeedsYou`: its newest run's items when that run completed,
  else its newest completed run's acceptable checks, which still ask for the researcher while
  the scan reruns (a study of one too). "Across M scans" shows only when the newest runs hold
  every item; under a rerun M is unknowable from `newestRuns`, so the row says just "N to check."
  Needs you has one row per study; example studies are read-only and ask nothing. Running
  lists only scans whose run is running, then "N waiting to start" for queued ones; a run
  waiting for keys is in Needs you.
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
- **Shared with `features/scan`** through `@voluma/run-view`: the run and study status words
  (`runStatus`, `studyStatus`, each a word and a `StatusMark` state: Running, N to check, Checked, Reviewed, Failed,
  Stopped, Waiting, Needs your keys (paused), Not started), `liveStatus` ("Task N of M"
  while running), the run and item links, the Study panel and `ItemToCheck`, the formatters, and visitor
  keys. `runStatus`, `studyStatus` and `runHref` take a run's `state` and `review`, which a full
  `Run` and a `newestRuns` entry both carry; a study of one reads as `runStatus` of its run.
  "Not started" is only a scan
  with no run; a stopped one reads "N stopped", joined with the
  rest ("1 stopped, 1 not started"). A study reads "Reviewed" once every scan's newest run is
  completed and reviewed. The study page uses
  the same mapping; don't add another.
- **A study's pages** (Dashboard, To check, Scans, Results, Details, and the workflow expanded)
  are pages on the left strip under `study/study-layout.tsx`, which loads the study once and
  hands it to each page through `useStudy`. They derive everything from one `StudyDetail` in
  `study/study-model.ts` (pure; its header states the far-from-group rule and the unit rule).
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
  sent back) is what every "N to check" reads: Home, the scan's status, Needs you, the To check
  page and the nav count (all `scanNeedsYou` / `needsYouOf`), and the cells. `acceptable` is
  only what "Looks right" can accept: the cards on the To check page, item titles, and the Mark
  reviewed gate. A card nobody can accept is listed by its task and why (`cardsOf`) and opens the
  scan review on it. A live or stopped rerun's items show on its tasks, not in the counts.
- **Links into the scan review**: a scan opens at `runHref`; a To check item opens at
  `itemHref` (`?task=&item=`), so the review shows exactly that item. `reviewHref` picks a
  scan's first open item. Adding scans to an existing study isn't designed, so there is no
  "Add scans". The knee reads from `attributes.knee`, as intake stores it.
- **"N to check" on a row is a `StatusMark`** (status check); `Count` is only a bare number
  beside a heading.
