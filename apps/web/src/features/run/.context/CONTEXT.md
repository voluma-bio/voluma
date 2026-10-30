# Run feature

One screen under `RunLayout` (its query client; the top bar is the shell's): `/runs/:id/live`,
the run page (`run-page.tsx`). Starting runs is `features/study` (Run on new scans, `/new`); there
is no runs list: Home (`features/study`) replaces it.

- **Task titles** come from `workflows/mouse-oa/tasks.json`, read through `catalog["mouse-oa"]`
  from `@voluma/workflow/bundled` (JSON imports parsed with the contract's schemas; the API's
  workflow catalog is the same export; no endpoint serves it) by the bundle's `taskTitle` (a task
  without a title shows its id); don't add another copy. The API's build filter in `render.yaml` includes
  `workflows/*/tasks.json` and `outputs.json` (see `apps/api/.context/deploy.md`), so a change
  redeploys the web app. The page reads the plan from the first
  `revision.started` itself because `fold` doesn't expose it.
- **The page** (`run-page.tsx`) is the R2 run screen of the full-flow prototype: a researcher sees
  where the run is, what needs their eye and the results without reading a transcript. Header
  (`run-header.tsx`): a crumb to the study (Home for a study of one: `getStudy` is read once for
  labels only), the scan as "OA6-1, right knee", group and workflow, "N of M tasks done", "K to
  check", a bar, Run details (started as a date, took or running for, settled cost, and "What
  the AI did"), Stop while live, and Open in 3D (`/runs/:id?task=`, the review, until a 3D
  panel exists). A queued run with a plan lost its runner: it reads "Paused"; one the API holds after
  the AI's provider failed (`waitingForProvider`) reads "Waiting: the AI is unavailable", with no
  place in line. Left: the plan as
  a flowchart (`task-flow.tsx`), rows by dependency depth and each row ordered by its parents'
  columns, so a plan change needs no layout table; below 1100 px a compact list, and the page
  scrolls as one. Right: Overview (`overview.tsx`: working on now, needs your eye, results by
  task), one task (`?task=<id>`, `task-view.tsx`), or the Agents view
  (`?view=agents`, from Run details; `agents-view.tsx`).
- **The Agents view** (a debug view for now; the redesign restyles it): every agent as a tree and
  the selected agent's stream (`&agent=<threadId>`; no `agent` means Follow live, which keeps the
  agent it shows while that one works, else shows the newest working agent with no working agent
  under it, else the lead AI). The tree is `agentTree` (`run-model.ts`): each thread under its
  `thread.started.parentThreadId`, the supervisor hidden; siblings sharing `task` sit under the
  task's title. Never parse thread ids and never assume one worker and one check per task: a redo
  resumes the same worker thread (its tries are its `attempt.opened` ids, `Thread.attempts`), and
  each check is a new thread whose `attemptId` names the try it checked. Every door onto an agent
  (a card's name in the lead AI's stream, the tree) is `openThread`, which opens it here.
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
  counts), and the open check items. The Overview's badge is the same K. Cards that can't be
  accepted (a task sent back, a value missing, a failed task) show but aren't counted.
- **Needs your eye** comes from `reviewState` (the fold plus `check.accepted`): every check item
  of a task, open or accepted, live or finished. "Looks right" calls `acceptCheck` with
  `Run.review.revisionId`, only on a completed run that isn't an example. An ended run's stream has
  closed, so the page also counts what it accepted itself (`useAccepting`, which keeps a pending
  set per item). A To check task with no check item gets a card with no "Looks right"; a failed
  task gets its own card. The fold's generic "Marked to check" title is not shown. A value is
  blue when its task's result came from a correction revision.
- **QC images** are the run's evidence files through `reviewFileUrl`, 80 to 360 KB each with no
  smaller rendition: `loading="lazy"`, full size only in the lightbox, and "Image not available"
  when the file is missing (a copied run has no R2 files).
- **One agent's thread is `<AgentThread threadId>`** (`agent-thread.tsx`), wherever it shows: the
  Agents view and "How the AI did it" today. The caller names the thread and gives it a box; the
  container reads the run's log from `RunLogProvider` (events, live frames, halt, threads; one per
  run page), builds its rows, and owns its header (name, status, clock, cost), its live line and
  its own scroll, which sticks to the newest line while the reader is at the bottom. Hosts add
  header controls through `actions`. Shape from Meridian Flow's `ChatView`. Don't render a thread
  any other way; a new place for one is a new `<AgentThread>`.
- **"How the AI did it"** shows the task's agents (the AI's work, its tries in one thread, then a
  check per try), each an `AgentThread` in a box of at most 36rem; open by default only while the
  task works, and built only once it opens.
- **The log is not complete when the runner stops.** Stop ends the run in the API at once, and a
  lost runner writes nothing more (its lease expires and the run goes back to queued or awaiting
  keys), so threads can have a `thread.started` and no `thread.ended`. `haltOf(Run.state, closed)`
  says why the runner isn't running the threads, and is the one input `runView` and `threadRows`
  take: once ended, a thread, tool call or task still open shows as Stopped (Failed if the run
  failed, at the run's end); while queued or awaiting keys it shows as Paused (Waiting for the AI,
  halt `awaiting-ai`, while held for the AI: the section title, task and agent cards), its clock
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
 the `revision.started` plan; a task not started yet is Ready when every task it builds on has a usable result (`isSatisfied` from `@voluma/workflow`, the supervisor's own rule: done, or To check with every required output), else "Waiting on" those tasks.
  Queue position and run state are not events, so `getRun` is polled every 3 s until the run ends.
- **Visitor keys** (`@voluma/ui/run`, shared with `features/study`): a Meta key, the only
  way a guest runs (the API refuses a guest start without it, 403); a member may keep one too. A key
  in this browser is sent with every start, and `RunKeyLine` next to each Start says whose key the
  run uses and lets the user remove it. They live in localStorage under
  `voluma.visitor-keys.<userId>`; a run in `awaiting-keys` shows the form on its page
  (`resendKeys`) only to the user who started it.
- A completed run links to `/runs/:runId`, the review lane's route; the live page is `/runs/:id/live` so it never shadows it. Active runs open live; stopped and failed runs open live too (it shows the error).

- **A run's status** (`runStatus`, a word and a `StatusMark` state) and the formatters (`formatUsd`,
  `formatDuration`) are `@voluma/ui/run`, shared with Home; `status.tsx` keeps the clock.
- **Cost and time** come only from `spend(events, providerCalls)` (`@voluma/contracts/spend`), run
  in `runView` on durable events, never per live frame. Run details shows the run's settled total;
  each card in the lead AI's stream and each thread in "How the AI did it" shows that thread's own
  cost (`Thread.spend`). Only `Elapsed` and the header's running-for tick each second.

Gaps: "Reviewed" needs review state, which the review lane doesn't expose yet ([#102](https://github.com/voluma-bio/voluma/issues/102)). Workflow versions are not shown (no versions yet).
