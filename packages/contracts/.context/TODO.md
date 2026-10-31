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

## Narrow three stored shapes (step 2 of #319 and of the legacy sweep)

Step 1 left the schemas wide and shipped migration `0019_legacy_event_values` (it rewrites a
`thread.started` with no `name`, a `claim.started` with `after: "provider-outage"`, and
`runs.last_claim_end = 'provider-outage'`; `check-limit` appears in no stored event). Once step 1 is
live on staging and no old runner is running:

1. Re-run `0019`'s SQL as a new idempotent migration (keep its `CASE WHEN type = …` guards: a plain
   `WHERE type = … AND payload->>… ` fails with 22P05 on staging, because Postgres reads the json of
   other rows first).
2. Fetch every staging run's log (`GET /api/run/runs/:id/stream` with `VOLUMA_DEBUG_TOKEN`) and parse
   each event with the new `runEventSchema`; a run that fails is converted or dropped before the merge.
3. In `events.ts`: make `thread.started.name` required; remove `check-limit` from the check-result
   `rule` enum. In `runner.ts` and `apps/api/src/domains/run/schema.ts`: remove `provider-outage` from
   `claimEndReasonSchema` and `runs.last_claim_end`'s type (drop it from the comment in
   `claim-progress.ts` and the notes in `apps/api/AGENTS.md`, `apps/api/.context/deploy.md`).
4. Delete `threadNameOf` in `packages/harness/src/thread-log.ts` (use `e.payload.name`), the
   `check-limit` rule there (`thread-log.ts`, `messages.ts` case) and `"provider-outage"` in the
   `messages.ts` label table.
5. Archived `run.json` dumps from before need the docs-repo `convert-t1b.ts` once before import.
