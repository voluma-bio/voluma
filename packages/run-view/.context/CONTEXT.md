# Run view

`@voluma/run-view` holds what any screen needs to show a run, so features share it without
importing each other: the outputs review's model and trail (`outputs-model.ts`,
`outputs-trail.ts`), the run's events (`run-store.tsx`), `ItemToCheck`, `ApprovalCard`, the
model's prose as Markdown (`chat/markdown.tsx`), the clock (`use-now.ts`), an input's status in a
study (`study-inputs.ts`, `samples.ts`), and the status, formatting and visitor-key helpers. It has
no router. Its screens are the input review (`apps/web/src/features/input`) and the study pages
(`apps/web/src/features/study`).

- **Parts take data and callbacks; screens own the calls.** `ItemToCheck` and `ApprovalCard` make
  no request: each screen runs its own accept or answer.
- **The run's events** live in one store per run page (`RunStoreProvider`, keyed on the run, fed by
  the page's stream; `useEvents`), so the page and its header read one log. Only durable events are
  kept.
- **Researcher words** everywhere: the AI, main; no paths, file names or tool names. Values take
  the workflow's names (`outputName`, from the bundled `outputs.yaml`), an output's id as words for
  one the catalog lacks.
- **A run is reviewed by its outputs** (`outputs-model.ts`): `outputsReview`
  (sections, rows, To check items of an output and of what it was made from, the open count) and
  `outputBlocks` (each output's latest version as a scene block, keyed by output id, on its base's
  grid) from `outputsFold` and the bundled catalog. Grid shapes come from the converted levels;
  spacing, crop offsets, surface axes and point/line ends come from the version's `detail` and are
  absent until the writer fills them (`.context/TODO.md`). Units are UCUM, shown by `unitText`.
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
- **Visitor keys** (`@voluma/run-view`, shared with `features/study`): a Meta key, the only
  way an account without Voluma's key (`Me.volumaKey` false: a guest) runs (the API refuses a start without it, 403); an account with it may keep one too. A key
  in this browser is sent with every start, and with a message or answer to a finished own-key run (`keysToReopen`: the server wiped the run's keys when it ended), and `RunKeyLine` next to each Start says whose key the
  run uses and lets the user remove it. They live in localStorage under
  `voluma.visitor-keys.<userId>`. A run in `awaiting-keys` is handled on its page
  (`features/input/input-header.tsx`) for the user who started it only: with a key stored, the page
  sends it (`resendKeys`) by itself, and again after a refusal that clears: a 429 every minute with no
  cap (a slot frees only when another run ends), a 5xx or network failure with a capped backoff. So
  the run page polls in a background tab too. A 409 means another tab already sent it. The form
  shows when no key is stored or a send fails. `/keys` doesn't check the key: a revoked one fails the
  run at its first model call (401). Other users see that the run waits for its starter.
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
