# Viewer specification

The **grid viewer** (`src/grid/`, entry `@voluma/viewer/grid`) reviews one analysis grid of a run
from its converted review assets. Review shows each task on its own grid: `taskGrid` (`review.ts`)
picks the grid and builds the scene from the run's blocks. three.js and the zarr reader load only
with it (Review imports it lazily).

## A task's grid (`review.ts`)

The run publishes the geometry; the browser aligns nothing. Blocks share a grid when their
volumes share `gridId`, and a block on another grid is listed under the viewer ("On another grid,
not shown here"), never resampled onto this one.

- **Which grid.** The grid most of the focused check's `on` blocks and `volumeId` sit on; else the grid most of
  the task's named blocks sit on (measurements' and scores' `on`, then `context`, then blocks whose
  id starts with `<taskId>/`); else the scan's grid, the first image volume's. The grid's image is
  its `image` volume with `.npy` data; spacing is the norms of its affine's columns.
- **What is drawn.** The named structures on the grid (a named labels volume brings all its
  structures): a labels volume as one ivory overlay (`--bone`, or `--label-n` with Labels on), a
  cropped mask as an overlay at its `offsetZyx`, each with its meshes; named surfaces as meshes
  and their triangle intersections with each slice. Named rulers and points map from world mm
  through the image's affine into source voxels. Rulers use `--ruler`, with endpoints in 3D and
  on slices; only the part within half a source voxel of a slice is shown, never a projection
  from another slice. In 3D annotations draw over the anatomy so a ruler stays readable.
  Coplanar surface patches show their boundary, not their triangle diagonals; intersections
  are cached by geometry, mesh offsets and slice coordinate, independently of display settings.
- **Assets.** From `ReviewRun.assets` by the file's sha256: absent is "Preparing…", `failed` is
  its error. For the image that replaces the viewer; for an overlay it is a note under the heading.
  Review refetches while a file of the latest revision has no entry (about ten minutes at most).
- **Display.** The View panel lists structures, surfaces and annotations; its visibility and opacity
  scale their drawings in every pane. Hidden is opacity 0, so a mesh stays loaded. The Labels toggle
  changes bone colours without moving the camera or crosshair. A new scene on the same grid redraws in place.
- **Focus.** A check's focused blocks are drawn in `--check-outline` at full opacity, whatever the
  panel says; so is its `volumeId` labels volume (a disagreement mask), only its `label` if given,
  drawn even when no structure brings it. The crosshair goes to its `point`, or its `box` centre, only on the scan's grid (they
  are scan voxels); else the middle of its cropped masks; else of its annotations (world mm through
  the grid's own affine, a projection on each orthogonal column); else, for labels, the middle of
  their bounding box on the coarsest labels level that has them, up to about 32 M voxels
  (`labelsMiddle`). Surfaces give no point. Each check selection moves the crosshair once; display
  changes never do.

## The viewer: one analysis grid from converted review assets

`GridViewer` takes a `GridScene`: the grid's shape and voxel size, its image, overlays and meshes
made on that same grid, each a converted asset (`assets.ready`: OME-Zarr 0.4 levels, finest first,
level k = 2^k source voxels per axis; raw meshes, float32 voxel (x, y, z) then uint32 indices).
Every position is a source voxel (z, y, x) of the grid; source voxel i is centred on i, level voxel j
spans source [j·2^k − ½, (j+1)·2^k − ½). A cropped mask carries `offsetZyx` and its levels and mesh are in
crop voxels. The run publishes all geometry; the viewer never resamples between grids, and 3D is
drawn in the grid's own mm (voxel × spacing), not rotated into the scan.

```diagram
GridViewer ── crosshair (z, y, x) ──► SlicePane ×3 ── readPlane ──► zarr.worker (zarrita, chunk cache)
    │                                       compose (window, overlays) → RGBA picture
    └─► Grid3D ── readLevel (whole level) ──► volume rendering; meshes fetched once each
```

- **Panes.** Axial holds array axis 0, coronal axis 2, sagittal axis 1 (DESIGN.md's axis colours).
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
  camera; a new `focus` voxel (a check's) moves the crosshair.
- **Marks.** With `tool` set, left clicks and drags mark instead of moving the crosshair, and
  `onMark` gets a `GridMark`: the contract's `Mark` (`messages.ts`) without `volumeId`, which the
  caller adds from `TaskGrid.imageId`. The caller holds the marks and passes them back as
  `ShownMark`s. Point: a click; on a slice the voxel under the pointer, in 3D the nearer of the
  first shown mesh and the volume where it turns half opaque by `volume.ts`'s opacity (a CPU march
  of the shown level); on empty space nothing. A ring shows where it would land; the crosshair
  moves to the new point. Box: a drag on a slice; across the held axis it takes the smaller
  dragged side in mm, centred on the slice. Line: a drag on a slice (sub-voxel ends on that
  slice), or in 3D from one surface point to another (a drag that starts off the surface still
  rotates). Lasso: freehand on a slice, closed, at most 500 points. Lengths and areas are mm from
  the grid's spacing. Esc drops a mark being drawn. Marks draw on a 2D canvas over each pane in
  screen pixels (`marks.ts`): yours in `--mark-mine`, the AI's dashed in `--mark-ai`, with a tag
  and the measure; a slice shows what lies on it (a crossing line as a dot), 3D shows all of it.
- **Snapshot.** `ref` → `snapshot(maxBytes)`: each pane draws and is copied in the same task
  (WebGL keeps no buffer), picture then marks, composed as laid out on screen with each pane's
  name, at 1600, 1200, 800 CSS px wide at the screen's pixel ratio, then 560 at 1x, until a PNG
  fits; null if none does.
- **Window.** From the coarsest level, 1st to 99.9th percentile; editable.
- **3D.** The image as a volume rendering, no slice planes: the coarsest level at once, then the
  finest level of at most 16 M voxels (`volume.ts`), as an 8-bit 3D texture between the window
  limits, ray-marched with gradient lighting in `--bone`. The meshes render first into a target
  with depth and each ray stops at it, so a structure inside the bone shows where it is.

Correctness evidence: `compose.test.ts` pins where a cropped, downsampled overlay lands; worker
planes matched `labels.npy` of OA6-1RK exactly on all three axes ([#188](https://github.com/voluma-bio/voluma/pull/188)).
