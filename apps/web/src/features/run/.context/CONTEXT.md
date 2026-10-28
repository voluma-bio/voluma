# Run feature

Three screens under `RunLayout` (top bar and query client): `/` start (`start-page.tsx`),
`/runs` list (`runs-page.tsx`), `/runs/:id/live` live run (`run-page.tsx`).

- **Outputs checklist data** is `workflows/workflow-mouse-oa/outputs.json`, imported as raw text and
  parsed with `outputsFileSchema` (`workflows.ts`). The API never reads workflow files, so there is
  no endpoint for it. The bundle holds the outputs of the commit the web was built from; the runner
  checks selected ids against its own checkout. The API's Railway watch paths include
  `/workflows/*/outputs.json` (set; see `apps/api/.context/deploy.md`), so an outputs change redeploys the web app.
  With every output ticked the request sends no `selectedOutputs` (absent means all), so a default run
  doesn't depend on the bundle matching the runner. Groups are one per producing task.
- **Task titles** are `TASK_TITLES` in `workflows.ts`, a copy of the workflow's task names (neither
  `tasks.json` nor the plan carries a title); don't add another copy. The page reads the plan from the first
  `revision.started` itself because `fold` doesn't expose it.
- **The live page** behaves like Meridian Flow's chat, adapted to a run. The main view is the main
  thread's transcript, which is the run's orchestration: its wakes (who woke it, why, its decision,
  its notes clamped), a card where each worker and checker started (live tool line and ticking
  clock while running, its result when done; the row expands to its report, the name opens its
  thread), and the supervisor's code (task statuses set by a rule, judgments, revisions) folded like
  tool calls. `?thread=<threadId>` shows that thread's transcript in its place. Running workers and
  checkers are listed above the main transcript; failures and To check items sit at the top; the
  plan is a compact graph in a right rail (a closed "Tasks" fold under 1100 px).
- **The log is not complete when a run ends.** Stop ends the run in the API at once, and a killed
  runner writes nothing more, so threads can have a `thread.started` and no `thread.ended`. The
  run's end comes from `Run.state` and is passed to `threadsOf`, `threadRows` and `taskStates`: a
  thread, tool call or task still open then shows as stopped. Never decide "running" from the events alone.
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
  A partial row and its durable row share a React key (message id, toolCallId), so the swap does
  not remount it. Frames are not replayed, so a reload mid-reply shows that reply only once its
  durable event lands. A thread's partials are dropped when it ends or starts again (a runner
  restart gives the resumed thread new reply ids), and all of them when the stream closes. Only
  `live` changes per frame; `events` keeps its identity, so the event derivations don't rerun per
  token. A thread's first `runtime` message is labelled its task brief.
- **Ported from Flow**: `chat/` holds Flow's `ProcessDisclosure`, `ActivityRow`, `StreamingText`
  caret, `useChatFollowScroll`, `DisclosureStore`, `ChatThreadNavigation`, `TurnInfoButton` and the
  sub-agent row anatomy, restyled onto voluma's tokens; each file header names its source. Markdown
  is `react-markdown` + `remark-gfm`, with `remend` closing open constructs while text streams (the
  same tail repair Flow uses); raw HTML is skipped and images show as their alt text.
- **Live tasks** are `fold(events)` over the run's stream (`subscribe`), published at most once per
  animation frame. "Finished" counts To check tasks: their work is done. The task list comes from the `revision.started` plan; a task not started yet is Ready when every task it builds on is done, else Waiting.
  Queue position and run state are not events, so `getRun` is polled every 3 s until the run ends.
- **Visitor keys** (`keys.tsx`) live in localStorage under `voluma.visitor-keys.<userId>` and are parsed
  with `visitorKeysSchema`; another user of the browser never sees them (a guest has no sign-out, and
  signing in as a member switches id). "Forget keys" on the start screen removes them. The start screen
  asks for keys only for a visitor; a run in `awaiting-keys` shows the form on its page (`resendKeys`) only to the user who started it.
- A completed run links to `/runs/:runId`, the review lane's route; the live page is `/runs/:id/live` so it never shadows it. Active runs open live; stopped and failed runs open live too (it shows the error).

Gaps: the list cannot show "N to check" or "Reviewed" (a `Run` carries neither; the review lane
owns the counts), so completed runs read "Completed". Workflow versions are not shown (no versions yet).
