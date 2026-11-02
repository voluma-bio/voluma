# Study feature TODO

- An agent-loop run's sample has no bar and no values on the study pages: the study read carries
  task states and task-loop measurements only. Once the output fold is on main, send each sample's
  final outputs with their status in the study read and read the bar and Compare's cells from it.
- Recent activity has only run times (started, finished, reviewed). To check raised and
  corrections need an activity feed from the runs' events in the study read.
- The Studies page and the study layout's tree each poll `studiesQuery` with their own copy of the
  live rule (react-query dedupes them). If a third caller appears, make one `useStudiesLive()`
  hook (structure review of #454, p1275).
