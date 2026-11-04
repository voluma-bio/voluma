# Viewer follow-up

- Selection framing (frame the `on` blocks, move the slices only on a user's selection), and 3D
  Slicer's mouse and keyboard map (#146).
- A check's `point` and `box` are scan voxels, so they place the crosshair only on the scan's grid.
  A check on an aligned grid can only point through its `on` blocks until the contract gives the
  focus a grid.
- Chunk reads cost one API redirect each. A full-resolution coronal plane of the scan plus its
  labels is about 250 chunk requests; through the orb portal a cold scan grid took 26 s to first
  paint and about 50 s to full resolution while 75 MB of bone meshes loaded beside it. If staging
  is as slow, sign many asset paths in one call or shard the levels.
- Measure scroll and 3D frame times on a hardware GPU: orb Chromium renders with SwiftShader, where
  the 3D pane with the ROI meshes costs hundreds of milliseconds per frame.
- 3D meshes build their bounds tree on the main thread as each loads: on OA6-1RK's six meshes
  (2.6 M triangles) 35 to 350 ms each, about 1 s in all. If that stall shows, build it in a worker
  (`three-mesh-bvh`'s `GenerateMeshBVHWorker`) or only once a tool that searches the surface is out.
- The growth plate's fitted plane takes each face's whole height field. Fitting only inside the
  tibia (as the mockup and iioc-worker did) needs the face to carry its valid region, or the
  worker to publish the plane itself.
- A tilted pane at level 0 reads every chunk its window crosses. On 4df02afe (64³ chunks), the
  whole outline is 80 to 162 chunks per pane, against 72 to 135 for an untilted slice, and the
  4× window 48 to 81. From local dev (R2 behind it) the 4× refine takes 5 to 8 s, against 15 s
  for the whole outline. Showing chunks as they land, nearest the crosshair first, would make
  it feel quicker.
- The saved-view format (`saved-view.ts`, the `review` block of `view.saved`) lives outside
  contracts, whose `viewSchema` is loose: a `QuadLayout` change quietly makes old saved views
  unopenable, with none of the stored-event discipline, and `readView` ignores `version`. Move the
  schema into contracts as the `view.saved` review block, and have `readView` return
  `{ grid, state }` so `useSavedViews.open` stops casting `v.view`.
- `QuadViewer` has one-off sizes (`text-[10px]` on the Align menu's code, `rounded-[2px]` on the
  chip swatch), and no story; neither has `NumberField`, which belongs in `@voluma/ui` with a story
  if anything outside the viewer needs it.
- Borrowed context meshes (`GridMesh.placement`) can reach past the grid's box, while the 3D pane's
  far plane comes from the grid's bounding sphere (`Grid3D.tsx`, `clip`): the knee's far side may be
  cut off when the camera pulls back. Grow `clip` with the loaded meshes' bounds.
- Turning the planes (#567): one window key listener in `QuadViewer` that knows the hovered or focused pane,
  instead of one per `SlicePane` choosing by `[data-slice-pane]:hover`; share the "typing or overlay target"
  check with `apps/web/src/features/input/marking.tsx` and the shell; fold `tilts`/`spins` in `QuadViewer`
  into one helper; `finish()` in `slice-gestures.ts` asks "is this a marking tool" instead of listing modes.
- 3D pane (#567): the overlay row around the status chip and reset button catches drags that start over it;
  dispose the Arcball gizmo geometry `setTbRadius` replaces on each resize. Ask the expert whether a dial
  turned back to 0° should count as on the grid (today the bar says "Turned 0.0°" until Reset).
- Untilted panes could read through the tilted path (#568 review): with a grid-axis basis, `sampling`
  and `onLevel` already land on level voxel centres (the first `reslice.test.ts` case shows it at
  every level). That deletes `slice`, `compose`'s `lookup`, `readPlane` and the worker's `plane()`,
  and the second coarse/fine policy in `SlicePane` (the 80 ms race against the under-layer), and
  gives untilted level-0 panes the view window too. Worth doing before more lands on `SlicePane`.
- The 3D pane's mesh-depth pipeline has no case left (#568 review): the volume draws only when
  `scene.meshes` is empty, and annotations are a separate scene, so the render target, copy pass,
  depth texture and the shader's stop-at-mesh-depth (`Grid3D.tsx`, `volume.ts`) combine nothing.
  Delete them (the renderer's own antialias covers the four-sample target), or say why they stay.
- The chunk cache (768 MiB) covers three tilted level-0 panes with uint8 labels up to about an
  855³ scan at 30° (710 MB, computed with `crossed`). A bigger scan, or wider labels, thrashes
  again: each crosshair move re-fetches the other panes' chunks. Then budget the fine request per
  pane (shrink the window toward the view) rather than coarsen fit zoom.
