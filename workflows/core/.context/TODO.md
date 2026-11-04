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
  takes `--window scan-settings.json`, intake's per-scan choice (`viewlib.window_arg` reads the file's `window_hu`, as every renderer's `--window` now does,
  and `sidecar.threshold_arg` its `segmentation_threshold_hu` for `--threshold-hu` and `--bone-hu`). Still flags:
  `--names 1=femur,...` (`quad_view`, `render_surfaces`), and the speck size, 0.01 mm³ in `unlabelled`
  and `label_stats` and 0.005 in `disagree`; `orient_joint`'s lengths are required flags (the anatomy reference gives them). Direction: one
  `--anatomy` argument read through a `sidecar` helper supplies these defaults (flags only override), so a rat knee needs one new
  `anatomy.json`; `label_stats --ranges` already reads this file.
- **`femoral_frame.py` after the spec move (p231 M2), what is left.** DFL, DFW and W/L are computed by `measure.py` from `protocol.json`; the
  script keeps the landmark checks and the frame. `off_bone_mm` repeats `pick.py`'s snap distance. The frame's ML is now the femur label's
  condylar axis, read by the ruler-direction checks, and SI is read by the SI check; nothing outside the script reads either
  vector from `femoral.json` (the unread normal was dropped in #488).
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
- **Review-asset publish lock** (`convert/review_assets.py` `publish()`): every file takes the global mkdir lock before its copy. Try the copy first, and only on FileNotFoundError take the lock, mkdir and retry. A directory that holds a file persists on the R2 mount, so the common case never waits. Unmeasured on a large scan's level 0 (#436 review).
- **A real "convert again"** for a review asset that failed (`assets.failed` is permanent today, so the viewer offers no retry).

## Which way up a render shows
- `quad_view.py` fixes its 3D camera's view-up to scan +z (`'view_up': [0.0, 0.0, 1.0]`); `--rotate` changes azimuth and
  elevation only. A step that wants its 3D views a particular way up (the femur with its shaft up, as in the mouse-OA
  deck) cannot ask for it. Direction: a view-up argument, kept in `.view.json` so `pick.py` still maps picks. Likewise
  `orient_joint.py` puts bone A above bone B with no override (#429 review).

## A researcher's path drawn on a scan plane

`marks_to_grid.py --curve` refuses a path whose points lie more than 2 voxels apart along the target grid's section
axis: a path drawn on one of the scan's planes cuts across the tibia grid's sections. If researchers draw growth-plate
paths that way, resample the path onto the tibia-grid sections it crosses (one curve per section, from where the path
meets each section) instead of refusing it.

## Touching ossicles on the tibial plateau

Pieces of bone that touch the tibia and carry its label occur on most lab scans: 14 kept by eye on 8 of 10 (none on
OA6-2RK or OA7-1L), about 0.065-0.076 mm³ each and 1-3% of a label's region volume; several at the plateau's rims sit half
in the tibia mask (the femur/tibia regrow splits a block touching both along a straight line). List and check images:
`~/experiments/plate-data/tracing/pieces/RESULTS-L24.md`. Add a check-first line to `segmentation-check`: look for a piece
joined to the plateau along a dark seam, and split it with `classic_segment.py --within` before the tibial regions are built.

## Real world mm in the review

The review places every image at its voxel 0, unrotated: `Volume.affine` is spacing only (`report-output.ts`
`detailFromSidecar`; `.npy` sidecars carry no `affine_xyz_to_world_mm`). So a researcher's mark arrives in mm on the image it
was drawn on, and `marks_to_grid.py --drawn-on` turns them into voxels. When a second reader needs the scan's world mm
(lab coordinates, Amira), publish each base with its true affine (`hu.json` / `frame.json`) and drop `--drawn-on`'s spacing
step in the same change.

## HU calibration for a scan without it

A series with valid HU (rescale tags, or Scanco's calibration) is used as it is. One without, `intake.py` refuses ("No valid
positive-slope HU mapping"), and the kit has nothing for that case. Jimmy (4 Nov): HU calibration should still be part of the
kit. Add a `scan-intake` script for it. It maps the raw values to HU from what the researcher's files give: the units and
scaling, or a phantom's known values. Failing that, it uses two references found in the scan: air outside the specimen and
soft tissue as water. It writes `hu.json` with the calibration marked estimated and its evidence. A To check item says the
HU are estimated. The measurement scripts then need `--threshold`, unless the units give the lab's 2.16/cm directly (a scan in
linear attenuation). Keep the rule that a scan with HU is never re-mapped from its histogram.
