---
name: oa-subchondral-protocol
description: >
  Load when you measure the mouse-OA tibial and femoral parameters (the lab deck's 28 knee parameters): align the
  tibia, trace the growth plate, ROI-1 (IIOC), ROI-2 (IIOC trabecular), ROI-3 and cortex under the growth plate,
  heights, widths and the femoral landmarks. Says which parameters are computed, by which script, and which are not.
---

# OA subchondral protocol (lab deck, after Tang et al.)

The lab's parameter deck (28 knee parameters, revised 2026-10-27) is the measurement spec; Tang et al. is the
method behind it. Where the deck and the old OA6-1RK run disagree, the deck wins (below). Code computes geometry
and volumes from regions you trace; you look at every region before you trust a number. All annotations are
proposals until you have seen them drawn on the scan.

Inputs: `hu.npy` and `hu.json` (scan-intake), `labels.npy` on the same grid (femur 1, tibia 2; see
`mouse-knee-anatomy`). Use isotropic voxels. Resource scripts print one JSON line and write next to `--out`. The
masks that need thickness or nodes go to `morphometry.py` (`bone-morphometry`), which takes the masks and the
sidecar as `--grid`.

## Steps, in order

| # | Do | Script | Look at |
|---|---|---|---|
| 1 | Align the tibia: shaft axis, +W from joint toward shaft, crop around the joint end | `tibia_frame.py --hu hu.npy --hu-json hu.json --labels labels.npy --label 2 --out frame` | `frame/tibia-frame-qc.jpg`: coronal sections, joint at top, tibia outline following the bone. If the crop cuts bone or the bone looks tilted, set `--shaft-z`, `--epiphysis-z` or the crop flags |
| 2 | Trace the growth-plate proximal face on coronal sections (annotations, section A) | none: you write `annotations.json` | coronal sections of `tibia-hu.npy` with a pixel grid, every 20 V indices over the epiphysis |
| 3 | ROI-1 (IIOC), heights, width, plate columns | `iioc.py --hu-aligned frame/tibia-hu.npy --mask frame/tibia-mask.npy --frame frame/tibia-frame.json --hu hu.npy --hu-json hu.json --annotations annotations.json --out iioc` | `iioc/qc-coronal.jpg` (green ROI-1 must stop at the orange face, include marrow, exclude femur and growth-plate band) and `qc-heights.jpg` (rulers vertical, endpoints at the face and the articular top) |
| 4 | Trace the boundary under the subchondral plate (section B) | none | coronal sections with the ROI-1 outline |
| 5 | ROI-2 (IIOC trabecular) | `tibial_trabecular.py --iioc-tissue iioc/iioc-tissue.npy --growth-plate-face iioc/growth-plate-proximal-face.npy --hu-aligned frame/tibia-hu.npy --annotations annotations.json --out trab` | `trab/qc-coronal.jpg`: cyan sits under the plate and inside the cortex |
| 6 | ROI-3 and cortex under the growth plate (section C) | `metaphysis_roi.py --hu-aligned frame/tibia-hu.npy --mask frame/tibia-mask.npy --growth-plate-face iioc/growth-plate-proximal-face.npy --annotations annotations.json --out meta` | `meta/qc-roi3.jpg`: ROI-3 sits in marrow below the plate and clear of the cortex outline |
| 7 | Tb.N, Tb.Th, Tb.Sp, nodes, ends on ROI-2 and ROI-3 | `morphometry.py trabecular --roi <tissue.npy> --bone <bone.npy> --grid <tissue.json> --out <dir> [--skeleton]` | the QC image it writes |
| 8 | Ct.Th at 100 and 1000 um; plate thickness | `morphometry.py cortical` (commands below) | its QC image |
| 9 | Place four femoral landmarks on a 3D render of the femur, snap them to the bone, then compute | `femoral_frame.py --landmarks landmarks.json --hu-json hu.json --labels labels.npy --out femoral` | the render with the four points and the two lines drawn; the `warnings` the script prints |

Commands for step 8 (axis 0 is W, depth grows with W):

```
morphometry.py cortical --cortex meta/cortex.npy --surface meta/growth-plate-distal-face.npy --axis 0 --direction 1 \
  --depth-um 100 --slab-um 50 --name Ct.Th-100 --grid meta/cortex.json --out meta/ct      # then --depth-um 1000
morphometry.py cortical --cortex iioc/medial-plate-run.npy --surface iioc/articular-top-surface.npy --axis 0 \
  --direction 1 --depth-um 175 --slab-um 350 --name plate-medial --grid iioc/medial-plate-run.json --out plate
```

The threshold is `--threshold` (default 2500 HU, `mouse-knee-anatomy`). Rerun with the changed trace to test how
much a boundary matters: `iioc.py --gp-shift-voxels 2` and `tibial_trabecular.py --upper-shift-voxels 2` exist for
that. A shift is a sensitivity check, not an error bar.

## Aligned grid and annotations

`tibia_frame.py` writes `tibia-hu.npy`, `tibia-mask.npy` and `tibia-frame.json` on an **aligned grid**: array axes
(W, V, U), 0.0105 mm voxels (the scan's), W from the joint toward the shaft, +U roughly medial, +V anterior. Its
`grid_id` is derived from the scan's. **Every coordinate below is an index on that grid**, as `[u, w]` (column,
row) read off a coronal section at a given V, or `[u, v, w]` for a point. Check the sidecar `grid_id` before you
reuse an annotation file on another run: indices mean nothing on another frame. Femoral landmarks are the exception:
they are `[z, y, x]` indices on the scan grid.

One `annotations.json` can hold all three sections. Each script reads only its own keys.

**A, for `iioc.py`**

```json
{
  "growth_plate_curves": {"60": [[60, 149], [170, 150]], "80": [[60, 145], [210, 159]]},
  "articular_corrections": [{"u_range": [120, 210], "v_range": [150, 181],
                             "curves": {"150": [[120, 87], [210, 95]], "180": [[120, 81], [210, 91]]}}],
  "compartment_midpoint_u": {"lateral": 140, "medial": 290},
  "width_points_uvw": [[36, 173, 137], [378, 173, 177]],
  "growth_plate_mid_u": 207, "height_section_v": 218,
  "plate_patches": {"medial": {"u": [270, 310], "v": [175, 215]}, "lateral": {"u": [120, 160], "v": [175, 215]}}
}
```

- `growth_plate_curves` (required): the proximal face of the growth plate, as curves on at least two V sections,
  `u` strictly increasing. The surface is linear in U along a curve and linear in V between curves, and constant
  past the ends: trace across the whole width, and expect edge guesses to be wrong.
- `articular_corrections` (optional): where part of the tibia label is really femur or fibula above the articular
  surface, `curves` mark the true articular surface inside `u_range` x `v_range`; ROI-1 keeps only what lies below.
- `compartment_midpoint_u` (required): the U index at the middle of each plateau compartment.
- `width_points_uvw` (required): deck #10: the centre of the fibula-tibia junction on the tibial surface, and the
  most prominent point on the other side.
- `growth_plate_mid_u` (optional): where "the middle of the growth plate" is for height #7; default is the midpoint
  of the two width points.
- `height_section_v` (optional): the coronal section the heights are measured on; default is where the footprint's
  growth-plate-to-top distance is largest.
- `plate_patches` (optional): U and V ranges of the subchondral-plate patch per compartment; default is 500 um
  wide (deck figure) around the compartment midpoint and `height_section_v`.

**B, for `tibial_trabecular.py`**: `under_plate_curves` (same schema as the curves above): the boundary between the
subchondral plate and the trabecular compartment, with the end points on the inner side of the cortex, because the
first and last point of each curve limit ROI-2 laterally. `v_limits`: `[first V, last V]`.

**C, for `metaphysis_roi.py`**: either `growth_plate_distal_curves` (the distal face of the growth-plate band, traced
like the proximal one) or `growth_plate_thickness_mm` (the band's thickness, an assumption you read off a section;
the script then offsets the proximal face and says so in its output). OA6-1RK has a thin perforated mineralized
band, 100 to 200 um thick, not a clean cartilage plate: trace the distal face if you can.

**D, `landmarks.json`** (scan grid, `[z, y, x]`): `a` midpoint of the upper line of the intercondylar groove, `b`
intercondylar notch, `c` midpoint of the ridge on the lateral condyle, `d` vertex of the medial condyle (deck figure,
slide 7). Place them on a 3D render, then check `off_bone_mm` in `femoral.json`: a landmark more than 0.05 mm
from femur bone is in the joint space or floating, and the script warns.

## What the deck says, and what replaces the old run

- #10 tibial width: from the centre of the fibula-tibia junction on the tibial surface to the prominent point on the
  other side. The old run used a chord between growth-plate junction points at one section: do not reuse it.
- #26 DFL: a (midpoint of the upper line of the intercondylar groove) to b (the notch). #27 DFW: c (midpoint of the
  ridge on the lateral condyle) to d (vertex of the medial condyle). The old run used an outer-edge chord at one
  plane for the width: do not carry it over. #28 is DFW / DFL.
- #7 to #9 heights: from the middle of the growth plate (whole, medial compartment, lateral compartment) up to the
  top surface of the articular bone, vertically (along W).
- ROI-1 is the IIOC from growth plate to articular surface. ROI-2 is what remains after removing the subchondral
  bone plate and the cortical line next to the growth plate. ROI-3 starts 50 um below the growth plate, runs 200 um,
  and stays 20 um from cortical bone.

## The 28 parameters

Status is what the code does today. "Computed" means the script produces the number from the regions you traced; it
does not mean the number is validated. Nothing here has been checked against the lab's own software or a second scan.

| # | Parameter | Region | Method | Status |
|---|---|---|---|---|
| 1 | Patella volume | label 3 | label volume | not here: `label_stats.py` (`segmentation-check`), see `mouse-knee-anatomy` |
| 2 | Lateral meniscus/osteophyte volume | not defined | no label is mapped to it | **not computed**: the lab must say which structure (`mouse-knee-anatomy`) |
| 3 | Medial meniscus/osteophyte volume | not defined | same | **not computed**: same |
| 4 | TV of IIOC | ROI-1 | voxel count on the scan grid | computed by `iioc.py`:`iioc_tv` |
| 5 | BV in IIOC | ROI-1 | unresampled HU above threshold | computed by `iioc.py`:`iioc_bv` |
| 6 | BV/TV in IIOC | ROI-1 | BV / TV (fraction) | computed by `iioc.py`:`iioc_bv_tv` |
| 7 | Height of IIOC | ROI-1, middle of growth plate | W distance, face to top | computed by `iioc.py`:`iioc_height` (new definition, no old reference) |
| 8 | Height, medial compartment | ROI-1 | same at the medial midpoint | computed by `iioc.py`:`iioc_height_medial` |
| 9 | Height, lateral compartment | ROI-1 | same at the lateral midpoint | computed by `iioc.py`:`iioc_height_lateral` |
| 10 | Tibial width at the growth plate | growth plate | distance between two annotated points | computed by `iioc.py`:`tibial_width`, only as good as your two points |
| 11 | Subchondral plate thickness, medial | plate patch | first-run length, and sphere thickness of the run mask | computed, **unvalidated**: `iioc.py`:`subchondral_plate_medial_first_run` and `morphometry.py cortical`. The two disagree by about 2x on OA6-1RK; the deck does not say which it means |
| 12 | Subchondral plate thickness, lateral | plate patch | same | computed, **unvalidated**: `subchondral_plate_lateral_first_run`, same caveat |
| 13 | TV of IIOC-trab | ROI-2 | voxel count | computed by `tibial_trabecular.py`:`iioc_trab_tv` |
| 14 | BV of IIOC-trab | ROI-2 | HU above threshold | computed by `tibial_trabecular.py`:`iioc_trab_bv` |
| 15 | BV/TV in IIOC-trab | ROI-2 | fraction | computed by `tibial_trabecular.py`:`iioc_trab_bv_tv` |
| 16 | TV, proximal tibial trabeculae | ROI-3 | voxel count | computed by `metaphysis_roi.py`:`roi3_tv` |
| 17 | BV within ROI-3 | ROI-3 | HU above threshold | computed by `metaphysis_roi.py`:`roi3_bv` |
| 18 | BV/TV | ROI-3 | fraction | computed by `metaphysis_roi.py`:`roi3_bv_tv` |
| 19 | Tb.N | ROI-3 | sphere method | by `morphometry.py trabecular` on `roi3-*.npy` (run on OA6-1RK) |
| 20 | Tb.Th | ROI-3 | sphere method | same |
| 21 | Tb.Sp | ROI-3 | sphere method | same |
| 22 | Tb.Nd (nodes) | ROI-3 | skeleton | `morphometry.py trabecular --skeleton` (run on OA6-1RK; unvalidated) |
| 23 | Tb.Tm (ends) | ROI-3 | skeleton | same |
| 24 | Cortical thickness, 100 um under the plate | cortex | sphere thickness in a slab | `metaphysis_roi.py` makes the cortex mask and the surface, `morphometry.py cortical` measures (run on OA6-1RK; the cortex mask is a heuristic) |
| 25 | Cortical thickness, 1000 um under the plate | cortex | same | same |
| 26 | DFL | femur | landmark distance a-b | computed by `femoral_frame.py`:`DFL` |
| 27 | DFW | femur | landmark distance c-d | computed by `femoral_frame.py`:`DFW` |
| 28 | DFW/DFL | femur | ratio | computed by `femoral_frame.py`:`DFW/DFL` |

Also **not computed**: the deck's "developing new parameters" (centre lines of trabeculae along the long axis of
ROI-3), and the vertebral parameters (slides 9 and 10: another bone, out of this workflow's knee scope). ROI-2 here
is the "sub-plate, above-growth-plate" trabecular compartment; ROI-2 TV excludes the cortex and growth-plate
clearance by 0.021 mm each (`--shell-clearance-mm`, `--growth-clearance-mm`), a choice of the old run, not of the deck.

## Limits to state in every report

- Every region follows traces you made on one scan; the old run labelled its values provisional and so do we.
- The aligned grid is a linear resampling of HU. TV and BV for ROI-1 are counted back on the scan grid; the others
  on the aligned grid. The difference on OA6-1RK is below 1%.
- ROI-3's cortex edge uses an estimated cortex depth (reported as `cortex_estimate_mm`); a wrong depth moves ROI-3.
- Medial/lateral follows the aligned frame (+U medial). Confirm it on the render before you name a compartment.
