## Changelog

- Added: the mouse-OA iioc and metaphyseal tasks start from a proposal of the growth plate's two faces found in 3D (`plate_faces.py`), with the stretches it cannot vouch for flagged, instead of 4 to 7 hand points per section.

## Why

Today the worker traces the growth plate's proximal face (annotation A, for `iioc.py`) and its distal face (annotation C, for `metaphysis_roi.py`) by eye: a few points on coronal sections every 20, joined by straight lines. Against Jimmy's hand traces that midline is 97 to 137 µm (median) off the plate. A 3D density search ([probe report](https://github.com/voluma-bio/docs), `probe-plate-3d/REPORT.md`) is 17 to 53 µm off wherever the plate exists, and fails in two ways: it invents a plate where the plate is eroded, and it jumps into dark epiphyseal marrow. So the script proposes and the worker judges. Jimmy approved building it before the Nov 4 freeze.

## Design decisions

1. **A proposal, never a trace.** A search that is right on most columns and wrong in two known ways cannot feed `iioc.py` directly. The script flags a column when the two searches (along U and along V) disagree, the centre is steeper than a plate (2.5 voxels per voxel), or neither search has a density dip; a flagged stretch gets no curve points, and the instructions tell the worker to retrace it densely or raise a To check item. Ruled out: bridging flagged stretches with a line, which is what the hand traces do today.
2. **Flags are tuned on 7 hand-traced sections, and the dip flag on one.** Thresholds sit in `protocol.json` (`plate-faces`). The disagreement and slope flags were swept on all 1640 traced columns (22% of columns within 60 µm of his midline flagged, 73% of those over 150 µm caught); the dip flag was tuned on OA6-1RK V=231 to the right of U=296 and fires on almost nothing elsewhere. Ruled out: a plate-thickness prior from the traces (Jimmy: the gap between his two lines is his habit).
3. **No `--frame` argument.** The script needs only the grid id, shape and voxel size, which `tibia-hu.json` has. The example run's `tibia-frame.json` is an older format `frame.load` refuses, so asking for it would make the script unrunnable on OA6-1RK.
4. **The method was rebuilt, not copied, and is not identical to the probe.** The probe's code was deleted. Its recipe reproduces only after adding a per-step penalty to the DP (40 per voxel of height change) and a 5-voxel median over the centre; with those OA7 V=81 is 17 µm (probe 21) and OA6-2RK V=225 17 (probe 17), but OA7 V=224 is 119 over all columns (probe 51). The unflagged columns of V=224 are 68.
5. **The instructions drop OA6-1RK's "100 to 200 µm" thickness and "thin perforated band"** as general statements: its plate is eroded (bone destruction, possibly age-related) and the lab says it is not representative; OA6-2RK is typical. An eroded-plate example is added.

## Walkthrough

### Run the script and look

1. Setup: this branch; `export PYTHONPATH=$(ls -d $PWD/workflows/*/skills/*/resources | paste -sd:)`; the aligned grid of a scan (`tibia-hu.npy`, `tibia-mask.npy`, with their sidecars) from `tibia_frame.py`, e.g. `/tmp/p1208/oa62/tibia/`.
2. `python workflows/mouse-oa/skills/mouse-oa/resources/plate_faces.py --spec workflows/mouse-oa/skills/mouse-oa/resources/protocol.json --window workflows/mouse-oa/skills/mouse-oa/references/anatomy.json --hu-aligned /tmp/p1208/oa62/tibia/tibia-hu.npy --mask /tmp/p1208/oa62/tibia/tibia-mask.npy --out plate/`
3. Expect: 6 s, one JSON line; `plate/qc-plate-1.jpg` and `-2.jpg` show orange (proximal) and cyan (distal) faces on the plate on most sections, the white centre, and red ticks under flagged columns, where the faces have no line. OA6-2RK: 25% flagged. `plate/plate-annotations.json` has `growth_plate_curves` and `growth_plate_distal_curves` in the schema `iioc.py` reads, on every tenth section.
4. `--sections 81,136,224` renders the sections you name.

### Feed the curves to the later scripts

1. Copy both curve keys into an `annotations.json` with the width points and compartment midpoints, run `iioc.py` then `metaphysis_roi.py`.
2. Expect: no refusals on OA7-1L and OA6-2RK (ROI-1 and ROI-3 renders in `.github/pr-assets/jimyao-wf-plate/`). These renders use the raw proposal with its flagged gaps still bridged straight (OA7 V=73 shows a diagonal across one), which is the state the worker must never leave.

Read order: `plate_faces.py` (search, flags, curves, QC), `protocol.json` (`plate-faces`), `oa-protocol.md` (steps 2 and 6, annotations A and C), `examples/README.md` (iioc, metaphyseal-roi, eroded plate).

## What changed

- **`plate_faces.py`.** One script: Hessian valley along W after a Gaussian (31, 84, 84 µm), a dynamic-programming path along U and along V, faces at the valley's half depth, flags, annotation-schema curves, QC sheets.
- **`protocol.json`.** Entry `plate-faces`: every number the script fixes, in µm.
- **Instructions.** `oa-protocol.md` steps 2 and 6 and annotations A and C; `examples/README.md` iioc and metaphyseal-roi, plus the eroded-plate example and its image from Jimmy's trace of OA6-1RK V=231.

## Risk and where to look

- Breaks or changes: nothing runs differently until a run reads the new text; `tasks.json`, `outputs.json` and the role files are untouched (another build replaces them), so no task lists `plate_faces.py` yet. The agent finds it through the tool index.
- Where to look: `flag_columns` (the thresholds and the padding, the part with the least data behind it) and `curves` (a flagged stretch inside a section leaves a gap that `surface_from_curves` bridges if the worker does not fill it; nothing refuses that yet).

## Knowledge layers, docs and deletions

- **Docs:** `oa-protocol.md` and `examples/README.md` as above; `workflows/mouse-oa/.context/TODO.md` (a check that flagged stretches are covered; re-tuning; judge on the production model); `.context/decisions.md` one line.
- **Deleted:** the "100 to 200 µm" thickness line and "thin perforated band" in annotation C.

## Contract changes

None.

## Verification

- Ran: `plate_faces.py` on OA7-1L, OA6-1RK and OA6-2RK; scored its centre and curves against the 7 hand traces ([scores](.github/pr-assets/jimyao-wf-plate/scores.md)); `iioc.py` and `metaphysis_roi.py` on OA7-1L and OA6-2RK with the proposed curves; `pytest core/tests/test_help.py -k plate`; ruff; `pnpm check`. No model or SAM calls.
- Saw: on unflagged columns the centre is 15 / 16 / 25 µm median on OA7 V=81, OA6-2RK V=225 and V=154, 43 to 68 on the harder OA7 and OA6-1RK sections; flagged columns are worse (44 to 164 µm) so the flag separates them. OA6-1RK V=231, the eroded section, is 93% flagged to the right of U=296 and almost entirely flagged overall; its 12 unflagged columns are 198 µm off. OA6-2RK, the typical plate, is 25% flagged. Both later scripts ran without refusals.

## Left out

- [ ] A check that a worker's `annotations.json` covers every flagged stretch: `workflows/mouse-oa/.context/TODO.md`.
- [ ] Judging the new instructions on a run with the production model: not tested here (no model calls).
