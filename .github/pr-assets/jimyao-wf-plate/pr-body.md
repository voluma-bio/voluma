## Changelog

- Added: the mouse-OA iioc and metaphyseal tasks start from a proposal of the growth plate's two faces found in 3D (`plate_faces.py`), with the stretches it cannot vouch for flagged. `iioc.py` and `metaphysis_roi.py` refuse a flagged stretch the worker leaves sparse and accept one marked eroded, and report the eroded stretches.

## Why

Today the worker traces the growth plate's proximal face (annotation A, for `iioc.py`) and its distal face (annotation C, for `metaphysis_roi.py`) by eye: a few points on coronal sections every 20, joined by straight lines. Against Jimmy's hand traces that midline is 97 to 137 µm (median) off the plate. A 3D density search ([probe report](https://github.com/voluma-bio/docs), `probe-plate-3d/REPORT.md`) is 15 to 66 µm off wherever it is not flagged, and fails in two ways: it invents a plate where the plate is eroded, and it jumps into dark epiphyseal marrow. So the script proposes and the worker judges. Jimmy approved building it before the Nov 4 freeze. Two reviews of the first version asked for flags that test what the script delivers, a refusal instead of an instruction for the flagged gaps, and an answer for the eroded plate; this version does those.

## Design decisions

1. **A proposal, never a trace, and a gap is refused.** A column is flagged when the two searches (along U and V) disagree, the centre is steeper than a plate, its density is not a dip, or a face lies more than 126 µm (12 voxels) from the centre. A flagged stretch gets no curve points and is written into the annotations as `plate_stretches` (`annotations.py`). `iioc.py` and `metaphysis_roi.py` stop on a stretch whose curve has points more than `max_gap_um` (250 µm, Jimmy's hand traces never leave more than 210 µm) apart inside it, or whose section has no curve, and name the section and U range. The worker clears it by tracing it densely or by adding `"eroded": "<why>"` to the stretch. Ruled out: bridging flagged stretches with a line, which `surface_from_curves` does silently (the proposal had straight bridges up to 2.2 mm).
2. **Eroded is an answer, not a failure.** Inside a stretch marked eroded on the sections either side, `metaphysis_roi.py` accepts a distal face at or above the proximal one (the worker traces the remaining bone with both faces). ROI-3 is cut as everywhere, `start_um` below the traced distal face, so under an eroded stretch it starts below the remaining bone; this is in the script's help and the example. Both scripts put `eroded_stretches` (section, U range, reason, share of that section's width) and `plate-eroded-fraction` (share of the footprint over the traced V range) in their result record.
3. **Retracing is required, a To check item is in addition.** The examples' completion line and the script's help said "or a To check item"; both now say the retrace is required. The protocol's "look at" and the script's default are every proposed section (26 to 30 sections, 5 sheets).
4. **The padding is closing only.** The flags are closed by 2 voxels and specks under 6600 µm² dropped; the dilation of the first version is gone. Flagged area drops from 47 / 58 / 28% to 35 / 49 / 20% (OA7-1L / OA6-1RK / OA6-2RK) and the share of unflagged faces over 105 µm off stays inside the noise of 7 traced sections ([scores](.github/pr-assets/jimyao-wf-plate/scores.md)).
5. **The face reach is 126 µm, and the dip is computed once, on the centre.** The face walk reached 262 µm into marrow and made the spikes the review found; a face that needs more than 126 µm is itself a flag. The dip test is `dip < flag_min_dip_hu` (-1000: the centre is 1000 HU brighter than the shallower shoulder); a positive threshold flagged 45 to 70% of the columns, so it stays at the value that fires on almost nothing but OA6-1RK's eroded side.
6. **The spec is in µm.** `dp_max_slope` (dimensionless), `dp_step_penalty_per_um` (cost in HU/µm² per µm of height change), `flag_min_area_um2`, `section_step_um`, `max_gap_um`. The code converts with the voxel size.
7. **No `--frame` argument** (the grid id, shape and voxel size are in `tibia-hu.json`; the example run's `tibia-frame.json` is an older format `frame.load` refuses), and **the method is rebuilt, not copied, from the probe**: its recipe reproduces only with a per-step DP penalty and a 5-voxel median over the centre.
8. **The instructions drop OA6-1RK's "100 to 200 µm" thickness and "thin perforated band"** as general statements: its plate is eroded (bone destruction, possibly age-related) and the lab says it is not representative; OA6-2RK is typical.

## Walkthrough

### Run the script and look

1. Setup: this branch; `export PYTHONPATH=$(ls -d $PWD/workflows/*/skills/*/resources | paste -sd:)`; the aligned grid of a scan (`tibia-hu.npy`, `tibia-mask.npy`, with their sidecars) from `tibia_frame.py`, e.g. `/tmp/p1208/oa62/tibia/`.
2. `python workflows/mouse-oa/skills/mouse-oa/resources/plate_faces.py --spec workflows/mouse-oa/skills/mouse-oa/resources/protocol.json --window workflows/mouse-oa/skills/mouse-oa/references/anatomy.json --hu-aligned /tmp/p1208/oa62/tibia/tibia-hu.npy --mask /tmp/p1208/oa62/tibia/tibia-mask.npy --out plate/`
3. Expect: 6 to 9 s, one JSON line; `plate/qc-plate-1.jpg` to `-5.jpg` show every proposed section: orange (proximal) and cyan (distal) faces on the plate on most, the white centre, red ticks under flagged columns, where the faces have no line. Flagged: OA7-1L 35%, OA6-1RK 49%, OA6-2RK 20%. `plate/plate-annotations.json` has `growth_plate_curves`, `growth_plate_distal_curves` and `plate_stretches` on every tenth section. `--sections 81,136,224` renders the sections you name; one with no tibia band exits 2 before anything is written.

### The refusal and the two ways to clear it

1. Copy the three keys into an `annotations.json` with the width points and compartment midpoints and run `iioc.py` on OA6-2RK: it exits 2 with `"growth_plate_curves" leaves 18 flagged stretch(es) of plate_stretches uncleared: V=11, U=144..166: the section has no curve; V=31, U=136..174: points up to 462 um apart; …`.
2. Trace each stretch (here a stand-in: the search centre ± 5 voxels every 4 columns, since there is no worker) and run `iioc.py` then `metaphysis_roi.py` again: both run on OA7-1L and OA6-2RK; renders in `.github/pr-assets/jimyao-wf-plate/` (`*-roi1-qc-coronal.jpg`, `*-roi3-qc.jpg`).
3. Eroded, OA6-1RK V=229 and V=239, U 296 to 338 (Jimmy's V=231 reading), faces meeting on the remaining bone: `metaphysis_roi.py` without the mark stops (`the traced distal face lies at or above the proximal face at 473 traced (V, U) positions, V=229..239, U=296..338 …`); with `"eroded"` on both stretches it runs and `roi3.json` lists `eroded_stretches` (width 15% of V=229, 18% of V=239) and `plate-eroded-fraction` 0.0057 of the footprint over the traced V range. `oa6-1rk-eroded-roi3-qc.jpg`. `iioc.py` reports the same two fields; shown on OA6-2RK with one stretch marked.

Read order: `plate_faces.py` (search, flags, curves, QC), `annotations.py` (`plate_stretches`, `cleared_stretches`), `protocol.json` (`plate-faces`), `oa-protocol.md` (steps 2 and 6, annotations A and C), `examples/README.md` (iioc, metaphyseal-roi, eroded plate).

## What changed

- **`plate_faces.py`.** The face walk is 126 µm and flagged when it saturates; the dip is computed once, on the centre; closing only; writes `plate_stretches` into the annotations; renders every proposed section; refuses a `--sections` outside the tibia before writing; the docstring says what a flag is and how a stretch is cleared.
- **`annotations.py`.** New key `plate_stretches` (validated in `check_bounds`) and `cleared_stretches`, which both scripts call.
- **`iioc.py`, `metaphysis_roi.py`.** Refuse an uncleared stretch; `metaphysis_roi.py` skips the faces-must-not-meet check inside eroded stretches; both report `eroded_stretches` and `plate-eroded-fraction`; help text updated.
- **`protocol.json`.** Entry `plate-faces` in µm (see 6) and `max_gap_um`.
- **Instructions.** `oa-protocol.md` steps 2 and 6 and annotations A and C; `examples/README.md` iioc, metaphyseal-roi and the eroded-plate example.

## Risk and where to look

- Breaks or changes: nothing runs differently until a run reads the new text, except that `iioc.py` and `metaphysis_roi.py` now refuse a `plate_stretches` key that the curves leave sparse; an `annotations.json` without the key is unaffected. `tasks.json`, `outputs.json` and the role files are untouched (another build replaces them), so no task lists `plate_faces.py` yet; the new `plate-eroded-fraction` diagnostic is not in `outputs.json`.
- Where to look: `cleared_stretches` (the gap rule and the eroded mask: eroded only where both sections either side mark it), and `flag_columns`.

## Knowledge layers, docs and deletions

- **Docs:** `oa-protocol.md` and `examples/README.md` as above; `workflows/mouse-oa/.context/TODO.md` (re-tuning, the residual wrong-sheet columns, judging on the production model, OA6-1RK's old frame); `.context/decisions.md` one line.
- **Deleted:** the "100 to 200 µm" thickness line and "thin perforated band" in annotation C; the dilation, the second per-pass dip and the voxel-unit spec keys.

## Contract changes

None.

## Verification

- Ran: `plate_faces.py` on OA7-1L, OA6-1RK and OA6-2RK (35 / 49 / 20% flagged); `iioc.py` and `metaphysis_roi.py` on OA7-1L and OA6-2RK with the raw proposal (refused), with a stand-in fill (accepted) and with one stretch marked eroded; `metaphysis_roi.py` on OA6-1RK with and without the eroded mark; the `--sections 0` crash (exits 2, nothing written); the scores against the 7 hand traces ([scores](.github/pr-assets/jimyao-wf-plate/scores.md)); `pytest core/tests/test_help.py -k plate`; ruff; `pnpm check`. No model or SAM calls.
- Saw: on unflagged columns the centre is 15 to 23 µm median on OA6-2RK V=154 and V=225 and OA7-1L V=81, 41 to 66 on the harder OA7-1L and OA6-1RK sections. On OA6-1RK V=231, 98% of the columns right of U=296 are flagged. The flags do not see a convincing sheet on the wrong structure: 14 to 38% of the unflagged face columns on OA7-1L V=136 and V=224 and OA6-1RK V=102 are over 105 µm off his lines.
- Not run: `iioc.py` on OA6-1RK (its stored `tibia-frame.json` is an old format `frame.load` refuses), so its proximal face for the eroded check was built from the proposal's own curves. The fills are stand-ins, not a worker's trace.

## Left out

- [ ] Judging the new instructions on a run with the production model: not tested here (no model calls).
- [ ] Re-tuning the flags when more hand traces exist: `workflows/mouse-oa/.context/TODO.md`.
