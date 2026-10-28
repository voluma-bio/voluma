# Micro-CT skillset TODO

From the structural review of PR #62 (`review-pr62` p231, structure) and the correctness re-check (p230). The round-2 fixes there
(one curve schema and interpolator, one BV owner, one result record) landed; these did not.

- **One frame module and schema (p231 B2).** `orient_joint.py` writes `R_zyx`, `origin_zyx`, `shape_srs` and has `reslice`, `to_scan`,
  `to_oriented_points`, `to_scan_points`; `workflow-mouse-oa/resources/tibia_frame.py` writes an xyz column basis resampled with
  `affine_transform`, and `iioc.py` has its own `to_scan` and an inline point mapping (`width_points_zyx`): three mappings of "a rigid
  resample of the scan grid with a derived grid id". `tibia_frame.json` also has dead keys (`basis_columns_xyz` duplicates
  `output_xyz_to_original_xyz_matrix`; `origin_xyz` and `local_lower_uvw` are written and never read; `_centers` is returned and dropped), and
  the prose `axes` string is hashed into `grid_id`, so rewording it changes the id. Direction: one `frame.json` schema
  (`parent_grid_id`, `R_zyx`, `origin_zyx`, `shape`) and its resample and map-back functions in `microct-core`; `orient_joint` and a generic
  `orient_bone` (today's `tibia_frame` fit, moved into `orient-joint`: its docstring already says "for one long bone") only compute `R`,
  origin and shape; delete `iioc.to_scan` and the inline mapping.
- **One `--anatomy` profile (p231 M1).** `references/anatomy.json` holds label names, `window_hu` and `segmentation_threshold_hu`, but the
  generic scripts take them as flags: `--names 1=femur,...` (`render_overlay`, `render_surfaces`), `--window` in five scripts, the required
  `--threshold-hu` in five. Speck size is 0.01 mm³ in `unlabelled` and `label_stats` and 0.005 in `disagree`; `orient_joint`'s default
  lengths are a mouse's. The mouse QC figures bypass `viewlib` and hard-code windows (`vmin=0, vmax=5000` in `iioc`, `metaphysis_roi`,
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
  (`workflow-mouse-oa` and `microct-analysis` side by side), which the workflow-packages lane settles.
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
