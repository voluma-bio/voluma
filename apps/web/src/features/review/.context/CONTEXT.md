# Review workspace specification

Review is one light-themed workspace at `/runs/:runId`. It loads the run's results
(`getReviewRun`, the shared `ReviewRun`) and shows the selected task's report beside the
task's own analysis grid in the grid viewer. Accept check and Mark reviewed persist human
decisions through the API; the workspace never runs analysis. There is no local-file intake,
scan download or simulator.

## Results and images both come from the run

```diagram
GET /api/review/runs/:runId → ReviewRun → task report and decisions
                                        └→ taskGrid (blocks + assets) → GridViewer
GET /api/review/runs/:runId/assets/:sha256/* → converted levels and meshes
```

`report/TaskViewer.tsx` (lazy, with three.js) asks `@voluma/viewer/grid`'s `taskGrid` for the
selected task's grid, with the Structures panel's display settings and the focused check, and
shows the grid viewer or why it can't yet ("Preparing … for viewing", a conversion error, no
image). How the grid and its overlays are chosen is in the [viewer specification][viewer].

## The report renders the shared ReviewRun

`index.tsx` loads `getReviewRun(runId)` with React Query. A 409 (the run has no plan) and a 404 show a notice in place of the
report. The behavior is:

| Area | Behavior |
|---|---|
| Tasks | Ordered tasks from the selected revision, each with its status badge; selecting one updates the `task` query parameter |
| Revisions | Latest snapshot by default; `revision` selects an earlier, read-only snapshot |
| Measurements | Measurements, scores and declared outputs the task didn't report, with units and confidence; null is unavailable, never zero |
| Models | The worker's and checker's model, when the run recorded them |
| Evidence/files | Checkpoint images (by `.jpg`/`.png` name) load lazily through `reviewFileUrl` and open in a lightbox with a download; other evidence and data files are download links. The server decides what renders inline from the bytes |
| Checks | Accept check persists acceptance for the latest completed non-example result; earlier revisions, examples and unfinished runs are read-only. Acceptance does not change values, confidence, checker verdict or scientific task status |
| Run review | The shared summary shows N to check, Checked at zero (the word Home and the study page use, `@voluma/ui/run`), and Reviewed only after explicit Mark reviewed. Mark reviewed is disabled until zero, and never inferred from acceptance |
| Header | Status sits beside the sample title. Mark reviewed, Revision and Export CSV share one header action row |
| Chat/corrections | Disabled; no command adapter or simulated responses |
| CSV | Available only with a real snapshot; includes task result revision and evidence identifiers, and escapes spreadsheet formulas |
| Structures | Structures and surfaces, each with visibility/opacity: display state, not scientific edits |
| Viewer layout | Resizable nested panels; maximizing changes CSS layout without remounting a pane |

`report/model.ts` re-exports contract types and supplies scientific status labels.
Controls use `@voluma/api-client` directly. Mutations wait for a refetch rather than
optimistically changing a count or overwriting newer state with an older command response.
Errors remain visible and trigger a refresh, including stale-revision conflicts.
If that refresh fails, the retained snapshot shows a Retry warning and decisions stay
disabled until a successful refresh. A recovered snapshot clears obsolete decision errors.
Do not make a fake transport to fill the empty report.

## The imaging panel

The light Review chrome surrounds a dark imaging well: 3D, axial, coronal and sagittal panes of
the task's grid, titled with the grid's volume name. Switching to a task on another grid remounts
the viewer; the same grid keeps its crosshair and panes. The Structures sidebar's visibility and
opacity change display only, in place. A spatial To check title or **Show in viewer** sets
display-only focus for that task and revision, independent of mutation permissions: the focused
blocks are drawn in the check colour and the crosshair moves to them where the run says where
they are. **Clear viewer focus** removes it. Focus does not carry across tasks or revisions. At
narrow widths the layout stacks report and imaging areas.

## Integration with the Run lane

Jimmy's scaffold PRs [#1], [#2] and [#3] supply the application shell, package
boundaries, API domain factories and real-data policy. Review replaces the
scaffold's Review placeholder, not its Run screens or `/dev/ui`. Shared contracts
and API client match upstream. There is no competing `apps/app` application.

Provenance matching between images and results, chat/corrections
and continuous review event streaming remain unconnected. The cross-lane
dependencies are listed in the [repository TODO][todo].

[viewer]: ../../../../../../packages/viewer/.context/CONTEXT.md
[todo]: ../../../../../../.context/TODO.md
[#1]: https://github.com/voluma-bio/voluma/pull/1
[#2]: https://github.com/voluma-bio/voluma/pull/2
[#3]: https://github.com/voluma-bio/voluma/pull/3
