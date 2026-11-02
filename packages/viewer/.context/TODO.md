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
- `GridViewer` and `QuadViewer` share their crosshair, contrast and readiness code by copy. When
  the task review goes, delete `GridViewer` (its snapshot moves to `QuadViewer` once messages
  carry marks on agent-loop runs).
- `QuadViewer`'s GP view (the plane along the growth plate), tilting, Align and Save view come with
  the plane tools (phase 6, second half); GP is listed and disabled until then.
