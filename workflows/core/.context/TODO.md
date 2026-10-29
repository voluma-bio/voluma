# Micro-CT skillset TODO

From the structural review of PR #62 (`review-pr62` p231, structure) and the correctness re-check (p230). The round-2 fixes there
(one curve schema and interpolator, one BV owner, one result record) landed; these did not.

- **`frame.to_scan` is slower than the mapping it replaced.** On OA6-1RK's tibia frame it takes 17.7 s against 4.9 s for the
  old `affine_transform` path (`iioc.py` 38.6 s against 18.8 s), with identical output. The bounding-box crop barely helps when the
  frame's box covers most of the scan. Try `ndi.affine_transform(..., order=0)` and check half-voxel rounding still matches.
- **A generic `orient_bone` (left from p231 B2).** The frame module landed (`microct-core/resources/frame.py`); `tibia_frame.py` now only fits
  the axes and crop and calls it. It stayed in `mouse-oa` because its +U medial / +V anterior sign rule, crop defaults and
  `envelope.close_and_fill` are the mouse tibia protocol's: moving it to `orient-joint` needs `envelope` in a generic skill and the sign
  rule behind an argument.
- **Fold the other slice renderers into `quad_view` (left from the quad-view PR).** Boxes as a layer would let `render_slices` (`--boxes`, `--points`; `orient_joint.py` imports its `render()`) and `render_crops` go, with `sam-segmentation` taking its keyframe from a quad pane. The 6-view sheet stays (4 of 4 catches). Also open: `quad_view` draws a point's name in 3D even where the surface hides it; a new mask's surface costs ~9 s cold (marching cubes and smoothing on the aligned grid), later calls reuse the cache.
- **One `--anatomy` profile (p231 M1).** `references/anatomy.json` holds label names, `window_hu` and `segmentation_threshold_hu`, but the
  generic scripts take them as flags: `--names 1=femur,...` (`quad_view`, `render_surfaces`), `--window` in five scripts, the required
  `--threshold-hu` in five. Speck size is 0.01 mm³ in `unlabelled` and `label_stats` and 0.005 in `disagree`; `orient_joint`'s lengths are now required flags (the anatomy reference gives them). The mouse QC figures bypass `viewlib` and hard-code windows (`vmin=0, vmax=5000` in `iioc`, `metaphysis_roi`,
  `tibial_trabecular`; -500..6000 in `tibia_frame`). Direction: one `--anatomy` argument read through a `sidecar` helper supplies these
  defaults (flags only override), so a rat knee needs one new `anatomy.json`; `label_stats --ranges` already reads this file; route the mouse
  QC figures through `viewlib`.
- **`femoral_frame.py` becomes a `measure.py` spec (p231 M2).** DFL, DFW and W/L are two distances and a ratio, which `measure.py` already
  computes (`deck_volumes_spec.json` is the pattern); `off_bone_mm` repeats `pick.py`'s snap distance; the frame vectors (`ml_vector_zyx` and
  the rest) have no reader. Direction: let `measure.py` distances name points from `--points points.json`, add a `femoral_spec.json`, and
  delete the script or cut it to the a/b swap check. Until then it writes its record with `sidecar.emit_values`.
- **One import bootstrap (p231 L1, p230 L4).** The `sys.path` bootstrap is copied into about 30 scripts in two variants (`HERE.parents[1]` for
  generic scripts, a walk up the ancestors for the mouse ones). `python -I` justifies having it; the walk-up variant works from both places, so
  use that one, or install `microct-core` as a package in the sandbox image and delete it. Tied to how a run lays out its snapshot
  (`mouse-oa` and `core` side by side), which the workflow-packages lane settles.
- **A kept synthetic-truth test (p230), for the user to decide.** A tilted planar growth-plate face under a flat top, where `iioc.py`'s height
  along W equals h / cos θ and the perpendicular height equals h. The heights moving by 3 to 7% between the two definitions was silent until a
  reviewer recomputed it; the same shape of test would pin plate thickness and node density. None is added.

## From the round-3 review (p246, 2026-10-28)
- `morphometry.py` volume definitions should name the grid the count was made on
  (scan vs aligned); today only the record's `grid_id` says it, and stdout omits it.
- `volumes`/`trabecular` without `--id` write bare keys (`TV`, `BV/TV`); two calls
  collide and nothing binds to `outputs.json`. Consider requiring `--id` for every key.
- `sidecar.py:78-80`: read the calibration after the `if not header: fail`, drop the ternary.
- `annotations.json` mixes point orders: curves are `[w, u]`, `width_points_uvw` and
  `plate_patches` are `[u, v, w]`. Documented, but a hand-writing agent holds two orders.

## Lengths still in voxels or um (left by the skills cleanup)
- Internal, not flags: `classic_segment.py` `MARGIN`, `SLAB`, `GRADIENT_RADIUS` (compute halos), `envelope.py` `CLOSE_ITERATIONS = 8`
  (84 um at 10.5 um voxels: a length in voxels; `close_and_fill` needs the voxel size to take mm), `snap_boxes.py` `min_px=50`.
- `morphometry.py cortical` and the protocol's commands take `--depth-um`, `--slab-um`, `--context-um`; mm would match the rule
  "every length is in mm" but changes every cortical command in `oa-protocol.md`.
