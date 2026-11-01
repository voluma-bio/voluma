# Micro-CT skillset TODO

From the structural review of PR #62 (`review-pr62` p231, structure) and the correctness re-check (p230). The round-2 fixes there
(one curve schema and interpolator, one BV owner, one result record) landed; these did not.

- **`frame.to_scan` is slower than the mapping it replaced.** On OA6-1RK's tibia frame it takes 17.7 s against 4.9 s for the
  old `affine_transform` path (`iioc.py` 38.6 s against 18.8 s), with identical output. The bounding-box crop barely helps when the
  frame's box covers most of the scan. Try `ndi.affine_transform(..., order=0)` and check half-voxel rounding still matches.
- **A generic `orient_bone` (left from p231 B2).** The frame module landed (`microct-core/resources/frame.py`); `tibia_frame.py` now only fits
  the axes and crop and calls it (and `envelope.close_and_fill`, beside it). It stayed in `mouse-oa` because its +U medial / +V anterior
  sign rule and crop defaults are the mouse tibia protocol's: moving it to `orient-joint` needs the sign rule behind an argument.
- **Fold the other slice renderers into `quad_view` (left from the quad-view PR).** Boxes as a layer would let `render_slices` (`--boxes`, `--points`; `orient_joint.py` imports its `render()`) and `render_crops` go, with `sam-segmentation` taking its keyframe from a quad pane. The 6-view sheet stays (4 of 4 catches). Also open: `quad_view` draws a point's name in 3D even where the surface hides it; a new mask's surface costs ~9 s cold (marching cubes and smoothing on the aligned grid), later calls reuse the cache.
- **One `--anatomy` profile (p231 M1), what is left.** The QC windows are done: every mouse QC sheet goes through `viewlib.slice_sheet` and
  takes `--window anatomy.json` (`viewlib.window_arg` reads the file's `window_hu`, as every renderer's `--window` now does). Still flags:
  `--names 1=femur,...` (`quad_view`, `render_surfaces`), the required `--threshold-hu` in six scripts, and the speck size, 0.01 mm³ in `unlabelled`
  and `label_stats` and 0.005 in `disagree`; `orient_joint`'s lengths are required flags (the anatomy reference gives them). Direction: one
  `--anatomy` argument read through a `sidecar` helper supplies these defaults (flags only override), so a rat knee needs one new
  `anatomy.json`; `label_stats --ranges` already reads this file.
- **`femoral_frame.py` after the spec move (p231 M2), what is left.** DFL, DFW and W/L are computed by `measure.py` from `protocol.json`; the
  script keeps the landmark checks and the frame. `off_bone_mm` repeats `pick.py`'s snap distance, and the frame vectors (`ml_vector_zyx` and the
  rest) have no reader beyond the SI check: cut them or give them a reader.
- **A kept synthetic-truth test (p230), for the user to decide.** A tilted planar growth-plate face under a flat top, where `iioc.py`'s height
  along W equals h / cos θ and the perpendicular height equals h. The heights moving by 3 to 7% between the two definitions was silent until a
  reviewer recomputed it; the same shape of test would pin plate thickness and node density. None is added.

## From the round-3 review (p246, 2026-10-28)
- `morphometry.py` volume definitions should name the grid the count was made on
  (scan vs aligned); today only the record's `grid_id` says it, and stdout omits it.
- `sidecar.py:78-80`: read the calibration after the `if not header: fail`, drop the ternary.
- `annotations.json` mixes point orders: curves are `[w, u]`, `width_points_uvw` and
  `plate_patches` are `[u, v, w]`. Documented, but a hand-writing agent holds two orders.

## Input checks the parser does not make
- The sidecar a labels or `--like` file needs beside it (`labels.json`) is read by the script: a missing one is a Python error,
  not a sentence. A `sidecar.existing` check for it would close it. (`quad_view`'s `NAME=path` forms are checked by `need_file`.)

## Lengths still in voxels (left by the skills cleanup)
- Internal, not flags: `classic_segment.py` `MARGIN`, `SLAB`, `GRADIENT_RADIUS` (compute halos), `snap_boxes.py` `min_px=50`.

## Which way up a render shows
- `quad_view.py` fixes its 3D camera's view-up to scan +z (`'view_up': [0.0, 0.0, 1.0]`); `--rotate` changes azimuth and
  elevation only. A task that wants its 3D views a particular way up (the femur with its shaft up, as in the mouse-OA
  deck) cannot ask for it. Direction: a view-up argument, kept in `.view.json` so `pick.py` still maps picks. Likewise
  `orient_joint.py` puts bone A above bone B with no override (#429 review).
