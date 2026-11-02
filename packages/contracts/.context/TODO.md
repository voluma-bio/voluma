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

The agent model's events (`agent-events.ts`, and the widened `thread.started`, `thread.ended` and
user sender in `events.ts`) are new types and optional fields only; today's `output` event is
untouched. Each narrowing below is a step-2 PR (root `AGENTS.md`, "Contract changes"): re-run the
conversion, parse every staging run and every `run.json`, then narrow.

- Remove the task-loop events (`output`, `revision.started`, `attempt.opened`, `task`, `checkpoint`,
  `plan.changed`, `ask`, `answer`, `reply`, `outputs.*`, and the human `check.accepted`,
  `review.completed`, `correction.ended`) with the fold's task rows.
- `thread.started`: `harness` required on the root thread; `role` required on agent-model threads.

## Final outputs file

`final-outputs.ts` holds `finalOutputsSchema` (the rendered `/run/final-outputs.yaml`), the total
`applyOutputsChange` the fold uses and `refuseOutputsChange`, the writer's check against the run's
catalog; the runner's opening change and `change_outputs` call it and refuse there. The label
overlays the fold resolves come from the `add` entries of the opening change, so it must add each
label overlay a value or version links to.

## `output.published.detail`

Loose. The review converter (`review-assets.ts`) reads `as`, `axis`, `dtype` and `unit`: name its
keys per catalog `shape`, narrowing in two steps if any writer already ran.

## Label overlays

A link to a label overlay resolves to its map's version. If bulk keeps after a one-bone fix prove
costly, record per-label hashes on the map's version instead (an addition to `output.published`).
