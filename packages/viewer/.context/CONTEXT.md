# Viewer specification

The **grid viewer** (`src/grid/`, entry `@voluma/viewer/grid`) reviews one analysis grid of a run
from its converted review assets. Review shows each output on its own grid: `reviewGrid` (`review.ts`)
picks the grid and builds the scene from the run's blocks. three.js and the zarr reader load only
with it (Review imports it lazily).

## An output's grid (`review.ts`)

The run publishes the geometry; the browser aligns nothing. Blocks share a grid when their
volumes share `gridId`, and a block on another grid is listed under the viewer ("On another grid,
not shown here"), never resampled onto this one.

- **Which grid.** The grid most of the focused item's `on` blocks and `volumeId` sit on; else the
  grid most of the output's shown blocks sit on; else the scan's grid, the first image volume's. The grid's image is
  its `image` volume with `.npy` data; spacing is the norms of its affine's columns.
- **What is drawn.** Context first: the labels volume on the grid that the most label structures
  point into (the run's bone labels), every label as one overlay in `--label-n` (`--bone` with
  Labels off), its meshes at 0.3 opacity when the output has meshes of its own. Then the named
  structures on the grid (a named labels volume brings all its structures and is then drawn
  opaque in its own colours, the output as a whole) in `--output`, outlined on slices (a pixel
  whose 4-neighbour differs is opaque, `compose.ts`): a label of a labels volume, a
  cropped mask as an overlay at its `offsetZyx`, each with its meshes; named surfaces as meshes
  and their triangle intersections with each slice. Named rulers and points map from world mm
  through the image's affine into source voxels. Rulers use `--ruler`, with endpoints in 3D and
  on slices; only the part within half a source voxel of a slice is shown, never a projection
  from another slice. In 3D annotations draw over the anatomy so a ruler stays readable.
  Coplanar surface patches show their boundary, not their triangle diagonals; intersections
  are cached by geometry, mesh offsets and slice coordinate, independently of display settings.
- **Assets.** From the run's `assets.ready`/`assets.failed` events by the file's sha256
  (`reviewAssetsOf`, run-view): absent is "Preparing…", `failed` is its error. For the image that
  replaces the viewer; for an overlay it is a note under the heading.
- **Display.** The Labels toggle (on by default) changes the context's colours
  without moving the camera or crosshair. A new scene on the same grid redraws in place.
- **Focus.** A To check item's focused blocks are drawn in `--check-outline`; so is its `volumeId` labels volume (a disagreement mask), only its `label` if given,
  drawn even when no structure brings it. The crosshair goes to its `point`, or its `box` centre, only on the scan's grid (they
  are scan voxels); else the middle of its cropped masks; else of its annotations (world mm through
  the grid's own affine, a projection on each orthogonal column); else, for labels, the middle of
  their bounding box on the coarsest labels level that has them, up to about 32 M voxels
  (`labelsMiddle`). Surfaces give no point. Each item selection moves the crosshair once; the
  Labels toggle never does.

## The viewer: one analysis grid from converted review assets

`QuadViewer` takes a `GridScene`: the grid's shape and voxel size, its image, overlays and meshes
made on that same grid, each a converted asset (`assets.ready`: OME-Zarr 0.4 levels, finest first,
level k = 2^k source voxels per axis; raw meshes, float32 voxel (x, y, z) then uint32 indices).
Every position is a source voxel (z, y, x) of the grid; source voxel i is centred on i, level voxel j
spans source [j·2^k − ½, (j+1)·2^k − ½). A cropped mask carries `offsetZyx` and its levels and mesh are in
crop voxels. The run publishes all geometry; the viewer never resamples between grids, and 3D is
drawn in the grid's own mm (voxel × spacing), not rotated into the scan.

```diagram
QuadViewer ── crosshair (z, y, x) ──► SlicePane ×3 ── readPlane ──► zarr.worker (zarrita, chunk cache)
    │                                       compose (window, overlays) → RGBA picture
    └─► Grid3D ── readLevel (whole level) ──► volume rendering; meshes fetched once each
```

- **Panes.** `QuadViewer` names planes by the grid's axes (XY holds z, XZ y, YZ x) and colours them by the anatomy the caller gives per grid
  (`planes`, from the base's catalog entry); without it they are uncoloured. Its views stay
  mounted and move between CSS grid cells, so a chip swap, a layout change or full screen never
  remounts a pane; the layout is the caller's, the seams the viewer's.
  Rows run down, so z runs down in every slice pane and in 3D (`camera.up` = −z).
- **Levels.** A pane opens on the coarsest level and loads the level whose voxel still covers at
  least one device pixel at its zoom; the coarse picture shows meanwhile unless the finer one lands
  within 80 ms. Overlays load at the image level's scale (nearest: a label never blends).
- **Worker.** One module worker reads every plane. Decoded 64³ chunks share one LRU cache
  (384 MiB); fetches wait for 12 slots, newest first, and a chunk no live request still wants is
  never fetched. A 404 chunk is the fill value (zarr v2 omits empty chunks).
- **Interaction.** Left drag sets the crosshair; wheel, arrows and Page Up/Down step slices;
  Ctrl/⌘ + wheel zooms at the pointer; Shift, middle or right drag pans; zoom is relative to the
  pane's fit, so resizing and maximizing keep the framing. In 3D, orbit controls; a click (not a
  drag) on a mesh moves the crosshair to the voxel under it. Loading never moves the crosshair or
  camera; a new `focus` voxel (a check's) moves the crosshair. A pane with no size (hidden) draws
  nothing; showing it resizes it, which draws, so a caller may keep a viewer mounted and hidden.
- **Marks.** With `tool` set, left clicks and drags mark instead of moving the crosshair, and
  `onMark` gets a `GridMark`: the contract's `MarkShape` (`agent-events.ts`, read-only); the caller
  adds the `volumeId` from `ReviewGrid.imageId`. The caller holds the marks and passes them back as
  `ShownMark`s. Point: a click; on a slice the voxel under the pointer, in 3D the nearer of the
  first shown mesh (a see-through shell included) and the volume where it turns half opaque by
  `volume.ts`'s opacity (a CPU march of the shown byte texture, with the shader's trilinear
  filtering and step count); on empty space nothing. 3D meshes carry
  a bounds tree (`three-mesh-bvh`) so the hover search is cheap enough to run every frame. A ring shows where it would land; the crosshair
  moves to the new point. Box: a drag on a slice; across the held axis it takes the smaller
  dragged side in mm, centred on the slice. Line: a drag on a slice (sub-voxel ends on that
  slice), or in 3D from one surface point to another (a drag that starts off the surface still
  rotates). Lasso: freehand on a slice, closed, at most 500 points. Lengths and areas are mm from
  the grid's spacing. Esc, pointer cancellation or changing tools drops a mark being drawn;
  releasing a 3D line off the surface drops it too. Marks draw on a 2D canvas over each pane in
  screen pixels (`marks.ts`, `useMarkLayer`; the draft and ring redraw only that canvas): yours in `--mark-mine`, the AI's dashed in `--mark-ai`, with a tag
  and the measure; a slice shows what lies on it (a crossing line as a dot), 3D shows all of it.
- **Snapshot.** `ref` → `snapshot(maxBytes)`: each pane draws and is copied in the same task
  (WebGL keeps no buffer), picture then committed marks (no draft or hover cursor), composed as
  laid out on screen with each pane's name. The sheet freezes before the first await; smaller
  encodes never reread live panes. Tries 1600, 1200, 800, 560, then 400 pixels wide (never above
  the screen's pixel ratio, skipping duplicate widths); null if none fits or any shown pane is
  loading, refining or failed. The caller freezes its marks and grid identity at invocation.
- **Window.** From the coarsest level, 1st to 99.9th percentile; editable.
- **3D.** The meshes; the image is volume-rendered only when the scene has none (the scan before
  segmentation, not loaded otherwise), no slice planes: the coarsest level at once, then the
  finest level of at most 16 M voxels (`volume.ts`), as an 8-bit 3D texture between the window
  limits, ray-marched with gradient lighting in `--bone`. The meshes render first into a target
  with depth and each ray stops at it, so a structure inside the bone shows where it is.

## Tilted planes, tools and saved views

- **Where a pane lies.** Each slice pane has a basis in the grid's mm, (z, y, x): `right`, `down`,
  `normal` (`frame.ts`). On the grid's axes a pane reads whole slices from zarr as above. Tilted,
  it is resliced on the CPU (`reslice.ts`) from one whole level shared with the 3D pane
  (`holdLevel`, at most 16 M voxels): the image trilinear, overlays nearest. A whole level is
  read once while anyone holds it and dropped when the last pane holding it unmounts or untilts;
  nothing outlives the viewer. So a tilted pane is
  softer than an untilted one at high zoom. Its counter is primed (′) on the nearest axis and steps
  the grid's finest spacing along its normal; marks within half a step of the plane count as on it.
- **Tilting by hand.** With Navigate, hovering a slice pane shows a handle near each end of the
  other two planes' lines; dragging one turns those two planes about this pane's normal (this pane
  stays still).
- **Align.** Targets come from the caller (`planeTargets`, `targets.ts`): a plane fitted (least
  squares, `fitNormal`) through the vertices of every published surface whose catalog entry has
  `fitsPlane` (mouse-oa: both growth-plate faces, so "GP"), and every other image grid's axes.
  Aligning to a plane turns the pane nearest it onto it, the others following by Gram–Schmidt;
  aligning to a grid takes its axes, flipped so no pane shows mirrored. The fitted plane also gives
  the GP view, a fifth pane coloured as the nearest anatomy. GP is data, not a side effect of
  picking it: whenever the layout shows GP (picked, carried from another grid, or a reopened saved
  view) the plane is fitted; a grid with nothing to fit shows the view GP replaced in that slot. A target with no published surface is
  listed as "Not traced yet". The fit uses each face's whole height field, rim included, so it can
  differ by a few degrees from a fit inside the bone only (ce5a0f21: 9.97° against the mockup's 12.16°).
- **Tools.** Beyond the marks above: a point may carry a note (typed in place) or a probe value
  (the image under the cursor, from the pane's loaded level, `≈` when coarser than full
  resolution); a line is two clicks or a drag; an angle is three clicks; an outline has no held
  axis (its area by Newell's method, so it works on a tilted plane); a path is an open freehand
  line on one slice pane, kept with at least two points, its length beside its last point, with
  no draggable ends. Points, lines and angles show in every pane and in 3D; an outline or a path
  shows on the slice it was drawn on and in 3D. Every kind is sent whole as a `mark.placed`
  (`MarkShape`, `packages/contracts/src/agent-events.ts`).
- **Saved views.** `saved-view.ts` stores a view in `quad_view.py`'s `.view.json` keys where they
  mean the same (`version` 2, `center_zyx`, `panes` with `normal`, `up`, `right` and `axis`,
  `window`), plus `shown` and a `review` block (grid, aligned target, layout, each pane's zoom and
  centre or 3D camera). `readView` refuses a view of another grid or one an agent drew.

Correctness evidence: `compose.test.ts` pins where a cropped, downsampled overlay lands; worker
planes matched `labels.npy` of OA6-1RK exactly on all three axes ([#188](https://github.com/voluma-bio/voluma/pull/188)).
