# Run feature: deferred work

- **Run debug view.** One page per run that shows everything the run log holds, in order: every thread (main, worker, checker) with its model, each message and tool call with its arguments and result, sandbox commands and their output, wakes with their notes and decisions, the plan and every revision, costs, and errors. Today a run's inner workings are visible only in the runner's log and the database. The data is already in the event stream (`subscribe` in `@voluma/api-client`), so this is a web page over the existing stream, not a new API.
