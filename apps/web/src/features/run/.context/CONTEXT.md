# Run feature

One screen under `RunLayout` (its query client; the top bar is the shell's): `/runs/:id/live`,
the live run (`run-page.tsx`). Starting runs is `features/study` (Run on new scans, `/new`); there
is no runs list: Home (`features/study`) replaces it.

- **Task titles** come from `workflows/mouse-oa/tasks.json`, read through `catalog["mouse-oa"]`
  from `@voluma/workflow/bundled` (JSON imports parsed with the contract's schemas; the API's
  workflow catalog is the same export; no endpoint serves it) by the bundle's `taskTitle` (a task
  without a title shows its id); don't add another copy. The API's Railway watch paths include
  `/workflows/*/tasks.json` and `outputs.json` (see `apps/api/.context/deploy.md`), so a change
  redeploys the web app. The page reads the plan from the first
  `revision.started` itself because `fold` doesn't expose it.
- **The live page** behaves like Meridian Flow's chat, adapted to a run. The main view is the main
  thread's transcript, which is the run's orchestration: its wakes (who woke it, why, its decision,
  its notes clamped), a card where each worker and checker started (live tool line and ticking
  clock while running, its result when done; the row expands to its report, the name opens its
  thread), and the supervisor's code (task statuses set by a rule, judgments, revisions) folded like
  tool calls. `?thread=<threadId>` shows that thread's transcript in its place. Running workers and
  checkers are listed above the main transcript; failures and To check items sit at the top; the
  run's progress is a right rail (a closed "Tasks" fold under 1100 px, which scrolls on its own).
- **The progress rail** (`task-progress.tsx`) reads without opening any agent: one row per plan
  task in plan order (state dot, title opening its newest thread, cost and time), and a second
  line: the clock while working or being checked, the outcome once it ends, else the state. It
  replaced a dependency graph plus a separate per-task spend list (three lists of the same tasks).
  A waiting row names the tasks it waits on. The outcome (`outcomes` in `run-model.ts`) is the
  current attempt's last worker checkpoint, else the checker's; a failed task's `task` reason.
  Not the wake `note` (the whole notes block, every task so far), not the closing `task` reason (a
  rule's stock sentence), not a judgment's reason (about the check). Under the tasks, "Outputs so
  far" (`outputRows`): each measurement's and score's value from `fold`, by task in plan order; a
  null value shows the worker's note; once a task is done, to check or failed, a required output it
  never reported reads "Not reported" (a stopped task's row already says it stopped); a stale
  task's values say they may no longer hold. Files,
  volumes, structures and annotations have no value to show here.
- **The log is not complete when the runner stops.** Stop ends the run in the API at once, and a
  lost runner writes nothing more (its lease expires and the run goes back to queued or awaiting
  keys), so threads can have a `thread.started` and no `thread.ended`. `haltOf(Run.state, closed)`
  says why the runner isn't running the threads, and is the one input `runView` and `threadRows`
  take: once ended, a thread, tool call or task still open shows as Stopped (Failed if the run
  failed, at the run's end); while queued or awaiting keys it shows as Paused, its clock frozen at
  its last event, until the runner's `thread.started` resumes it. The end applies only once the
  stream has closed, when the log is whole, so a reload never shows a finished thread as Stopped
  while its backlog loads. Never decide "running" from the events alone.
- **Run-level data** is one `runView(events, folded, halt, providerCalls)` (`run-model.ts`): threads, attention,
  plan, task states, progress and spend, memoized on the events. `withLiveCalls` overlays the tool
  calls being written per frame.
- **The attention list** (`attentionOf`) is built from `fold`'s tasks (To check items, the checker's
  verdict), so it agrees with review; a failure counts only on a task's latest thread.
- **Transcripts** (`transcript.ts`, pure): prose stays visible as Markdown; reasoning and each run
  of tool calls between two pieces of prose fold into one closed `ProcessDisclosure` whose label is
  a digest ("Ran 12 commands, 1 failed"). Folds never open or close by themselves, and their rows'
  contents are built only when opened. Checkpoints, reported outputs and failures break the fold;
  the `checkpoint` and `report_output` calls themselves are hidden unless they failed. No timestamps:
  elapsed time is on agent rows, model usage behind info popovers.
- **Live frames** (`@voluma/contracts/stream`) are folded in `transcript.ts` (`applyFrame`, offset
  guarded) and dropped by `settle` when their durable event lands: a reply by `messageId` (the
  `message`, or the `wake` for the main thread, whose streamed text is its JSON reply: the page
  shows its `note` as it grows), a call's arguments by `toolCallId` until its `tool.call`, its
  output until its `tool.result`. Frames can trail their durable event (about a third of
  `tool.output` frames arrive after the `tool.result`, and a short reply's single `text.delta`
  can land after its `message`), so `settle` records each settled key in a `Settled` set the
  stream owns and `applyFrame` ignores frames for those keys. A frame at offset 0 starts a partial
  over (a re-asked wake reuses its id); any other gap drops the partial until the durable event.
  A live `tool.output` keeps only its last 8,000 characters, the tail `bash.ts` keeps.
  A partial row and its durable row share a React key (message id, toolCallId), so the swap does
  not remount it. Frames are not replayed, so a reload mid-reply shows that reply only once its
  durable event lands. A thread streams one reply at a time, so the first frame of a new reply
  drops the thread's other partials (one cut off by a runner restart); not `thread.started`,
  which can lag the frames. A thread's partials are also dropped when it ends, and all of them
  when the stream closes. Only
  `live` changes per frame; `events` keeps its identity, so the event derivations don't rerun per
  token. A thread's first `runtime` message is labelled its task brief.
- **Ported from Flow**: `chat/` holds Flow's `ProcessDisclosure`, `ActivityRow`, `StreamingText`
  caret, `useChatFollowScroll`, `DisclosureStore`, `ChatThreadNavigation` and `TurnInfoButton`,
  restyled onto voluma's tokens; each file header names its source. `chat/` stays generic (no run
  model), so it can move to `packages/ui`; the sub-agent cards built on Flow's anatomy are
  `agents.tsx`, at feature level. Markdown
  is `react-markdown` + `remark-gfm`, with `remend` closing open constructs while text streams (the
  same tail repair Flow uses); raw HTML is skipped and images show as their alt text.
- **Live tasks** are `fold(events)` over the run's stream (`subscribe`), published at most once per
  animation frame. "Finished" counts To check tasks: their work is done. The task list comes from the `revision.started` plan; a task not started yet is Ready when every task it builds on has a usable result (`isSatisfied` from `@voluma/workflow`, the supervisor's own rule: done, or To check with every required output), else "Waiting on" those tasks.
  Queue position and run state are not events, so `getRun` is polled every 3 s until the run ends.
- **Visitor keys** (`@voluma/ui/run`, shared with `features/study`) live in localStorage under
  `voluma.visitor-keys.<userId>`; a run in `awaiting-keys` shows the form on its page
  (`resendKeys`) only to the user who started it.
- A completed run links to `/runs/:runId`, the review lane's route; the live page is `/runs/:id/live` so it never shadows it. Active runs open live; stopped and failed runs open live too (it shows the error).

- **A run's status chip** (`RunBadge`, `runStatus`) and the formatters (`formatUsd`,
  `formatDuration`) are `@voluma/ui/run`, shared with Home; `status.tsx` keeps the clock.
- **Live page cost and time** come only from `spend(events)` (`@voluma/contracts/spend`), run in
  `runView` on durable events, never per live frame (`spend.tsx`). The header shows the run's total,
  with the main thread's share in its popover; each task's row in the progress rail covers its
  worker, check and any redo together (cost only while it works: its clock is the thread's). Each worker and checker card, and an opened thread's bar, shows that
  thread's own cost: `spend` over just that thread's events (`Thread.spend`), so a card never repeats
  its task's sum; its popover has no wall time, since the card's `Elapsed` is the thread's clock. Wall times move when an event lands; only the header clock and the cards' `Elapsed`
  tick each second.

Gaps: "Reviewed" needs review state, which the review lane doesn't expose yet ([#102](https://github.com/voluma-bio/voluma/issues/102)). Workflow versions are not shown (no versions yet).
