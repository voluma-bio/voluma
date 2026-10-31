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

## Make `thread.started.name` required (step 2 of #319)

Step 1 shipped `name` optional plus migration `0014_thread_started_name`. Once step 1 is
deployed everywhere and no old runner is running: re-run `0014`'s SQL as a new idempotent
migration (keep its `CASE WHEN type = 'thread.started'` guard: on staging, a plain
`WHERE type = 'thread.started' AND payload->>'name' IS NULL` fails with 22P05 because Postgres reads
the json of other rows first), parse every staging run with the new `runEventSchema`, make `name` required in
`events.ts`, and delete `threadNameOf` in `packages/harness/src/thread-log.ts`. Archived
`run.json` dumps from before step 1 need the docs-repo `convert-t1b.ts` once before import.
