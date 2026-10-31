# Scan review: deferred work

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
- **Study pages link without an item.** `features/study` sends `/runs/:runId?task=` (study
  page) and `/runs/:id/live` (new study); both redirect, and the scan review opens the task's
  first open item. They should link `runHref` with `item=<checkId>` (#309).
- **Whether `NeedItem` ids stay stable across a redo's new revision**, which `useAccepting`'s
  local `done` set relies on. Not checked.
