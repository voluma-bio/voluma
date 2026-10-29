# Study feature

Home (`/`, `home-page.tsx`), Run on new scans (`/new`, `new-page.tsx`) and Workflows
(`/workflows`, `workflows-page.tsx`) under `StudyLayout` (their query client). The study page
(`/studies/:id`) joins these routes; until it does, a multi-scan study's link 404s. Every run
belongs to a study (`@voluma/contracts/study`); a study of one is a study whose scan count is 1,
shown as its scan and linked straight to its run.

- **Home's data** is `listStudies` plus `listRuns`. The summary has no run ids, so the runs say
  which run a study of one opens, which runs failed or wait for keys, and a live run's tasks done
  (`Run.tasks`, counted by the API from the plan). Both refetch every 5 s while a run is live.
  Needs you has one row per study with one action; example studies are read-only and ask nothing.
  "Last activity" is a relative day, never a time.
- **Run on new scans** keeps no outputs checklist and no notes: a study runs every output (the
  request sends no `selectedOutputs`). Grouping dropped files into scans is `scan-files.ts` (the
  rule is its header); intake (mouse, knee, group from names and the sample sheet, no AI) is
  `intake.ts`, mouse-OA specific: the knee is stored as `attributes.knee`. With several scans,
  every row needs mouse, knee and group before Start; one scan needs none.
- **Uploads** (`uploads.ts`) run one scan at a time under the server's open-upload limit, so a
  study of many never hits its 429; the old single-scan panel's machinery (4 PUTs at once, 3
  tries, Retry of the failed files, complete, cancel) lives there. Start pressed during uploads
  arms the page: it starts when the last upload completes and disarms if one fails or the last
  scan is removed. Leaving the page aborts and cancels unfinished uploads.
- **Pilot**: with more than two scans the default is "Run 2 first": the first scan of each of the
  first two groups, else the first two. The rest wait with no run; the study page starts them.
- **Time and cost** shown before Start come only from the lab's newest completed run of the
  workflow (its wall time and `usage.modelCostUsd`); with none, nothing is shown. There is no
  budget cap, so the page never says a run stops at one.
- **Excel sample sheets**: `xlsx.ts` reads the first worksheet with `fflate` (unzip) and
  `DOMParser`, loaded only when an `.xlsx` is dropped.
- **Shared with `features/run`** through `@voluma/ui/run`: the run status chip and link
  (`RunBadge`, `runStatus`, `runHref`), the formatters, and visitor keys.
