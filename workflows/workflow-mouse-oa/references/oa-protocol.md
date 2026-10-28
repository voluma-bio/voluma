# OA subchondral protocol (lab deck, after Tang et al.)

The lab's parameter deck (28 knee parameters, revised 2026-10-27) is the measurement spec; Tang et al. is the
method behind it. Where the deck and the old OA6-1RK run disagree, the deck wins (below). Code computes geometry
and volumes from regions you trace; you look at every region before you trust a number. All annotations are
proposals until you have seen them drawn on the scan. This reference owns the mapping from the 28 parameters to scripts;
`bone-morphometry` defines the measurements and builds no region.

Inputs: `hu.npy` and `hu.json` (scan-intake), `labels.npy` on the same grid (femur 1, tibia 2; see `anatomy.md`).
Use isotropic voxels. Scripts are in `resources/` of this workflow and write next to `--out`. Every number comes out as a result
record (`microct-core`): `{output id: {value, unit, definition, kind}}`, with the output ids of the 28-row table below.
`kind` is `measurement` for a deck parameter and `diagnostic` for a number that helps you judge one.

**One owner per concept.** Region scripts (`iioc.py`, `tibial_trabecular.py`, `metaphysis_roi.py`) write regions and, for `iioc.py`, the
geometry that needs the protocol's own steps (heights, width, plate columns). All TV, BV and BV/TV, and the thickness and node
measures, come from `morphometry.py` (`bone-morphometry`). Every curve you trace uses the one schema of `region_from_curves.py`.

**Bone threshold.** BV is always the region and HU above the lab's 2.16/cm, converted to this scan's HU from the calibration in
`hu.json` (2459.875 HU on OA6-1RK). `morphometry.py` takes `--hu-json` for it (kept apart from `--grid`, the grid the region is on);
`--threshold` overrides. No label gates BV. BV/TV is in %.

**Grid rule.** A volume is counted where the region is defined: a region traced on the aligned stack is counted on the aligned
stack, on `tibia-hu.npy`, a linear resampling of the scan. `iioc.py` also writes `iioc-tissue-scan.npy` (nearest-neighbour onto the
scan grid): counting ROI-1 there on unresampled `hu.npy` gives BV/TV 67.43% against 67.69% on the aligned grid. That 0.26-point gap
is the resampling effect, known and left in; state which grid a number was counted on.

## Steps, in order

| # | Do | Script | Look at |
|---|---|---|---|
| 1 | Align the tibia (in the `iioc` task; later tasks read `/outputs/iioc/frame/`): shaft axis, +W from joint toward shaft, crop around the joint end | `tibia_frame.py --hu hu.npy --hu-json hu.json --labels labels.npy --label 2 --out frame` | `frame/tibia-frame-qc.jpg`: coronal sections, joint at top, tibia outline following the bone. If the crop cuts bone or the bone looks tilted, set `--shaft-z`, `--epiphysis-z` or the crop flags |
| 2 | Trace the growth-plate proximal face on coronal sections (annotations, section A) | none: you write `annotations.json` | coronal sections of `tibia-hu.npy` with a pixel grid, every 20 V indices over the epiphysis |
| 3 | ROI-1 (IIOC), heights, width, plate columns | `iioc.py --hu-aligned /outputs/iioc/frame/tibia-hu.npy --mask /outputs/iioc/frame/tibia-mask.npy --frame /outputs/iioc/frame/tibia-frame.json --hu-json hu.json --annotations annotations.json --out iioc` | `iioc/qc-coronal.jpg` (four sections framed from ROI-1's top to just below the face, at the scale its title states; green ROI-1 must stop at the orange face, include marrow, exclude femur and growth-plate band) and `qc-heights.jpg` (rulers along W, endpoints at the face and the articular top) |
| 4 | Trace the boundary under the subchondral plate (section B) | none | coronal sections with the ROI-1 outline |
| 5 | ROI-2 (IIOC trabecular) | `tibial_trabecular.py --iioc-tissue /outputs/iioc/iioc/iioc-tissue.npy --growth-plate-face /outputs/iioc/iioc/growth-plate-proximal-face.npy --hu-aligned /outputs/iioc/frame/tibia-hu.npy --annotations annotations.json --out trab` | `trab/qc-coronal.jpg`: cyan sits under the plate and inside the cortex |
| 6 | Trace the growth-plate distal face (section C), then ROI-3 and the cortex under the plate | `metaphysis_roi.py --hu-aligned /outputs/iioc/frame/tibia-hu.npy --mask /outputs/iioc/frame/tibia-mask.npy --hu-json hu.json --annotations annotations.json --proximal-face /outputs/iioc/iioc/growth-plate-proximal-face.npy --proximal-valid /outputs/iioc/iioc/growth-plate-proximal-valid.npy --out meta` | `meta/qc-roi3.jpg`: ROI-3 sits in marrow below the plate and clear of the cortex outline |
| 7 | TV, BV, BV/TV of ROI-1 and ROI-2 (deck #4-6, #13-15); TV, BV, BV/TV, Tb.N, Tb.Th, Tb.Sp, nodes and ends of ROI-3 (deck #16-23) | `morphometry.py` (commands below), one per region | the QC image `trabecular` writes |
| 8 | Ct.Th at 100 and 1000 um; plate thickness | `morphometry.py cortical` (commands below) | its QC image |
| 9 | Femoral landmarks: place four points on a 3D render of the femur (`regions-and-landmarks`, `pick.py` with picks named `a`, `b`, `c`, `d`), then compute | `femoral_frame.py --landmarks points.json --hu-json hu.json --labels labels.npy --out femoral` | `pick-check.jpg` of each point, and `femoral.json` (the script fails on a bad landmark, see D). There is no image with the four points and the two lines drawn |
| 10 | Volumes of labels 3, 5 and 6 (deck #1 to #3) | `measure.py --spec <this workflow>/resources/deck_volumes_spec.json --grid hu.json --out volumes.json` (the spec names `labels.npy` relative to where you run it) | the 3D sheet (`visual-check`) |
| 11 | Hand the points to the lab (below) | `amira_landmarks.py` | the lab opens it in Amira |

Commands for step 7 (`--id KEY=output-id` names each value; `--region` only labels the definitions):

```
M=<bone-morphometry>/resources/morphometry.py
python $M volumes --roi /outputs/iioc/iioc/iioc-tissue.npy --hu /outputs/iioc/frame/tibia-hu.npy --hu-json hu.json --region ROI-1 \
  --id TV=tv-tibial-iioc --id BV=bv-tibial-iioc --id BV/TV=bv-tv-tibial-iioc --out vol-roi1
python $M volumes --roi /outputs/trabecular-roi/trab/iioc-trab-tissue.npy --hu /outputs/iioc/frame/tibia-hu.npy --hu-json hu.json --region ROI-2 \
  --id TV=tv-iioc-trab --id BV=bv-iioc-trab --id BV/TV=bv-tv-iioc-trab --out vol-roi2
python $M trabecular --roi /outputs/metaphyseal-roi/meta/roi3-tissue.npy --hu /outputs/iioc/frame/tibia-hu.npy --hu-json hu.json --region ROI-3 --skeleton \
  --id TV=metaphyseal-tv --id BV=metaphyseal-bv --id BV/TV=metaphyseal-bv-tv --id Tb.N=metaphyseal-tb-n \
  --id Tb.Th=metaphyseal-tb-th --id Tb.Sp=metaphyseal-tb-sp --id Tb.Nd=metaphyseal-tb-nd --id Tb.Tm=metaphyseal-tb-tm --out vol-roi3
```

Commands for step 8 (axis 0 is W, depth grows with W). The `cortical` task depends on `metaphyseal-roi` and reads its files in `/outputs/metaphyseal-roi/meta/`: the
distal face is traced once, in step 6, and `metaphysis_roi.py` is not run again for the cortex:

```
morphometry.py cortical --cortex /outputs/metaphyseal-roi/meta/cortex.npy --surface /outputs/metaphyseal-roi/meta/growth-plate-distal-face.npy --axis 0 --direction 1 \
  --depth-um 100 --slab-um 50 --name cortical-thickness-100-um-below-the-growth-plate --grid /outputs/metaphyseal-roi/meta/cortex.json --out ct
      # then --depth-um 1000 --name cortical-thickness-1000-um-below-the-growth-plate
morphometry.py cortical --cortex /outputs/iioc/iioc/medial-plate-run.npy --surface /outputs/iioc/iioc/articular-top-surface.npy --axis 0 --direction 1 \
  --depth-um 175 --slab-um 350 --name subchondral-bone-plate-thickness-medial --grid /outputs/iioc/iioc/medial-plate-run.json --out plate
      # and lateral-plate-run.npy with --name subchondral-bone-plate-thickness-lateral
```

Rerun with the changed trace to test how much a boundary matters: `iioc.py --gp-shift-voxels 2` and
`tibial_trabecular.py --upper-shift-voxels 2` exist for that. A shift is a sensitivity check, not an error bar.

## Aligned grid and annotations

`tibia_frame.py` writes `tibia-hu.npy`, `tibia-mask.npy` and `tibia-frame.json` on an **aligned grid**: array axes
(W, V, U), the scan's voxel size, W from the joint toward the shaft. +U medial and +V anterior come from a sign rule on scan y
and `--joint-end` that assumes one knee and one scan orientation: **confirm it on the QC montage** before you name a side
(a left knee flips it). Its `grid_id` is derived from the scan's. **Every coordinate below is an index on that grid.** Check the
sidecar `grid_id` before you reuse an annotation file on another run: indices mean nothing on another frame. Femoral landmarks are
the exception: they are `[z, y, x]` indices on the scan grid.

**One curve schema.** Every traced surface is `{"axis": 1, "height": "row", "slices": {"<v>": [[w, u], ...]}}`: the coronal section
at V = `<v>` (array axis 1), and each point `[row, column]` = `[W, U]` read off that section's pixel grid. This is the schema
`region_from_curves.py` documents, and its `surface_from_curves` is the one interpolator the three scripts import: a surface is
linear in U along a curve (points in any order, constant past the ends) and linear in V between traced sections (constant past the
first and last). Trace across the whole width and expect edge guesses to be wrong. A point is `[w, u]`, not `[u, w]`.

`oa6-1rk-annotations.json` in this directory is the OA6-1RK annotation set (sections A and B) in that schema, with the `grid_id`
of its aligned frame: a worked example of the keys and the point order. It has no section C (no distal face was traced), and
it is a record of what was traced on that scan, not a starting point for another one.

One `annotations.json` can hold all three sections. Each script reads only its own keys. Every file needs the
`grid_id` of the aligned grid it was traced on (from `tibia-frame.json`); the scripts refuse a file without it or from
another grid.

**A, for `iioc.py`**

```json
{
  "grid_id": "<grid_id from tibia-frame.json>",
  "growth_plate_curves": {"axis": 1, "height": "row",
                          "slices": {"60": [[149, 60], [150, 170]], "80": [[145, 60], [159, 210]]}},
  "articular_corrections": [{"u_range": [120, 210], "v_range": [150, 181],
                             "curves": {"axis": 1, "height": "row",
                                        "slices": {"150": [[87, 120], [95, 210]], "180": [[81, 120], [91, 210]]}}}],
  "compartment_midpoint_u": {"lateral": 140, "medial": 290},
  "width_points_uvw": [[36, 173, 137], [378, 173, 177]],
  "growth_plate_mid_u": 207, "height_section_v": 218,
  "plate_patches": {"medial": {"u": [270, 310], "v": [175, 215]}, "lateral": {"u": [120, 160], "v": [175, 215]}}
}
```

- `growth_plate_curves` (required): the proximal face of the growth plate, on at least two V sections.
- `articular_corrections` (optional): where part of the tibia label is really femur or fibula above the articular
  surface, `curves` mark the true articular surface inside `u_range` x `v_range`; ROI-1 keeps only what lies below.
- `compartment_midpoint_u` (required): the U index at the middle of each plateau compartment. A height point outside the ROI-1
  footprint (or within 3 voxels of its edge) stops the script with a sentence: move the point.
- `width_points_uvw` (required): deck #10, as `[u, v, w]` points: the centre of the fibula-tibia junction on the tibial surface, and the
  most prominent point on the other side.
- `growth_plate_mid_u` (optional): where "the middle of the growth plate" is for height #7; default is the midpoint
  of the two width points.
- `height_section_v` (optional): the coronal section the heights are measured on; default is where the footprint's
  growth-plate-to-top distance is largest.
- `plate_patches` (optional): U and V ranges of the subchondral-plate patch per compartment; default is 500 um
  wide (deck figure) around the compartment midpoint and `height_section_v`.

**B, for `tibial_trabecular.py`**: `under_plate_curves` (the same schema): the boundary between the
subchondral plate and the trabecular compartment, with the end points on the inner side of the cortex, because the
first and last point of each curve limit ROI-2 laterally (where the curves reach, the `valid` mask of `surface_from_curves`).
`v_limits`: `[first V, last V]`.

**C, for `metaphysis_roi.py`**: `growth_plate_distal_curves` (required, the same schema), the distal face of the growth-plate band, traced like
the proximal one on the coronal sections of `tibia-hu.npy`. There is no thickness fallback: ROI-3 starts 50 um below this face, so
a guessed band thickness inside the 100 to 200 um range seen on OA6-1RK moves ROI-3 BV/TV from 23% to 15% and is not a
measurement. OA6-1RK has a thin perforated mineralized band, not a clean cartilage plate: trace the face you can see, and look
at it drawn on the sections before you run. Trace it over at least the V range of the proximal face (section A); the script
refuses a shorter trace, and a face at or above the proximal one inside that range, and says which V range to fix.

**D, `landmarks.json`** (scan grid, `[z, y, x]`): `a` midpoint of the upper line of the intercondylar groove, `b`
intercondylar notch, `c` midpoint of the ridge on the lateral condyle, `d` vertex of the medial condyle (deck figure,
slide 7). `femoral_frame.py` takes either this file or the `points.json` `pick.py` writes for picks named `a` to `d`, so
nothing needs converting by hand. Place `a` and `b` on a long view of the femur that shows the shaft and the groove side-on;
`c` and `d` can go on the joint-face view. The script fails (exit 2, nothing written) when a landmark is more than 0.05 mm from
femur bone, when DFL is under 0.4 of DFW (the sign of `a` and `b` placed end-on, as on the first full run: 0.824 mm against
2.42), or when SI points away from the femur: re-place the points; the failure is not a warning to explain.

## What the deck says, and what replaces the old run

- #10 tibial width: from the centre of the fibula-tibia junction on the tibial surface to the prominent point on the
  other side. The old run used a chord between growth-plate junction points at one section: do not reuse it.
- #26 DFL: a (midpoint of the upper line of the intercondylar groove) to b (the notch). #27 DFW: c (midpoint of the
  ridge on the lateral condyle) to d (vertex of the medial condyle). The old run used an outer-edge chord at one
  plane for the width: do not carry it over. #28 is DFW / DFL.
- #7 to #9 heights: from the middle of the growth plate (whole, medial compartment, lateral compartment) up to the top
  surface of the articular bone, "vertically". **Open for the lab:** it accepts perpendicular to the growth-plate plane or along
  the tibial shaft axis, and has not chosen. `iioc.py` reports both until it does. Along W, the shaft axis, are the three deck values
  (`iioc-height`, `iioc-height-medial-compartment`, `iioc-height-lateral-compartment`). Perpendicular is a `-normal` diagnostic beside each:
  the ray from the traced face at that point along the normal of the plane fitted to the face, to where it leaves ROI-1. The
  traced face is far from a plane (`growth-plate-plane-rms`, 0.113 mm on OA6-1RK, max 0.298 mm, tilt 10.7 degrees), so the two differ
  in size and in sign: on OA6-1RK #7 is 0.8738 along W and 0.8416 perpendicular, #8 0.4636 and 0.4988, #9 0.6332 and 0.6179. Report
  both with the plane residual, and say which the deck value is. Deck #7 uses the midpoint of the two width points as "the middle of
  the growth plate" (new definition, no old reference). The old run's "max local height" (0.9205 mm, `iioc-max-local-height`) is a
  diagnostic, and its height/width ratio (0.2546) used that value; with #7 it would be about 0.24.
- #22 and #23: Tb.Nd and Tb.Tm are counts per mm^3 of tissue volume (closed). They are counted in the part of ROI-3 away from
  its edge and divided by that volume, which the values carry.
- #2 and #3 (meniscus plus osteophytes): in meniscus-injury OA, new bone forms around the injured meniscus and the spurs cannot
  be separated from it, so the lab measures meniscus and spurs together as one volume per side. On OA6-1RK, **#3 medial is label 5
  and #2 lateral is label 6** (the lab's working reading; not anatomically checked). Both volumes come from `measure.py`
  (step 10). Still open: whether label 9's pieces and the tibial margin fragments (labels 10, 11) count toward a side.
- #1 to #3 count **label voxels**, and a label holds bone at the segmentation threshold (2500 HU on OA6-1RK), not at the measurement
  threshold (about 2460 HU) that gates BV in `microct-core`. The deck volumes are therefore a little smaller than a count at the
  measurement threshold (about 0.6% of the label on OA6-1RK). This does not change the rule that BV of a region is never gated by a label: these three are label volumes, not BV.
- ROI-1 is the IIOC from growth plate to articular surface. ROI-2 is what remains after removing the subchondral
  bone plate and the cortical line next to the growth plate. ROI-3 starts 50 um below the growth plate, runs 200 um,
  and stays 20 um beyond the cortex from the outer edge (the estimated cortex depth plus 20 um, measured in the ROI-3 slices).

## The 28 parameters

The only table of the parameters. **Output id** is the id the value is written under (and the id `outputs.json` binds to); a script
other than `morphometry.py` and `measure.py` writes the id itself, and for those two you pass it (`--id`, `--name`, the spec key).
Status is what the code does today. "Computed" means the script produces the number from the regions you traced; it does not mean the
number is validated. Nothing here has been checked against the lab's own software or a second scan. BV/TV is in %. Every thickness
record carries the voxel size; the sphere method reads **high** for structures an odd number of voxels wide (`bone-morphometry`),
and whether Scanco uses the same convention is open.

| # | Parameter | Output id | Region | Produced by | Status |
|---|---|---|---|---|---|
| 1 | Patella volume | `patella-volume` | label 3 | `measure.py` (step 10) | computed; whether label 12 counts is open |
| 2 | Lateral meniscus/osteophyte volume | `lateral-meniscus-osteophyte-volume` | label 6 | `measure.py` | computed; the mapping is the lab's working reading, whether labels 9 to 11 count is open |
| 3 | Medial meniscus/osteophyte volume | `medial-meniscus-osteophyte-volume` | label 5 | `measure.py` | computed; same |
| 4 | TV of IIOC | `tv-tibial-iioc` | ROI-1 | `morphometry.py volumes` | computed (aligned grid) |
| 5 | BV in IIOC | `bv-tibial-iioc` | ROI-1 | same | computed |
| 6 | BV/TV in IIOC | `bv-tv-tibial-iioc` (%) | ROI-1 | same | computed |
| 7 | Height of IIOC | `iioc-height` | ROI-1, middle of growth plate | `iioc.py` | computed along W; "vertical" is open, the perpendicular value is `iioc-height-normal` (new definition, no old reference) |
| 8 | Height, medial compartment | `iioc-height-medial-compartment` | ROI-1 | `iioc.py` | computed, same caveat (`-normal`) |
| 9 | Height, lateral compartment | `iioc-height-lateral-compartment` | ROI-1 | `iioc.py` | computed, same caveat (`-normal`) |
| 10 | Tibial width at the growth plate | `tibial-width-at-the-growth-plate` | growth plate | `iioc.py` | computed, only as good as your two points |
| 11 | Subchondral plate thickness, medial | `subchondral-bone-plate-thickness-medial` | plate patch | `morphometry.py cortical` on `medial-plate-run.npy` | computed, **unvalidated**: `iioc.py`'s diagnostic `subchondral-plate-medial-first-run` and the sphere value disagree by about 2x on OA6-1RK and the deck does not say which it means |
| 12 | Subchondral plate thickness, lateral | `subchondral-bone-plate-thickness-lateral` | plate patch | same, `lateral-plate-run.npy` | computed, **unvalidated**, same caveat |
| 13 | TV of IIOC-trab | `tv-iioc-trab` | ROI-2 | `morphometry.py volumes` | computed (aligned grid) |
| 14 | BV of IIOC-trab | `bv-iioc-trab` | ROI-2 | same | computed |
| 15 | BV/TV in IIOC-trab | `bv-tv-iioc-trab` (%) | ROI-2 | same | computed |
| 16 | TV, proximal tibial trabeculae | `metaphyseal-tv` | ROI-3 | `morphometry.py trabecular` | computed, needs a traced distal face |
| 17 | BV within ROI-3 | `metaphyseal-bv` | ROI-3 | same | computed |
| 18 | BV/TV | `metaphyseal-bv-tv` (%) | ROI-3 | same | computed |
| 19 | Tb.N | `metaphyseal-tb-n` | ROI-3 | same | computed; model-derived, inherits the thickness bias |
| 20 | Tb.Th | `metaphyseal-tb-th` | ROI-3 | same | computed, with the `voxel-size` diagnostic |
| 21 | Tb.Sp | `metaphyseal-tb-sp` | ROI-3 | same | computed, with the `voxel-size` diagnostic |
| 22 | Tb.Nd (nodes) | `metaphyseal-tb-nd` (1/mm³) | ROI-3 | same with `--skeleton` | computed per mm³ of the counted tissue volume, **unvalidated** |
| 23 | Tb.Tm (ends) | `metaphyseal-tb-tm` (1/mm³) | ROI-3 | same | same |
| 24 | Cortical thickness, 100 um under the plate | `cortical-thickness-100-um-below-the-growth-plate` | cortex | `metaphysis_roi.py` makes the cortex mask, `morphometry.py cortical` measures | computed; the cortex mask is a heuristic |
| 25 | Cortical thickness, 1000 um under the plate | `cortical-thickness-1000-um-below-the-growth-plate` | cortex | same | same |
| 26 | DFL | `distal-femoral-length-dfl` | femur | `femoral_frame.py` | computed |
| 27 | DFW | `distal-femoral-width-dfw` | femur | `femoral_frame.py` | computed |
| 28 | DFW/DFL | `width-length-ratio` | femur | `femoral_frame.py` | computed |

Diagnostics (`kind: diagnostic`) travel in the same records and are not outputs: the perpendicular heights `*-normal`,
`growth-plate-plane-rms`, `iioc-max-local-height`, `subchondral-plate-*-first-run`, `voxel-size`, and the node and end counts and counted
volume of `morphometry.py trabecular --skeleton`.

Also **not computed**: the deck's "developing new parameters" (centre lines of trabeculae along the long axis of ROI-3) and the
vertebral parameters (slides 9 and 10: another bone, out of this workflow's knee scope). ROI-2 TV excludes the cortex and growth-plate
clearance by 0.021 mm each (`--shell-clearance-mm`, `--growth-clearance-mm`), a choice of the old run, not of the deck.

## Hand-off: checking points in Amira

The lab checks the width points (#10) and the femoral landmarks (#26, #27) in Amira. Write them as a landmark set:

```
python <regions-and-landmarks>/resources/amira_landmarks.py --points /outputs/iioc/iioc/width-points-scan.json --header hu.json --out width.landmarkAscii
python <regions-and-landmarks>/resources/amira_landmarks.py --points landmarks.json --header hu.json --out femoral.landmarkAscii
```

Both are scan-grid points moved to physical millimetres with the DICOM affine. Report the files with the measurements they check.
`regions-and-landmarks` says what is and is not verified about the format.

## Limits to state in every report

- Every region follows traces you made on one scan; the old run labelled its values provisional and so do we.
- The aligned grid is a linear resampling of HU, and every region traced on it is counted on it (grid rule above). Counting ROI-1 on
  the scan grid instead moves BV/TV by 0.26 points on OA6-1RK.
- ROI-3 depends on the traced distal face, and its cortex edge uses an estimated cortex depth (reported as `cortex_estimate_mm`):
  a wrong depth moves ROI-3.
- Medial/lateral follows the aligned frame (+U medial). Confirm it on the render before you name a compartment.
- Tb.Nd and Tb.Tm are exploratory, and Tb.Th, Tb.Sp, Tb.N and Ct.Th carry the sphere-method bias with the voxel size.
