# Run view

`@voluma/run-view` holds what any screen needs to show a run, so features share it without
importing each other: the outputs review's model and trail (`outputs-model.ts`,
`outputs-trail.ts`), the run's events (`run-store.tsx`), `ItemToCheck`, `ApprovalCard`, the
model's prose as Markdown (`chat/markdown.tsx`), the clock (`use-now.ts`), an input's status in a
study (`study-inputs.ts`, `samples.ts`), and the status, formatting and own-key helpers. It has
no router. Its screens are the input review (`apps/web/src/features/input`) and the study pages
(`apps/web/src/features/study`).

- **Parts take data and callbacks; screens own the calls.** `ItemToCheck` and `ApprovalCard` make
  no request: each screen runs its own accept or answer.
- **The run's events** live in one store per run page (`RunStoreProvider`, keyed on the run, fed by
  the page's stream; `useEvents`), so the page and its header read one log. Only durable events are
  kept.
- **An agent's thread** (`transcript.ts`, `agent-threads.ts`, `transcript-view.tsx`,
  `agent-thread.tsx`) is the body of the input page's Conversation (main) and of a worker's view
  in its Agents tab: `agentEntries` gives main (only when the run has one; `main` and every
  `main.N` of a review are one entry, in log order with nothing between them), then every worker
  or check in start order, from `workersOf` and `agentLog`'s `place`, never a thread's `kind` or
  `role`. `threadRows` derives rows for the picked thread only, from durable events (the stream
  sends no token deltas): the agent's words in the open, main's `message` calls to the researcher
  in the same voice (one `prose` row kind). With `conversation` (main's Conversation) each turn's
  first words, the thread's and each after a `person` slot, carry "The AI" and the time. A screen puts its own rows into the thread by log position
  (`Slot`s, each placed before the first event past its `seq`, closing the fold it lands in; `slot`
  renders them): the Conversation's messages and approvals. A call main held for the
  researcher's yes (`approval.requested`) gets no row of its own: its approval slot is the row,
  and a yes runs it as a job outside any thread. The calls that change results
  (`VISIBLE`: `start_worker`, `report_output`, `change_outputs`) are rows of their own in every
  thread, so the steps around one form two folds; a report reads by catalog name (`nameOf`) and
  gains ", version N" when its `output.published` lands (matched by `versionPath`). Reasoning and
  other runs of tool calls fold closed under a label: the newest `activity` text in the fold, a
  middle dot, then `digest()`'s count, which leaves out `activity` calls and sandbox notes (they stay
  rows inside); a fold with no activity shows the count alone, reasoning alone "Thought", notes
  alone the last note. Bodies are built on first open (`ProcessDisclosure`, `ActivityRow`); a call
  with no result is running, and the live line names it (in the Conversation it is main's newest
  `activity` text in its current turn, which ends at your newest message or anything else main
  was handed, else "Working"; a screen can word the line itself, `line`: the queue without a
  pulse, a call you approved while its job runs);
  on an ended run it reads stopped. Tool arguments and output show their last 8000
  characters with a "Shortened" note. `start_worker`, `message` and `close_worker` name their
  worker through `AgentLinks`, and `Markdown`'s `agents` prop turns inline code that is exactly
  an agent's name into the same link. Tool titles are `toolTitle`: a new tool shows as its name and
  arguments until it gets a case; a fold's digest names a few other calls ("closed worker
  intake"). What a thread was told folds quieter than its steps: the system prompt is "The AI's
  instructions" (later ones "The AI's tools changed"), a summary "The AI summarized its work so
  far". On main, the researcher's words arrive inside a runtime delivery whose `covers` range holds
  a `person.message`: that delivery attaches to the slot of the last `person.message` in its
  range (`got`, shown under it as "What the AI got with your message"; one delivery covering
  several messages goes to the last), by id, not to whichever of your messages was placed last,
  and only with no such slot gets a row of its own (`transcript.test.ts` holds this); other runtime
  deliveries are "News from the run". On a worker, the first is "Brief", later ones "Message from
  <name>" or "News from the run". The scroll follows the newest line only when the reader was at the bottom before the
  update, and an ended thread opens at the top unless the screen asks for its end (`opensAtEnd`). Origin: the transcript viewer deleted with the task loop
  (`eed32205^1`), without tasks, attempts or verdicts.
- **Researcher words** everywhere: the AI, main; no paths, file names or tool names. Values take
  the workflow's names (`outputName`, from the bundled `outputs.yaml`), an output's id as words for
  one the catalog lacks.
- **A run is reviewed by its outputs** (`outputs-model.ts`): `outputsReview`
  (sections, rows, To check items of an output and of what it was made from, the open count) and
  `outputBlocks` (each output's latest version as a scene block, keyed by output id, on its base's
  grid) from `outputsFold` and the bundled catalog. Grid shapes come from the converted levels;
  spacing, crop offsets, surface axes and point/line ends come from the version's `detail` and are
  absent until the writer fills them (`.context/TODO.md`). Units are UCUM, shown by `unitText`.
  An item's `focus` that names a value is aimed at what the value is measured on (`measuredOn`): a
  value has no voxels. `rowStatus(row)` is an output's status on the run page (`OUTPUT_STATUS`
  words) with `waits`, what it rests on that has open items: a reported output with any waits on
  those checks, which are drawn and decided under their own output only.
  The trail (`outputs-trail.ts`) is the data behind Final outputs' Rests on and Further back: `trailOf` (one output's
  upstream, breadth first, with roles and the version used), `madeFromIt` (what rests on it),
  `runGraph` (the whole run by column), `versionWords` (a worker's message after its version) and
  `workersOf` (the agents from `agentLog`, with what each reported). No drawing lives there.
  One link rule (`resolveLink`): a link to a label overlay is a link to its map, as the fold
  resolved it (`fold.labels`, from the run's `outputs.changed` events: `labels` and list entries' `label`); run-view resolves nothing itself. The chain (`chainOf`) is the same breadth-first walk as `trailOf` along the
  spine a final value is computed on, nearest first (value `on` overlay, label to its map, overlay
  to its base, base to its `from`): each step follows the published version's `on`/`base` links
  where it names some, else the catalog's, so it exists before anything is published, and each
  link is ticked by its status (a label overlay's is its map's; pending and missing are not yet in). `outputsReview` carries each row's
  `trail` and `chain` and the run's `others` (published, not final, not on a chain), so components
  only read them.
- **Own keys** (`@voluma/run-view`, shared with `features/study`): a Meta key, the only
  way an account without Voluma's key (`Me.volumaKey` false: a guest) runs (the API refuses a start without it, 403); an account with it may keep one too. A key
  in this browser is sent with every start, and with a message or answer to a finished own-key run (`keysToReopen`: the server wiped the run's keys when it ended), and `RunKeyLine` next to each Start says whose key the
  run uses and lets the user remove it. They live in localStorage under
  `voluma.visitor-keys.<userId>`.
- **A run's status** (`runStatus`, `liveStatus`: a word and a `StatusMark` state) and the
  formatters (`formatUsd`, `formatDuration`, `plural`) are `@voluma/run-view`, shared with the study pages;
  `use-now.ts` is the clock. A completed run with open To check items reads "N to check"
  (`review.needsYou`, the study reads' brief), else "Checked"; a running one with its final
  outputs listed reads "Running · N of M in". A run's cost is `runCost` (model calls plus gateway
  calls), the one sum Run details, study spend and `/new` use. How long a run worked is `runWork`
  (`run-status.tsx`): its first claim to its end plus each correction's reopen to its end, never
  first start to last end, which would count the idle time before a researcher's reopen. A run
  queued again (after a reopen or a lost runner) has no `startedAt` in its state, so the first
  claim comes from its first `claim.started`. `providerCalls.calls` and `unknownCostCalls` count
  gateway requests (upload, response, delete and retries separately), not SAM operations.

Gaps: workflow versions are not shown (no versions yet).
