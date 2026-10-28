# Review workspace specification

Review is one light-themed workspace at `/runs/:runId`. It can open a local
DICOM ZIP or download an authorized input archive, display acquired images and
build a bounded raw volume preview. It does not yet load analysis results, run
analysis, or persist review decisions. `/runs/local` is a workspace identifier,
not a run created in the API. There is no demo route or simulator in the app.

## Scientific results and local images have separate ownership

```diagram
Local ZIP → viewer package → acquired-slice viewport

Future API adapter → ReviewRun snapshot → task report and decisions
```

Opening an image never populates measurements, task checks, segmentation
structures, evidence, messages or revisions. Those require a real analysis
result. The empty report explains this distinction. A locally opened scan is
not verified as the input to a server run, even when opened on that run's URL.

`index.tsx` owns route selection, the file picker, download/import cancellation and the
selected series. It uses `@voluma/api-client` to resolve a run's input and its
download descriptor, then downloads a ZIP through the generic validated transfer.
At `/runs/local`, **Open reference scan** resolves the workspace's reference input;
on a real run, **Open run scan** uses that run's input, never a reference fallback.
The API currently serves only reference archives. Upload archives remain unavailable.
The public `@voluma/viewer` API owns ZIP/DICOM validation, ordering, decoding
and rendering; see the
[DICOM specification][dicom]. Local files never leave the browser. Neither intake
path creates a run or verifies image provenance against analysis results.

## The report UI is retained for the real adapter

The three original phase commits contain the scaffold, reports and simulated
interaction proof. The merged tree contains their presentation components,
but no fixture measurements or simulated service. The current behavior is:

| Area | Behavior |
|---|---|
| Tasks | Ordered tasks from the selected snapshot; selecting one updates the `task` query parameter |
| Revisions | Latest snapshot by default; `revision` selects an earlier, read-only snapshot |
| Measurements | Values retain units, origin, confidence and evidence references; null is unavailable, never zero |
| Evidence/files | Supplied assets can open in the lightbox; unavailable assets explain why |
| Checks/chat/corrections | Disabled without a service; corrections require a proposal with affected tasks, then confirmation |
| CSV | Available only with a real snapshot; includes task result revision and evidence identifiers, and escapes spreadsheet formulas |
| Structures | Visibility/opacity are display state, not scientific edits |
| Viewer layout | Resizable nested panels; maximizing changes CSS layout without remounting the acquired image |

The `report/model.ts` Zod schemas describe the current **presentation model**.
They are not an agreed shared API contract. `ReviewService` describes commands
the existing controls need; no implementation is mounted. A contract PR must
settle the shared shapes before wiring `@voluma/api-client` to this UI. Do not
make a fake transport to fill the empty report.

## Intake remains usable through errors and replacement

Both intake paths share ZIP validation, progress and cancellation. Downloads accept
only ZIPs, cap compressed bytes at 2 GiB, and reject incorrect headers/signatures;
the importer's expanded-data limit is separate, not a browser memory budget.
Missing R2 configuration gives a setup error while local intake stays available.
A successful single-series import opens automatically; a multi-series import requires an
explicit choice. Opening another ZIP clears the current scan first, so an error
cannot leave old images under a new selection. Close, replacement and route
changes terminate the import worker and release viewer resources. Reloading
loses local scan state; query parameters never contain local files or identifiers.

The light Review chrome surrounds a dark imaging well. The first loaded image
is an acquired slice, not necessarily axial. The **3D preview** slot builds a
raw volume only on request, validates reconstructable geometry separately, and
labels downsampling and the absence of anatomical meshes. Its rotation, zoom,
intensity and opacity controls affect display only. Release 3D preserves slices;
maximize/restore preserves both engines and camera state. The Performance panel
exports local timings without scan identifiers for workstation comparison.
Coronal and sagittal slots remain unavailable. At narrow widths the existing
layout stacks report and imaging areas; desktop panel sizes and image state
remain independent.

## Integration with the Run lane

Jimmy's scaffold PRs [#1], [#2] and [#3] supply the application shell, package
boundaries, API domain factories and real-data policy. Review replaces the
scaffold's Review placeholder, not its Run screens or `/dev/ui`. Shared contracts
and API client match upstream. There is no competing `apps/app` application.

Analysis result lookup, provenance matching between images and results, mutations
and event streaming remain unconnected. The cross-lane
dependencies are listed in the [repository TODO][todo]. Local viewing does not
depend on those services; scientific processing does.

[dicom]: ../../../../../../packages/viewer/.context/CONTEXT.md
[todo]: ../../../../../../.context/TODO.md
[#1]: https://github.com/voluma-bio/voluma/pull/1
[#2]: https://github.com/voluma-bio/voluma/pull/2
[#3]: https://github.com/voluma-bio/voluma/pull/3
