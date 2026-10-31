# Scan review: deferred work

## Recorded-run acceptance

- [#142](https://github.com/voluma-bio/voluma/issues/142): Jimmy still needs to explain a recorded
  run's task purpose, work, evidence and remaining decisions unaided, without a jargon table.
  The browser walk of ce5a0f21 establishes reachability, not researcher comprehension.
- [#145](https://github.com/voluma-bio/voluma/issues/145): verify genuine recorded post-#306
  provider fail-fast, paused lost-lease and awaiting-keys states when records are available.
  The retained 2026-10-30 archive covers historical error rendering and attribution only.
  Do not synthesize those records or restore spend caps/outage holds. Acceptance status stays
  with #210/#174. Bounded rendering fixes: [#327](https://github.com/voluma-bio/voluma/pull/327).

## Features removed with the old review

The old review (`features/review`, deleted in #310) had these; the scan review doesn't yet. The
API routes and `@voluma/api-client` calls they need are still in place, waiting for them.

- **Mark reviewed.** A completed run can no longer be marked "Reviewed", though `runStatus` still
  shows the word for runs marked before. Waiting: `markReviewed(runId, { baseRevisionId })`
  (`POST /api/review/runs/:runId/mark-reviewed`), allowed once nothing is left to check. Never infer it
  from acceptance.
- **Snapshots.** Saving what the viewer shows (and sending it with a message to the AI). Waiting:
  `createReviewSnapshot`, `listReviewSnapshots` (`/api/review/runs/:runId/snapshots`), and
  `runMessageSnapshotUrl` for a message's snapshot. The viewer's capture hook went with the old
  `TaskViewer`.
- **Values CSV and report export.** The old review exported the latest revision's values (with
  result revision and evidence ids, formulas escaped). Nothing to wait on in the API: it is built
  from `getReviewRun`.
- **Older revisions.** The scan review always shows the latest results; the old `?revision=` let
  a reader open an earlier one read-only, and the redirect now drops it. The data is already in
  `getReviewRun` (`revisions`).
- **Whether `NeedItem` ids stay stable across a redo's new revision**, which `useAccepting`'s
  local `done` set relies on. Not checked.
