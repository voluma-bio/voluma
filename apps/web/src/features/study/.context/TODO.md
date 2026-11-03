# Study feature TODO

- Recent activity has only run times (started, finished, reviewed). To check raised and
  corrections need an activity feed from the runs' events in the study read.

- The compare cell reads the study's row for an input (`member`) where it means the input
  itself (`compare-page.tsx`, around line 256); tidy the edge when that page is next reworked.

- **A Compare cell's link takes `output` or `task` from the newest run's loop** (`compare-page.tsx`:
  `run.harness`, with `run = input.runs[0]`), while `resultRunQuery` can point the same link at an
  older run, the one whose values the cell shows. When those two runs use different loops, the link
  carries the parameter the opened run doesn't read. Take the parameter from the run the link opens.
