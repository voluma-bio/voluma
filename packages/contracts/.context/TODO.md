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

Readers that take an output's status from `fold.byId` by its own id (`hasVersion` in
`outputsIn`, the panel's not-in list) are right only while label overlays stay off the final list.
One fold helper, `stateOf(fold, id)`, that resolves the label to its map first and is the only way
readers get a state, would end that class (`chainOf` needed the same step, #489).

## Drop the deploy-overlap leftovers of the task loop (2026-11-03)

Once no runner or API built before "Delete the task loop" is live, and no run started by such a runner
can be resumed: delete from `claimSchema.run` (`src/runner.ts`, filled by `ingest.ts`) `harness`, `tasks`
and `review` (an older runner requires all three), the claim's `harnesses`, and `harness` on the root
`thread.started` (`src/events.ts`, written by `supervise-run.ts`; an older runner pins
`first.payload.harness ?? "tasks"`), together with the `runs.harness` column. The API's TODO
(`apps/api/.context/TODO.md`) lists the rest.

## Drop `thread.started.kind` (later step)

`kind` repeats `role` now that only `main` and `worker` exist (the root writes `supervisor`). A stored
event field, so two steps: make it optional and stop writing it, then, once no stored event or live
runner needs it, delete it. Along with it, `ThreadBase.role` and `ThreadLayout.role` duplicate `place`.
