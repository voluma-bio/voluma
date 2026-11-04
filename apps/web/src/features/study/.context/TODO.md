# Study feature TODO

- Recent activity has only run times (started, finished). To check raised and
  corrections need an activity feed from the runs' events in the study read.

- The compare cell reads the study's row for an input (`member`) where it means the input
  itself (`compare-page.tsx`, around line 256); tidy the edge when that page is next reworked.

- A value resting on an output with open To check items still reads Reported (a tick) on the study
  pages: the study read's `outputStatus` (`pg-studies.ts` `outputStatusOf`, `study-model.ts`
  `segmentOf`, Compare's cells) carries only the fold's own status. The input review shows it
  waiting on that check (`rowStatus`, run-view, #590). Doing the same here means a waiting status
  on `studyInputDetailSchema`'s `outputStatus` (a contract change) derived on the server with the
  same rule.
