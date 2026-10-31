# Run view

`@voluma/run-view` holds what any screen needs to show a run, so features share it without
importing each other: the run model (`run-model.ts`: `runView`, `agentTree`, `haltOf`), the
transcript fold (`transcript.ts`), the run store (`run-store.tsx`), `AgentThread`, the task graph
(`task-graph.tsx`: `TaskGraph` at study, summary and report size), `ItemToCheck`, `chat/`, the
clock (`use-now.ts`), and the status, formatting and visitor-key helpers. It has no router. Its
screens are the scan review (`apps/web/src/features/scan`) and the study pages
(`apps/web/src/features/study`).

- **Parts take data and callbacks; screens own the calls.** `ItemToCheck` makes no request: each
  screen runs its own accept. Where a part leads to another page it takes a `LinkTo` (`@voluma/ui`),
  the app's router link, and renders a link: `TaskGraph`'s `taskLink`. A box that picks a task on
  the same page is a toggle (`onSelect`).

- **Task titles** are the plan's (`TaskView.title`, from the run's first `revision.started`); a
  task without one shows its id. `catalog["mouse-oa"]` (`@voluma/workflow/bundled`) is only for
  what the log doesn't carry.
- **The agent tree** is `agentTree` (`run-model.ts`): each thread under its
  `thread.started.parentThreadId`, the supervisor hidden. Never parse thread ids and never assume
  one worker and one check per task: a redo resumes the same worker thread (its tries are its
  `attempt.opened` ids, `Thread.attempts`), and each check is a new thread whose `attemptId` names
  the try it checked. Every door onto an agent is `openThread`.
- **Researcher words** everywhere but inside a transcript: the AI, a second AI check, the lead AI;
  never worker, checker or model, and no paths, file names or tool names outside "How the AI did
  it". A task's line is its current attempt's latest worker checkpoint `summary`, else its
  `summary` from `tasks.json`; a checkpoint's full `text` is never the line. The check shows its
  verdict and its `summary`; its full text sits behind "What it found". Values take the
  workflow's names (`outputName`), the AI's title only for an output `outputs.json` lacks.
- **Running means someone is running it.** A task is Working only while its worker thread runs,
  and being checked only while its check thread runs (open, per `openThreads`, while the run is `running`); an attempt open with
  neither reads "Waiting on the lead AI". A run that failed on a fatal provider error writes no
  task event: the task whose current thread ended failed shows Failed, with that thread's error.
  "Redoing it after the second AI check" only when an earlier attempt was sent back.
- **One count.** "N of M tasks done" and "K to check" are `progress(latest revision)` from
  `@voluma/contracts/review-state`, the function the server's `Run.tasks` and review summary use,
  so the page agrees with Home and the review: done or To check by fold status (a skipped task
  counts), and the open check items. Cards that can't be
  accepted (a task sent back, a value missing, a failed task) show but aren't counted.
- **QC images** are the run's evidence files through `reviewFileUrl`, 80 to 360 KB each with no
  smaller rendition: `loading="lazy"`, full size only in the lightbox, and "Image not available"
  when the file is missing (a copied run has no R2 files).
- **One agent's thread is `<AgentThread threadId>`** (`agent-thread.tsx`), wherever it shows: the
  scan review's Agents panel today. The caller names the thread and gives it a box; the
  container reads its rows and thread from the run store (`run-store.tsx`: one per run, fed by
  the screen's stream; selector hooks, so a thread re-renders only for its own frames), and owns its header (name, status, clock, cost), its live line and
  its own scroll, which sticks to the newest line while the reader is at the bottom. Hosts add
  header controls through `actions`. Shape from Meridian Flow's `ChatView`. Don't render a thread
  any other way; a new place for one is a new `<AgentThread>`.
- **The log is not complete when the runner stops.** Stop ends the run in the API at once, and a
  lost runner writes nothing more (its lease expires and the run goes back to queued or awaiting
  keys), so threads can have a `thread.started` and no `thread.ended`. `haltOf(Run.state, closed)`
  says why the runner isn't running the threads, and is the one input `runView` and `threadRows`
  take: once ended, a thread, tool call or task still open shows as Stopped (Failed if the run
  failed, at the run's end); while queued or awaiting keys it shows as Paused, its clock
  frozen at its last event, until the runner's `thread.started` resumes it. The end applies only once the
  stream has closed (`useRunStream`'s `closed`), when the log is whole: the server ends an ended
  run's stream with `event: end`, so that is right after the backlog, with no reconnect. A
  reload therefore never shows a finished thread as Stopped while its backlog loads; during the
  load an open attempt reads "Waiting on the lead AI". Never decide "running" from the events
  alone.
- **Counting:** an ended run that takes no decisions (failed, cancelled, an example) shows its
  cards with one line saying why none can be accepted, and no "K to check" in the header or badge.
- **Run-level data** is one `runView(events, state, providerCalls, halt)` (`run-model.ts`):
  threads, progress, and per plan task its state, threads, line, check, To check items, QC image,
  values and spend, memoized on the events. `withLiveCalls` overlays the tool calls being written
  per frame. The page is keyed on the run id, so nothing carries over from one run to the next.
- **Transcripts** (`transcript.ts`, pure): prose stays visible as Markdown; reasoning and each run
  of tool calls between two pieces of prose fold into one closed `ProcessDisclosure` whose label is
  a digest ("Ran 12 commands, 1 failed"). Folds never open or close by themselves, and their rows'
  contents are built only when opened. Checkpoints, reported outputs and failures break the fold;
  the `checkpoint` and `report_output` calls themselves are hidden unless they failed. No timestamps:
  elapsed time is on agent rows, model usage behind info popovers.
- **Live frames** (`@voluma/contracts/stream`) are folded in `transcript.ts` (`applyFrame`, offset
  guarded) and dropped by `settle` when their durable event lands: a reply by `messageId` (the
  `message`), a call's arguments by `toolCallId` until its `tool.call`, its
  output until its `tool.result`. Frames can trail their durable event (about a third of
  `tool.output` frames arrive after the `tool.result`, and a short reply's single `text.delta`
  can land after its `message`), so `settle` records each settled key in a `Settled` set the
  stream owns and `applyFrame` ignores frames for those keys. A frame at offset 0 starts a partial
  over (a re-asked reply reuses its id); any other gap drops the partial until the durable event.
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
  caret, `DisclosureStore`, `ChatThreadNavigation` and `TurnInfoButton`,
  restyled onto voluma's tokens; each file header names its source. `chat/` stays generic (no run
  model), so it can move to `packages/ui`; the sub-agent cards built on Flow's anatomy are
  `agents.tsx`, at feature level. Markdown
  is `react-markdown` + `remark-gfm`, with `remend` closing open constructs while text streams (the
  same tail repair Flow uses); raw HTML is skipped and images show as their alt text.
- **Live tasks** come from the run's stream (`subscribe`), published at most once per
  animation frame. The task list comes from
 the `revision.started` plan; a task not started yet is Ready when every task it builds on has a usable result (`isSatisfied` from `@voluma/contracts/fold`, the supervisor's own rule: done, or To check with every required output), else "Waiting on" those tasks.
  Queue position and run state are not events, so `getRun` is polled every 3 s until the run ends.
- **Visitor keys** (`@voluma/run-view`, shared with `features/study`): a Meta key, the only
  way a guest runs (the API refuses a guest start without it, 403); a member may keep one too. A key
  in this browser is sent with every start, and `RunKeyLine` next to each Start says whose key the
  run uses and lets the user remove it. They live in localStorage under
  `voluma.visitor-keys.<userId>`. A run in `awaiting-keys` is handled on its page
  (`features/scan/scan-header.tsx`) for the user who started it only: with a key stored, the page
  sends it (`resendKeys`) by itself, and again after a 429, 5xx or network failure (backoff, capped),
  so the run page polls in a background tab too. A 409 means another tab already sent it. The form
  shows when no key is stored or a send fails. `/keys` doesn't check the key: a revoked one fails the
  run at its first model call (401). Other users see that the run waits for its starter.
- **A run's status** (`runStatus`, a word and a `StatusMark` state) and the formatters (`formatUsd`,
  `formatDuration`, `plural`) are `@voluma/run-view`, shared with Home; `use-now.ts` is the clock.
- **Cost and time** come only from `spend(events, providerCalls)` (`@voluma/contracts/spend`), run
  in `runView` on durable events, never per live frame. Run details shows the run's settled total;
  each card in the lead AI's stream and each thread in "How the AI did it" shows that thread's own
  cost (`Thread.spend`). `providerCalls.calls` and `unknownCostCalls` count gateway requests
  (upload, response, delete and retries separately), not SAM operations; model-call counts
  stay model calls. Only `Elapsed` and the header's running-for tick each second.

Gaps: "Reviewed" needs review state ([#102](https://github.com/voluma-bio/voluma/issues/102)). Workflow versions are not shown (no versions yet).
