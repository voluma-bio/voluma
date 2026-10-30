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
  structures): a labels volume as one overlay coloured per label (`--label-n` by label value), a
  cropped mask as an overlay at its `offsetZyx`, each with its meshes; named surfaces as meshes
  (their trace in the slices is still to come); annotations aren't drawn yet.
- **Assets.** From `ReviewRun.assets` by the file's sha256: absent is "Preparing…", `failed` is
  its error. For the image that replaces the viewer; for an overlay it is a note under the heading.
  Review refetches while a file of the latest revision has no entry (about ten minutes at most).
- **Display.** The Structures panel's visibility and opacity scale the overlay's blend and the
  mesh; hidden is opacity 0, so a mesh stays loaded. A new scene on the same grid redraws in place.
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
spans source [j·2^k, (j+1)·2^k). A cropped mask carries `offsetZyx` and its levels and mesh are in
crop voxels. The run publishes all geometry; the viewer never resamples between grids, and 3D is
drawn in the grid's own mm (voxel × spacing), not rotated into the scan.

```diagram
GridViewer ── crosshair (z, y, x) ──► SlicePane ×3 ── readPlane ──► zarr.worker (zarrita, chunk cache)
    │                                     │ compose (window, overlays) → RGBA picture
    └─► Grid3D ◄── pictures ──────────────┘   meshes fetched once each
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
- **Window.** From the coarsest level, 1st to 99.9th percentile; editable.

Correctness evidence: `compose.test.ts` pins where a cropped, downsampled overlay lands; worker
planes matched `labels.npy` of OA6-1RK exactly on all three axes ([#188](https://github.com/voluma-bio/voluma/pull/188)).
