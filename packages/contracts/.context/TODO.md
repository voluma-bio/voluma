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

## Archived `run.json` dumps

Dumps from before `thread.started.name` was required need the docs-repo `convert-t1b.ts` once before import.

## `checkThreadId` → `threadId` on the `answer` event (PR #384)

A worker's `ask` is answered through the same `answer` event, so `checkThreadId` now holds a worker's id too. Rename it to `threadId` by expand/contract (see the stored-event rule in the root `AGENTS.md`), and fix the doc comments in `events.ts` that still say "a check thread asked" / "answered a check thread's `ask`".
