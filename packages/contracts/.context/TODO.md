# Contracts TODO

## Next annotation kinds

`annotationSchema` (`src/review.ts`) ships `point` and `line`. Add each of these
in a contract PR when a workflow produces it, not before. A region of interest
is a structure (a mask), not an annotation.

- `plane`: `origin` + unit `normal` (vascular cross-sections).
- `region`: a box, `corner` + three edge vectors (only if a producer needs a box a mask can't express).
- `path`: `{ points: vec3[], closed: boolean }`: vessel centrelines, traced
  boundaries (OA's `upper_inner_boundary_curves`). As thousands of two-point
  `line`s it would bloat every revision.

## `checkThreadId` → `threadId` on the `answer` event (PR #384)

A worker's `ask` is answered through the same `answer` event, so `checkThreadId` now holds a worker's id too. Rename it to `threadId` by expand/contract (see the stored-event rule in the root `AGENTS.md`), and fix the doc comments in `events.ts` that still say "a check thread asked" / "answered a check thread's `ask`".

## Contract step after the agent model's expand step (not before Nov 4, and not while a stored run uses them)

The agent model's events (`agent-events.ts`, the widened `output`, `thread.started` and
`thread.ended` in `events.ts`) were added as optional fields and new types only. Each narrowing
below is a step-2 PR (root `AGENTS.md`, "Contract changes"): re-run the conversion, parse every
staging run and every `run.json`, then narrow.

- `output`: make `version`, `path`, `files` (absent for a value) and `madeFrom` required and drop `taskId` and `attemptId`, once no
  stored run is on the task loop. The nested `output` of an agent-model version is a compatibility shell
  (`measurement` for a value, `file` holding the primary file); make it optional first, then drop it with the
  task rows. `outputId` on the event already accepts `<worker>/<id>`; the task tool's input still takes one segment.
- `output-fold.ts` skips an `outputs.changed` its rules refuse (a link to an output not in the list). The tool refuses
  the same change first, but the runner's opening change is not checked by a tool: it must list each value's `on` and
  `context` outputs, or the run has no final outputs and nothing says why.
- Remove the task-loop events (`revision.started`, `attempt.opened`, `task`, `checkpoint`,
  `plan.changed`, `ask`, `answer`, `reply`, `outputs.*`, and the human `check.accepted`,
  `review.completed`, `correction.ended`) with the fold's task rows.
- `thread.started`: `harness` required on the root thread; `role` required on agent-model threads.
