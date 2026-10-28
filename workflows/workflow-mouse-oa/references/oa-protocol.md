# OA subchondral protocol (lab deck, after Tang et al.)

The lab's parameter deck (28 knee parameters, revised 2026-10-27) is the measurement spec; Tang et al. is the
method behind it. Where the deck and the old OA6-1RK run disagree, the deck wins (below). Code computes geometry
and volumes from regions you trace; you look at every region before you trust a number. All annotations are
proposals until you have seen them drawn on the scan. This reference owns the mapping from the 28 parameters to scripts;
`bone-morphometry` defines the measurements and builds no region.

Inputs: `hu.npy` and `hu.json` (scan-intake), `labels.npy` on the same grid (femur 1, tibia 2; see `anatomy.md`).
Use isotropic voxels. Scripts are in `resources/` of this workflow, print one JSON line and write next to `--out`. The masks that
need thickness or nodes go to `morphometry.py` (`bone-morphometry`), which takes the masks and their sidecar as `--grid`.

**Bone threshold.** BV is always the ROI and HU above the lab's 2.16/cm, converted to this scan's HU from the calibration in
`hu.json` (2459.875 HU on OA6-1RK). The scripts take `--hu-json` for it; `--threshold` overrides. No label gates BV. BV/TV is in %.

## Steps, in order

| # | Do | Script | Look at |
|---|---|---|---|
| 1 | Align the tibia: shaft axis, +W from joint toward shaft, crop around the joint end | `tibia_frame.py --hu hu.npy --hu-json hu.json --labels labels.npy --label 2 --out frame` | `frame/tibia-frame-qc.jpg`: coronal sections, joint at top, tibia outline following the bone. If the crop cuts bone or the bone looks tilted, set `--shaft-z`, `--epiphysis-z` or the crop flags |
| 2 | Trace the growth-plate proximal face on coronal sections (annotations, section A) | none: you write `annotations.json` | coronal sections of `tibia-hu.npy` with a pixel grid, every 20 V indices over the epiphysis |
| 3 | ROI-1 (IIOC), heights, width, plate columns | `iioc.py --hu-aligned frame/tibia-hu.npy --mask frame/tibia-mask.npy --frame frame/tibia-frame.json --hu hu.npy --hu-json hu.json --annotations annotations.json --out iioc` | `iioc/qc-coronal.jpg` (green ROI-1 must stop at the orange face, include marrow, exclude femur and growth-plate band) and `qc-heights.jpg` (rulers along W, endpoints at the face and the articular top) |
| 4 | Trace the boundary under the subchondral plate (section B) | none | coronal sections with the ROI-1 outline |
| 5 | ROI-2 (IIOC trabecular) | `tibial_trabecular.py --iioc-tissue iioc/iioc-tissue.npy --growth-plate-face iioc/growth-plate-proximal-face.npy --hu-aligned frame/tibia-hu.npy --hu-json hu.json --annotations annotations.json --out trab` | `trab/qc-coronal.jpg`: cyan sits under the plate and inside the cortex |
| 6 | Trace the growth-plate distal face (section C), then ROI-3 and the cortex under the plate | `metaphysis_roi.py --hu-aligned frame/tibia-hu.npy --mask frame/tibia-mask.npy --hu-json hu.json --annotations annotations.json --out meta` | `meta/qc-roi3.jpg`: ROI-3 sits in marrow below the plate and clear of the cortex outline |
| 7 | Tb.N, Tb.Th, Tb.Sp, nodes, ends on ROI-2 and ROI-3 | `morphometry.py trabecular --roi <tissue.npy> --bone <bone.npy> --grid <tissue.json> --out <dir> [--skeleton]` | the QC image it writes |
| 8 | Ct.Th at 100 and 1000 um; plate thickness | `morphometry.py cortical` (commands below) | its QC image |
| 9 | Femoral landmarks: place four points on a 3D render of the femur (`regions-and-landmarks`, `pick.py` with picks named `a`, `b`, `c`, `d`), then compute | `femoral_frame.py --landmarks points.json --hu-json hu.json --labels labels.npy --out femoral` | `pick-check.jpg` of each point, and `femoral.json`: `off_bone_mm` and the `warnings` the script prints. There is no image with the four points and the two lines drawn |
| 10 | Volumes of labels 3, 5 and 6 (deck #1 to #3) | `measure.py --spec <this workflow>/resources/deck_volumes_spec.json --grid hu.json --out volumes.json` (the spec names `labels.npy` relative to where you run it) | the 3D sheet (`visual-check`) |
| 11 | Hand the points to the lab (below) | `amira_landmarks.py` | the lab opens it in Amira |

Commands for step 8 (axis 0 is W, depth grows with W):

```
morphometry.py cortical --cortex meta/cortex.npy --surface meta/growth-plate-distal-face.npy --axis 0 --direction 1 \
  --depth-um 100 --slab-um 50 --name Ct.Th-100 --grid meta/cortex.json --out meta/ct      # then --depth-um 1000
morphometry.py cortical --cortex iioc/medial-plate-run.npy --surface iioc/articular-top-surface.npy --axis 0 \
  --direction 1 --depth-um 175 --slab-um 350 --name plate-medial --grid iioc/medial-plate-run.json --out plate
```

Rerun with the changed trace to test how much a boundary matters: `iioc.py --gp-shift-voxels 2` and
`tibial_trabecular.py --upper-shift-voxels 2` exist for that. A shift is a sensitivity check, not an error bar.

## Aligned grid and annotations

`tibia_frame.py` writes `tibia-hu.npy`, `tibia-mask.npy` and `tibia-frame.json` on an **aligned grid**: array axes
(W, V, U), the scan's voxel size, W from the joint toward the shaft. +U medial and +V anterior come from a sign rule on scan y
and `--joint-end` that assumes one knee and one scan orientation: **confirm it on the QC montage** before you name a side
(a left knee flips it). Its `grid_id` is derived from the scan's. **Every coordinate below is an index on that grid**, as
`[u, w]` (column, row) read off a coronal section at a given V, or `[u, v, w]` for a point. Check the sidecar `grid_id` before you
reuse an annotation file on another run: indices mean nothing on another frame. Femoral landmarks are the exception: they are
`[z, y, x]` indices on the scan grid.

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
- `compartment_midpoint_u` (required): the U index at the middle of each plateau compartment. A height point outside the ROI-1
  footprint (or within 3 voxels of its edge) stops the script with a sentence: move the point.
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

**C, for `metaphysis_roi.py`**: `growth_plate_distal_curves` (required), the distal face of the growth-plate band, traced like
the proximal one on the coronal sections of `tibia-hu.npy`. There is no thickness fallback: ROI-3 starts 50 um below this face, so
a guessed band thickness inside the 100 to 200 um range seen on OA6-1RK moves ROI-3 BV/TV from 23% to 15% and is not a
measurement. OA6-1RK has a thin perforated mineralized band, not a clean cartilage plate: trace the face you can see, and look
at it drawn on the sections before you run.

**D, `landmarks.json`** (scan grid, `[z, y, x]`): `a` midpoint of the upper line of the intercondylar groove, `b`
intercondylar notch, `c` midpoint of the ridge on the lateral condyle, `d` vertex of the medial condyle (deck figure,
slide 7). `femoral_frame.py` takes either this file or the `points.json` `pick.py` writes for picks named `a` to `d`, so
nothing needs converting by hand. Check `off_bone_mm` in `femoral.json`: a landmark more than 0.05 mm from femur bone is in
the joint space or floating, and the script warns.

## What the deck says, and what replaces the old run

- #10 tibial width: from the centre of the fibula-tibia junction on the tibial surface to the prominent point on the
  other side. The old run used a chord between growth-plate junction points at one section: do not reuse it.
- #26 DFL: a (midpoint of the upper line of the intercondylar groove) to b (the notch). #27 DFW: c (midpoint of the
  ridge on the lateral condyle) to d (vertex of the medial condyle). The old run used an outer-edge chord at one
  plane for the width: do not carry it over. #28 is DFW / DFL.
- #7 to #9 heights: from the middle of the growth plate (whole, medial compartment, lateral compartment) up to the top
  surface of the articular bone, "vertically". **Open for the lab:** the lab accepts perpendicular to the growth-plate plane, or
  along the tibial shaft axis if that is easier. The script measures along W, the shaft axis, and `iioc.json` carries
  `shaft_to_growth_plate_normal_deg`, the angle between that axis and the normal of the plane fitted to the traced face
  (10.7 degrees on OA6-1RK), so a reader sees how far the two definitions are apart.
- #22 and #23: Tb.Nd and Tb.Tm are counts per mm^3 of tissue volume (closed). They are counted in the part of ROI-3 away from
  its edge and divided by that volume, which the values carry.
- #2 and #3 (meniscus plus osteophytes): in meniscus-injury OA, new bone forms around the injured meniscus and the spurs cannot
  be separated from it, so the lab measures meniscus and spurs together as one volume per side. On OA6-1RK, **#3 medial is label 5
  and #2 lateral is label 6** (the lab's working reading; not anatomically checked). Both volumes come from `measure.py`
  (step 10). Still open: whether label 9's pieces and the tibial margin fragments (labels 10, 11) count toward a side.
- ROI-1 is the IIOC from growth plate to articular surface. ROI-2 is what remains after removing the subchondral
  bone plate and the cortical line next to the growth plate. ROI-3 starts 50 um below the growth plate, runs 200 um,
  and stays 20 um beyond the cortex from the outer edge (the estimated cortex depth plus 20 um, measured in the ROI-3 slices).

## The 28 parameters

The only table of the parameters. Status is what the code does today. "Computed" means the script produces the number from the
regions you traced; it does not mean the number is validated. Nothing here has been checked against the lab's own software or a
second scan. BV/TV is in %. Every thickness carries the voxel size; the sphere method reads **high** for structures an odd number
of voxels wide (`bone-morphometry`), and whether Scanco uses the same convention is open.

| # | Parameter | Region | Script and field | Status |
|---|---|---|---|---|
| 1 | Patella volume | label 3 | `measure.py` (step 10) `patella_volume` | computed; whether label 12 counts is open |
| 2 | Lateral meniscus/osteophyte volume | label 6 | `measure.py` `lateral_meniscus_osteophyte_volume` | computed; the mapping is the lab's working reading, whether labels 9 to 11 count is open |
| 3 | Medial meniscus/osteophyte volume | label 5 | `measure.py` `medial_meniscus_osteophyte_volume` | computed; same |
| 4 | TV of IIOC | ROI-1 | `iioc.py` `iioc_tv` | computed (counted on the scan grid) |
| 5 | BV in IIOC | ROI-1 | `iioc.py` `iioc_bv` | computed (unresampled HU) |
| 6 | BV/TV in IIOC | ROI-1 | `iioc.py` `iioc_bv_tv` (%) | computed |
| 7 | Height of IIOC | ROI-1, middle of growth plate | `iioc.py` `iioc_height` | computed along W; "vertical" is open, see above (new definition, no old reference) |
| 8 | Height, medial compartment | ROI-1 | `iioc.py` `iioc_height_medial` | computed, same caveat |
| 9 | Height, lateral compartment | ROI-1 | `iioc.py` `iioc_height_lateral` | computed, same caveat |
| 10 | Tibial width at the growth plate | growth plate | `iioc.py` `tibial_width` | computed, only as good as your two points |
| 11 | Subchondral plate thickness, medial | plate patch | `iioc.py` `subchondral_plate_medial_first_run` and `morphometry.py cortical` on `medial-plate-run.npy` | computed, **unvalidated**: the two disagree by about 2x on OA6-1RK and the deck does not say which it means |
| 12 | Subchondral plate thickness, lateral | plate patch | `subchondral_plate_lateral_first_run`, same | computed, **unvalidated**, same caveat |
| 13 | TV of IIOC-trab | ROI-2 | `tibial_trabecular.py` `iioc_trab_tv` | computed (aligned grid) |
| 14 | BV of IIOC-trab | ROI-2 | `iioc_trab_bv` | computed |
| 15 | BV/TV in IIOC-trab | ROI-2 | `iioc_trab_bv_tv` (%) | computed |
| 16 | TV, proximal tibial trabeculae | ROI-3 | `metaphysis_roi.py` `roi3_tv` | computed, needs a traced distal face |
| 17 | BV within ROI-3 | ROI-3 | `roi3_bv` | computed |
| 18 | BV/TV | ROI-3 | `roi3_bv_tv` (%) | computed |
| 19 | Tb.N | ROI-3 | `morphometry.py trabecular` on `roi3-*.npy` | computed; model-derived, inherits the thickness bias |
| 20 | Tb.Th | ROI-3 | same | computed, with `voxel_mm` |
| 21 | Tb.Sp | ROI-3 | same | computed, with `voxel_mm` |
| 22 | Tb.Nd (nodes) | ROI-3 | same with `--skeleton` | computed per mm^3 of the counted tissue volume, **unvalidated** |
| 23 | Tb.Tm (ends) | ROI-3 | same | same |
| 24 | Cortical thickness, 100 um under the plate | cortex | `metaphysis_roi.py` makes the cortex mask, `morphometry.py cortical` measures | computed; the cortex mask is a heuristic |
| 25 | Cortical thickness, 1000 um under the plate | cortex | same | same |
| 26 | DFL | femur | `femoral_frame.py` `DFL` | computed |
| 27 | DFW | femur | `femoral_frame.py` `DFW` | computed |
| 28 | DFW/DFL | femur | `femoral_frame.py` `DFW/DFL` | computed |

Also **not computed**: the deck's "developing new parameters" (centre lines of trabeculae along the long axis of ROI-3) and the
vertebral parameters (slides 9 and 10: another bone, out of this workflow's knee scope). ROI-2 TV excludes the cortex and growth-plate
clearance by 0.021 mm each (`--shell-clearance-mm`, `--growth-clearance-mm`), a choice of the old run, not of the deck.

## Hand-off: checking points in Amira

The lab checks the width points (#10) and the femoral landmarks (#26, #27) in Amira. Write them as a landmark set:

```
python <regions-and-landmarks>/resources/amira_landmarks.py --points iioc/width-points-scan.json --header hu.json --out width.landmarkAscii
python <regions-and-landmarks>/resources/amira_landmarks.py --points landmarks.json --header hu.json --out femoral.landmarkAscii
```

Both are scan-grid points moved to physical millimetres with the DICOM affine. Report the files with the measurements they check.
`regions-and-landmarks` says what is and is not verified about the format.

## Limits to state in every report

- Every region follows traces you made on one scan; the old run labelled its values provisional and so do we.
- The aligned grid is a linear resampling of HU. TV and BV for ROI-1 are counted back on the scan grid; the others on the aligned
  grid. The difference on OA6-1RK is below 1%.
- ROI-3 depends on the traced distal face, and its cortex edge uses an estimated cortex depth (reported as `cortex_estimate_mm`):
  a wrong depth moves ROI-3.
- Medial/lateral follows the aligned frame (+U medial). Confirm it on the render before you name a compartment.
- Tb.Nd and Tb.Tm are exploratory, and Tb.Th, Tb.Sp, Tb.N and Ct.Th carry the sphere-method bias with the voxel size.
