# Scan review: deferred work

## Recorded-run acceptance

- [#142](https://github.com/voluma-bio/voluma/issues/142): Jimmy still needs to explain a recorded
  run's task purpose, work, evidence and remaining decisions unaided, without a jargon table.
  The browser walk of ce5a0f21 establishes reachability, not researcher comprehension.
- [#145](https://github.com/voluma-bio/voluma/issues/145): verify genuine recorded post-#306
  provider fail-fast, waiting (lost-lease) and awaiting-keys states when records are available.
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
- **Snapshots.** Saving what the viewer shows. A message to the AI carries a picture of the
  views (`GridViewer`'s `snapshot`), but saved review snapshots and showing a sent message's
  picture in the chat still wait: `createReviewSnapshot`, `listReviewSnapshots`
  (`/api/review/runs/:runId/snapshots`) and `runMessageSnapshotUrl`.
- **Values CSV and report export.** The old review exported the latest revision's values (with
  result revision and evidence ids, formulas escaped). Nothing to wait on in the API: it is built
  from `getReviewRun`.
- **Older revisions.** The scan review always shows the latest results; the old `?revision=` let
  a reader open an earlier one read-only, and the redirect now drops it. The data is already in
  `getReviewRun` (`revisions`).
- **Whether `NeedItem` ids stay stable across a redo's new revision**, which `useAccepting`'s
  local `done` set relies on. Not checked.

## Usability, found walking a corrected run end to end (31 Oct)

None of these stops a review; each makes it slower.
- **The chat doesn't scroll to its end when opened.** At 1280x800 the AI's latest card (a finished
  redo, or an offer's buttons) can sit under the message box until a send shortens it.
- **To check opens on nothing when the task in view has no items.** The panel reads "Nothing to
  check in <task>" above the list; picking the first open item would save a click.
- **The Report graph pushes the selected task's values below the fold** on a run with several
  second-check tries per task (one row per try). The values are what the researcher came for.
- **A lost send response can drop an answer to the AI's offer.** If the stored answer reaches the
  stream before the send's `onSuccess`, the stale-answer check in `ai-panel.tsx` clears the answer
  mode and a retry sends a plain message (refused 409). Reasoned from the code, not reproduced.
