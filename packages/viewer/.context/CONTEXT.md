# Viewer specification

The **grid viewer** (`src/grid/`, entry `@voluma/viewer/grid`) reviews one analysis grid of a run
from its converted review assets. Review shows each output on its own grid: `reviewGrid` (`review.ts`)
picks the grid and builds the scene from the run's blocks. three.js and the zarr reader load only
with it (Review imports it lazily).

## An output's grid (`review.ts`)

The run publishes the geometry; the browser aligns nothing. Blocks share a grid when their
volumes share `gridId`, and a block on another grid is listed under the viewer ("On another grid,
not shown here"), never resampled onto this one. One exception: a grid with no labels of its own
(the aligned tibia grid) shows the scan grid's context label meshes in 3D, moved rigidly through
the two volumes' affines (`GridMesh.placement`, a matrix applied to the geometry; no slice overlay).
It does so only when both affines carry a pose (an origin or a rotation): a spacing-only diagonal,
a resampled grid's included, places nothing correctly. The harness publishes each sidecar's
`affine_xyz_to_world_mm` (`report-output.ts` `detailFromSidecar`); runs published before that
carry spacing-only affines and borrow nothing.

- **Which grid.** The grid most of the focused item's `on` blocks and `volumeId` sit on; else the
  grid most of the output's shown blocks sit on; else the scan's grid, the first image volume's. The grid's image is
  its `image` volume with `.npy` data; spacing is the norms of its affine's columns.
- **What is drawn.** Context first: the labels volume on the grid that the most label structures
  point into (the run's bone labels), every label as one overlay in `--label-n` (`--bone` with
  colours off), its meshes at 0.3 of their opacity when the output has meshes of its own. Then the named
  structures on the grid (a named labels volume brings all its structures and is then drawn
  opaque in its own colours, the output as a whole) in `--output`, highlighted on slices (filled
  stronger, and a pixel whose 4-neighbour differs is opaque: `OverlayStyle`, `compose.ts`): a label of a labels volume, a
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
- **Display.** `LabelDisplay`, the caller's (the input review's Labels tab): colours on or off,
  an overall opacity, each context label's opacity and whether it is hidden (by block id; mesh
  opacity follows, 0 hides; the subject's own region and a check's always draw whole), and Fill
  or Outline, where outline draws only edge pixels on the slices (highlighted regions too). A
  check's disagreement mask takes one colour for every region (`Overlay.color` as a string). None of it moves the camera or crosshair. A new scene on the same
  grid redraws in place. `reviewGrid` returns the `legend`: each structure drawn, its colour,
  and whether it is context, the output's own, or the check's, with its usual colour when
  recoloured.
- **Focus.** A To check item's focused blocks are drawn in `--check-outline`; so is its `volumeId` labels volume (a disagreement mask), only its `label` if given,
  drawn even when no structure brings it. A labels volume named in `on` is the item's subject as a
  whole: its labels keep their own colours. An item that singles something out (a label, a mask, an
  annotation, a point or box, a `volumeId`) dims the other context labels (their opacity times 0.35 on slices, 0.12 for
  their meshes). Its region: its `point`, or its `box`, only on the scan's grid (they are scan
  voxels); else the box around its cropped masks; else around its annotations (world mm through the
  grid's own affine; one ruler puts the crosshair on its first end); else, for labels, their
  bounding box on the coarsest labels level that has them, up to about 32 M voxels (`labelsBox`),
  every nonzero label for a whole volume. Surfaces give no region. Each item selection moves the
  crosshair to the region's middle and frames it once (`QuadViewer` `focus.box`, `PaneHandle.frame`):
  each slice pane zooms until the box fills about four fifths of it (at least 48 voxels across, never
  out past the fit; a pane with no size frames when it gets one), 3D looks at it from its current
  side. A display change never moves anything.

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

- **Panes.** A plane is the grid's XY (holds z), XZ (y) or YZ (x); `QuadViewer` names and colours
  each by the anatomy the caller gives per grid (`planes`, from the base's catalog entry:
  "Axial"), and without it names it by its axes, uncoloured. The fitted plane is named by its
  target ("Growth plate"). The slice counter is a quiet corner number; the scale bar (the longest
  round length under 100 px) shows only when the grid is `measured` (the run published its
  affine; else its spacing is one per voxel). Its views stay
  mounted and move between CSS grid cells, so a chip swap, a layout change or full screen never
  remounts a pane; the layout is the caller's, the seams the viewer's.
  Rows run down, so z runs down in every slice pane and in 3D's opening view (`camera.up` = −z;
  −y when that view looks within 10° of z).
- **Levels.** A pane opens on the coarsest level and loads the level whose voxel still covers at
  least one device pixel at its zoom; the coarse picture shows meanwhile unless the finer one lands
  within 80 ms. Overlays load at the image level's scale (nearest: a label never blends).
- **Worker.** One module worker reads every plane, and reslices tilted ones (`readSlice`). Decoded 64³ chunks share one LRU cache
  (768 MiB: three panes' level-0 planes and labels, about 410 MB tilted on OA6-1RK); fetches wait for 12 slots, newest first, and a chunk no live request still wants is
  never fetched. A 404 chunk is the fill value (zarr v2 omits empty chunks).
- **Interaction.** Left drag sets the crosshair; the wheel (and a trackpad pinch) zooms at the pointer,
  as in the 3D pane (Jimmy, Nov 4); Shift + wheel, arrows and Page Up/Down step slices; Shift, middle or right drag pans; zoom is relative to the
  pane's fit, so resizing and maximizing keep the framing. In 3D, drag turns the scene freely
  like a ball (over the top, and rolling near the edge; three's `ArcballControls`), Shift, Ctrl/⌘ or right
  drag pans, wheel or middle drag zooms, and the pane's reset button returns to the opening view; a click (not a
  drag) on a mesh moves the crosshair to the voxel under it. The three slice planes through the
  crosshair are drawn in 3D where they cut the grid's box (`planeOutline`, frame.ts), in their pane
  colours, over the anatomy; they follow tilts, and Show the planes in 3D, first in the Planes popover, toggles them. 3D opens on the grid's centre, at a
  fixed distance, from the side of the output's own meshes (`GridMesh.own`, set by `review.ts`;
  never context or a focused check), so they sit in front of the see-through context; within 5%
  of the radius of the centre, or with none, from a default side. Only visible own meshes count.
  The camera turns there each time an output's own meshes have loaded, until a gesture or a
  restored view (`show`) has touched it.
  Otherwise loading never moves the crosshair or camera; a new `focus` voxel (a check's) moves the crosshair. A pane with no size (hidden) draws
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
- **Window.** From the coarsest level, 1st to 99.9th percentile; editable under Contrast ("Black at", "White at").
- **3D.** The meshes; the image is volume-rendered only when the scene has none (the scan before
  segmentation, not loaded otherwise), no slice planes: the coarsest level at once, then the
  finest level of at most 16 M voxels (`volume.ts`), as an 8-bit 3D texture between the window
  limits, ray-marched with gradient lighting in `--bone`. The meshes render first into a target
  with depth and each ray stops at it, so a structure inside the bone shows where it is.

## Tilted planes, tools and saved views

- **Where a pane lies.** Each slice pane has a basis in the grid's mm, (z, y, x): `right`, `down`,
  `normal` (`frame.ts`). On the grid's axes a pane reads whole slices from zarr as above. Tilted,
  each picture is resliced in the worker (`reslice.ts`) from only the chunks the plane crosses:
  the image trilinear, overlays nearest, at their own level and offset. Two layers: the coarsest
  level over the grid's whole outline (at most 1024 samples a side), at once, and over it the
  zoom's level (`levelFor` in device pixels, as untilted) in a window around the view, always
  sampled one level voxel apart (`windowAround`): the view grown by half its size each way, capped
  at 1024 samples a side but never under a quarter of the view each way. Panning or zooming out to
  within an eighth of a view of the window's edge loads a new window; the coarse layer shows
  meanwhile. A failed coarse picture is the pane's error only when the fine one fails too. A new depth or turn reloads both,
  from the chunk cache when it can. Its counter is primed (′) on the nearest axis and steps
  the grid's finest spacing along its normal; marks within half a step of the plane count as on it.
- **Turning by hand.** With Navigate, hovering a slice pane shows a handle near each end of the
  other two planes' lines; dragging one tilts those two planes about this pane's normal (this pane
  stays still, `tilt`). Spinning turns the image of the pane you look at in place, about the
  crosshair, and the other two planes follow (`spin`: all three panes turned about that pane's
  normal), as in DataViewer or Amira, so the tibia's shaft can be stood upright in the coronal and
  then the sagittal view: Alt + left drag in the pane, a dial about the crosshair; `,` / `.` turn the
  pane under the pointer (else the focused one) 1° anticlockwise / clockwise, 0.1° with Shift (not
  `[` `]`: `]` folds the shell's right side); or the tool bar's Planes popover, ±1° and
  ±5° per plane. Every turn keeps each pane a rotation of its grid pane, never a mirror. How far
  the planes are turned (`offGrid`) is the largest turn taking a grid pane onto its pane, so a pane
  spun in its own plane counts; the words ("Turned 3.6°") and Reset follow the panes' own on-grid
  test, so a pane a hair off the grid says "Turned 0.0°" rather than hiding behind the grid's
  name. Planes (one popover: where the planes lie, Align, Turn, and Reset) names the grid on its
  axes (`gridName`: "Along the tibia long-axis grid"), and Reset says where it goes back to; the
  bar itself says only how far the planes are turned, when they are.
- **Align.** Targets come from the caller (`planeTargets`, `targets.ts`), after the shown grid
  itself: the frames tasks oriented for, then a plane fitted (least squares, `fitNormal`) through
  the vertices of every published surface whose catalog entry has `fitsPlane` (mouse-oa: both
  growth-plate faces, so "GP"), then the other grids. The grids are `outputBlocks`' `grids`
  (run-view, the one reader of a grid's `detail`): every base or file output whose `detail`
  carries the sidecar's grid hash and its affine, one per hash, a base claiming it before a file
  (so the scan's hu.json never names the scan). Each is named by its catalog entry and tagged
  with the task that published it. A grid whose axes are the shown grid's is left out (on runs
  before the harness published poses every grid has the scan's). Nothing is fetched to list or
  align to a grid. The affine maths is in `@voluma/contracts/ruler`.
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
