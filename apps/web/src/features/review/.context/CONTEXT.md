# Review workspace specification

Review is one light-themed workspace at `/runs/:runId`. It downloads an
authorized R2 input archive, displays acquired images and
automatically opens a full-resolution raw volume. On a real run it loads the run's results
(`getReviewRun`, the shared `ReviewRun`). Accept check and Mark reviewed persist human
decisions through the API; the workspace never runs analysis. `/runs/local` opens the R2 reference scan
without creating a run in the API. There is no local-file intake or simulator.

## Scientific results and acquired images have separate ownership

```diagram
Authorized R2 archive → viewer package → acquired-slice viewport

GET /api/review/runs/:runId → ReviewRun → task report and decisions
```

Opening an image never populates measurements, task checks, segmentation
structures, evidence, messages or revisions. Those require a real analysis
result. The empty report explains this distinction. A real run resolves its own
input; the standalone reference workspace does not represent analysis results.

`index.tsx` owns route selection, download/import cancellation and the
selected series. It uses `@voluma/api-client` to resolve a run's input and its
download descriptor, then downloads a ZIP through the generic validated transfer.
At `/runs/local`, **Open reference scan** resolves the workspace's reference input;
on a real run, **Open run scan** uses that run's input, never a reference fallback.
The API currently serves only reference archives. Upload archives remain unavailable.
The public `@voluma/viewer` API owns ZIP/DICOM validation, ordering, decoding
and rendering; see the [DICOM specification][dicom]. Opening a scan does not create
a run or populate the results report.

## The report renders the shared ReviewRun

`index.tsx` loads `getReviewRun(runId)` with React Query; `/runs/local` loads
nothing. A 409 (the run has no plan) and a 404 show a notice in place of the
report. The behavior is:

| Area | Behavior |
|---|---|
| Tasks | Ordered tasks from the selected revision, each with its status badge; selecting one updates the `task` query parameter |
| Revisions | Latest snapshot by default; `revision` selects an earlier, read-only snapshot |
| Measurements | Measurements, scores and declared outputs the task didn't report, with units and confidence; null is unavailable, never zero |
| Models | The worker's and checker's model, when the run recorded them |
| Evidence/files | Checkpoint images (by `.jpg`/`.png` name) load lazily through `reviewFileUrl` and open in a lightbox with a download; other evidence and data files are download links. The server decides what renders inline from the bytes |
| Checks | Accept check persists acceptance for the latest completed non-example result; earlier revisions, examples and unfinished runs are read-only. Acceptance does not change values, confidence, checker verdict or scientific task status |
| Run review | The shared summary shows N to check, Completed at zero, and Reviewed only after explicit Mark reviewed. Mark reviewed is disabled until zero, and never inferred from acceptance |
| Header and scan intake | Status sits beside the sample title. Mark reviewed, Revision and Export CSV share one header action row. Scan loading, series selection, progress and errors live in the imaging toolbar; `index.tsx` supplies them as `ViewerWorkspace` children |
| Chat/corrections | Disabled; no command adapter or simulated responses |
| CSV | Available only with a real snapshot; includes task result revision and evidence identifiers, and escapes spreadsheet formulas |
| Structures | Visibility/opacity are display state, not scientific edits |
| Viewer layout | Resizable nested panels; maximizing changes CSS layout without remounting the acquired image |

`report/model.ts` re-exports contract types and supplies scientific status labels.
Controls use `@voluma/api-client` directly. Mutations wait for a refetch rather than
optimistically changing a count or overwriting newer state with an older command response.
Errors remain visible and trigger a refresh, including stale-revision conflicts.
If that refresh fails, the retained snapshot shows a Retry warning and decisions stay
disabled until a successful refresh. A recovered snapshot clears obsolete decision errors.
Do not make a fake transport to fill the empty report.

## Intake remains usable through errors and replacement

Downloads use ZIP validation, progress and cancellation. They accept
only ZIPs, cap compressed bytes at 2 GiB, and reject incorrect headers/signatures;
the importer's expanded-data limit is separate, not a browser memory budget.
Missing R2 configuration gives a setup error; no local-file fallback exists.
A successful single-series import opens automatically; a multi-series import requires an
explicit choice. Opening a scan again clears the current scan first, so an error
cannot leave old images under a new selection. Close, replacement and route
changes terminate the import worker and release viewer resources. Reloading
loses the browser's scan state; query parameters never contain scan bytes.

The light Review chrome surrounds a dark imaging well. The first loaded image
is an acquired slice, not necessarily axial. The **3D** slot automatically builds a
native-grid raw volume and validates reconstructable geometry separately. There
is no resolution picker, build screen or selection metadata in the view corners.
Its rotation, zoom, intensity and opacity controls affect display only. A 3D
failure leaves acquired slices available; maximize/restore preserves both engines
and camera state. There is no benchmark
panel, timer sampling, automated rotation measurement or timing export.
The revision's label volumes overlay acquired slices with the Structures
sidebar's visibility and opacity. A spatial To check title or **Show in viewer**
sets display-only focus for that task and revision, independent of mutation
permissions. **Clear viewer focus** removes the target. Focus does not carry
across tasks or revisions. Both acquired slices and an open raw 3D preview target
the check; this does not produce segmented surfaces.
**Screenshot** persists an acquired-slice PNG plus immutable view state through
the Review API. The run-wide tray reopens its pinned task/revision and offers PNG
and JSON downloads. The original scan must be open for geometry-checked restore.
**Export review report** builds an offline ZIP containing escaped HTML,
measurements CSV, revision JSON and hash-verified screenshot PNG/JSON pairs.
`{snapshot:id}` references resolve only within that run and revision; unresolved
references are marked. This is a review report, not a full scientific export:
it includes no raw scan, masks or other analysis files.
Coronal and sagittal slots remain unavailable. At narrow widths the existing
layout stacks report and imaging areas; desktop panel sizes and image state
remain independent.

## Integration with the Run lane

Jimmy's scaffold PRs [#1], [#2] and [#3] supply the application shell, package
boundaries, API domain factories and real-data policy. Review replaces the
scaffold's Review placeholder, not its Run screens or `/dev/ui`. Shared contracts
and API client match upstream. There is no competing `apps/app` application.

Provenance matching between images and results, chat/corrections
and continuous review event streaming remain unconnected. The cross-lane
dependencies are listed in the [repository TODO][todo]. Scan viewing depends on
the authorized R2 download, not the analysis result adapter.

[dicom]: ../../../../../../packages/viewer/.context/CONTEXT.md
[todo]: ../../../../../../.context/TODO.md
[#1]: https://github.com/voluma-bio/voluma/pull/1
[#2]: https://github.com/voluma-bio/voluma/pull/2
[#3]: https://github.com/voluma-bio/voluma/pull/3
