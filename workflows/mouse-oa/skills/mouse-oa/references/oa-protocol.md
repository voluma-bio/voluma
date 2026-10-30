# OA subchondral protocol (lab deck, after Tang et al.)

The lab's parameter deck (28 knee parameters, revised 2026-10-27) is the measurement spec; Tang et al. is the
method behind it. Where the deck and the old OA6-1RK run disagree, the deck wins (below). Code computes geometry
and volumes from regions you trace; you look at every region before you trust a number, against
`examples/README.md` in the skill directory. This reference owns the mapping from the 28 parameters to scripts; `bone-morphometry`
defines the measurements and builds no region.

Inputs: `hu.npy` and `hu.json` (scan-intake), `labels.npy` on the same grid (femur 1, tibia 2; `anatomy.md`).
Isotropic voxels. Every number comes out as a result record (`microct-core`) under the output ids of the table
below; `kind` is `measurement` for a deck parameter and `diagnostic` for a number that helps you judge one.

**One owner per concept.** Region scripts (`iioc.py`, `tibial_trabecular.py`, `metaphysis_roi.py`) write regions
and, for `iioc.py`, the geometry that needs the protocol's own steps (heights, width, plate columns). All TV, BV and
BV/TV, and the thickness and node measures, come from `morphometry.py` (`bone-morphometry`). BV uses the measurement threshold (`microct-core`), which `morphometry.py` computes from
`--hu-json`, kept apart from `--grid`, the grid the region is on.

**One spec for the numbers.** `resources/protocol.json` is keyed by output id (`outputs.json`'s ids) and holds every number the
protocol fixes and the output ids a script writes its values under: ROI-3's start, length and clearance, Ct.Th's depth and slab,
the plate patch width, the clearances of ROI-2, the label ids of #1–3, the points each femoral distance joins. A script takes
`--spec protocol.json` and reads its entry; there is no flag for a protocol number or an output id, and the record's `params` say
what was used. A region script reads the entry of its own region (`roi-iioc`, `roi-iioc-trabecular`, `roi-metaphyseal`);
`morphometry.py` and `measure.py` take `--output <id>`, the region's id (or the slab's, or the values' own) whose entry they read.
Change a protocol number there, once; prose here and in the examples names the quantity, not its value. The display window of every
QC image is `anatomy.json`'s (`--window anatomy.json`).

**Grid rule.** A volume is counted where the region is defined: a region traced on the aligned stack is counted on
the aligned stack, on `tibia-hu.npy`, a linear resampling of the scan. Counting ROI-1 on the unresampled scan grid
instead moves BV/TV by about 0.26 points: a known resampling effect, left in. State which grid a number was counted
on.

## Steps, in order

| # | Do | Script | Look at |
|---|---|---|---|
| 1 | Align the tibia (in the `iioc` task, `--out frame`: later tasks read `/outputs/iioc/frame/`): shaft axis, +W from joint toward shaft, crop around the joint end | `tibia_frame.py` | `tibia-frame-qc.jpg`: coronal sections, joint at top, tibia outline following the bone; a crop that cuts bone or a tilted bone means the shaft or epiphysis range needs setting |
| 2 | Trace the growth plate's proximal face on coronal sections (annotation A) | you write `annotations.json` | coronal sections of `tibia-hu.npy` with a pixel grid, every 20 V indices over the epiphysis |
| 3 | ROI-1 (IIOC), heights, width, plate columns (`--out iioc`: later tasks read `/outputs/iioc/iioc/`) | `iioc.py` | `qc-coronal.jpg` and `qc-heights.jpg` against `examples/README.md` (iioc) |
| 4 | Trace the boundary under the subchondral plate (annotation B) | you | coronal sections with the ROI-1 outline |
| 5 | ROI-2 (IIOC trabecular) | `tibial_trabecular.py` | `qc-coronal.jpg` against `examples/README.md` (trabecular-roi) |
| 6 | Trace the growth plate's distal face (annotation C), then ROI-3 and the cortex under the plate (`--out meta`: the `cortical` task reads `/outputs/metaphyseal-roi/meta/`) | `metaphysis_roi.py` | `qc-roi3.jpg` and `qc-roi3-axial.jpg` against `examples/README.md` (metaphyseal-roi) |
| 7 | TV, BV, BV/TV of ROI-1 and ROI-2 (#4–6, #13–15); TV, BV, BV/TV, Tb.N, Tb.Th, Tb.Sp, nodes and ends of ROI-3 (#16–23) | `morphometry.py volumes --output roi-iioc` and `roi-iioc-trabecular`; `trabecular --output roi-metaphyseal` | the QC images `trabecular` writes (`bone-morphometry`) |
| 8 | Ct.Th at the two levels below the distal face (#24, #25), on the cortex mask and face `metaphyseal-roi` wrote (the face is traced once; `metaphysis_roi.py` is not run again); plate thickness per compartment (#11, #12) on the plate runs `iioc.py` wrote, under the articular top surface | `morphometry.py cortical --output roi-cortex-100um`, `roi-cortex-1000um`, `roi-subchondral-plate-medial` or `-lateral` (the slab's declared id; its depth and thickness are in the spec) | its QC image against `examples/README.md` (cortical, subchondral-plate) |
| 9 | Femoral landmarks: four points on a 3D render of the femur (`regions-and-landmarks`, picks named `a` to `d`), then compute | `femoral_frame.py --spec` on the `points.json` files `pick.py` wrote | each `pick-check.jpg` against `examples/README.md` (femoral-geometry); the script refuses a bad landmark (D) |
| 10 | Volumes of labels 3, 5 and 6 (#1–3) | `measure.py --spec resources/protocol.json --output patella-volume lateral-meniscus-osteophyte-volume medial-meniscus-osteophyte-volume --labels labels.npy` | the 3D sheet (`visual-check`) |
| 11 | Hand the points to the lab | `amira_landmarks.py` | the lab opens it in Amira |

`iioc.py --gp-shift-mm` and `tibial_trabecular.py --upper-shift-mm` rerun with a moved trace, to see how much a
boundary matters: a sensitivity check, not an error bar.

## Aligned grid and annotations

`tibia_frame.py` writes `tibia-hu.npy`, `tibia-mask.npy` and `tibia-frame.json` on an **aligned grid**: array
axes (W, V, U), the scan's voxel size, W from the joint toward the shaft. +U medial and +V anterior come from a sign
rule on scan y and the joint end that assumes one knee and one scan orientation: **confirm it on the QC montage**
before you name a side (a left knee flips it). Every annotation is an index on that grid and carries its `grid_id`;
the scripts refuse a file without one or from another grid, because indices mean nothing on another frame. They
also refuse, before writing anything, a key they don't know, a value of the wrong form, and an index outside the grid. The
femoral landmarks are the exception: `[z, y, x]` on the scan grid.

What the annotations are (their keys, which are required, and the refusals are in each script's `--help`; the curve
schema is `regions-and-landmarks`'):

- **A, for `iioc.py`.** The growth plate's proximal face, traced on at least two coronal sections across the whole
  width (edge guesses will be wrong: trace what you see). Where part of the tibia label is really femur or fibula
  above the articular surface, a correction traces the true articular surface over that patch, and ROI-1 keeps
  only what lies below. The U index of each plateau compartment's middle (a height point outside ROI-1's footprint
  stops the script: move it). The two width points (#10): the centre of the fibula–tibia junction on the tibial
  surface, and the most prominent point on the other side. Optional: where "the middle of the growth plate" is for
  #7 (default: midway between the width points), the coronal section the heights are measured on (default: where
  the footprint's growth-plate-to-top distance is largest), and the plate patches per compartment (default: the spec's
  `plate_patch_width_um` wide around the compartment midpoint).
- **B, for `tibial_trabecular.py`.** The boundary between the subchondral plate and the trabecular compartment,
  with the end points on the inner side of the cortex: the first and last point of each curve limit ROI-2 across.
  The V range it covers.
- **C, for `metaphysis_roi.py`.** The growth plate's distal face, traced like the proximal one, over at least the
  proximal face's V range. There is no thickness fallback: ROI-3 starts a fixed offset below this face (the spec's `start_um`), and a guessed band
  thickness inside the 100 to 200 µm range seen on OA6-1RK moves ROI-3 BV/TV from 23% to 15%. OA6-1RK has a thin
  perforated mineralized band, not a clean cartilage plate: trace the face you can see and look at it drawn on the
  sections before you run.
- **D, the landmark points files** (scan grid, each name once across the files, straight from `pick.py`: do not
  copy coordinates into a new file). `a` midpoint of the upper line of the intercondylar groove, `b` intercondylar
  notch, `c` midpoint of the ridge on the lateral condyle, `d` vertex of the medial condyle (deck slide 7). `a` and
  `b` go on a long view of the femur that shows the shaft and the groove side-on; `c` and `d` can go on the
  joint-face view. `femoral_frame.py` refuses a landmark more than 0.05 mm from femur bone, a DFL under 0.4 of DFW
  (`a` and `b` placed end-on, as on the first full run) or an SI axis pointing away from the femur: re-place the
  points; the refusal is not a warning to explain.

`oa6-1rk-annotations.json` in this directory is the OA6-1RK annotation set (A and B, no C) in that schema, with
the `grid_id` of the frame it was traced on: a worked example of the keys and the point order, and a record of that
scan, not a starting point for another.

## What the deck says, and what replaces the old run

- #10 tibial width: from the centre of the fibula–tibia junction on the tibial surface to the prominent point on
  the other side. The old run used a chord between growth-plate junction points at one section: do not reuse it.
- #26 DFL: `a` to `b`. #27 DFW: `c` to `d`. The old run used an outer-edge chord at one plane for the width: do not
  carry it over. #28 is DFW / DFL.
- #7 to #9 heights: from the middle of the growth plate (whole, medial compartment, lateral compartment) up to the
  top surface of the articular bone, "vertically". **Open for the lab:** perpendicular to the growth-plate plane
  or along the tibial shaft axis; it has not chosen. `iioc.py` reports both: along W (the shaft axis) as the three
  deck values, perpendicular as a `-normal` diagnostic beside each (the ray from the traced face along the normal
  of the plane fitted to it, to where it leaves ROI-1). The traced face is far from a plane (on OA6-1RK the plane
  residual was 0.113 mm, tilt 10.7°), so the two differ in size and sign (#7: 0.8738 along W, 0.8416
  perpendicular). Report both with the plane residual, and say which is the deck value. "The middle of the growth
  plate" for #7 is the midpoint of the two width points: a new definition, with no old reference. The old run's
  "max local height" is a diagnostic.
- #22 and #23: Tb.Nd and Tb.Tm are counts per mm³ of tissue volume, counted away from ROI-3's edge and divided by
  that volume, which the values carry.
- #2 and #3 (meniscus plus osteophytes): in meniscus-injury OA new bone forms around the injured meniscus and the
  spurs cannot be separated from it, so the lab measures meniscus and spurs together, one volume per side. On
  OA6-1RK **#3 medial is label 5 and #2 lateral is label 6** (the lab's working reading, not anatomically
  checked). Open: whether label 9's pieces and the tibial margin fragments (labels 10, 11) count toward a side.
- #1 to #3 count **label voxels**, and a label holds bone at the segmentation threshold, not at the measurement
  threshold that gates BV (`microct-core`): the deck volumes run a little under a count at the measurement
  threshold (about 0.6% of the label on OA6-1RK). These three are label volumes, not BV.
- ROI-1 is the IIOC from growth plate to articular surface. ROI-2 is what remains after removing the subchondral
  bone plate and the cortical line next to the growth plate. ROI-3 starts below the growth plate by the spec's `start_um`, runs `length_um`,
  and stays `cortex_clearance_um` beyond the cortex from the outer edge (the estimated cortex depth plus that clearance).

## The 28 parameters

The only table of the parameters. **Output id** is the id the value is written under (and the id `outputs.json`
binds to); `morphometry.py`, `measure.py` and `femoral_frame.py` read it from `protocol.json`, the other scripts write it themselves. Status is what
the code does today: "computed" means the script produces the number from the regions you traced, not that the
number is validated against the lab's own software or a second scan. BV/TV is in %. Every thickness record carries
the voxel size; the sphere method reads **high** for structures an odd number of voxels wide (`bone-morphometry`),
and whether Scanco uses the same convention is open.

| # | Parameter | Output id | Region | Produced by | Status |
|---|---|---|---|---|---|
| 1 | Patella volume | `patella-volume` | label 3 | `measure.py` (step 10) | computed; whether label 12 counts is open |
| 2 | Lateral meniscus/osteophyte volume | `lateral-meniscus-osteophyte-volume` | label 6 | `measure.py` | computed; the mapping is the lab's working reading, whether labels 9 to 11 count is open |
| 3 | Medial meniscus/osteophyte volume | `medial-meniscus-osteophyte-volume` | label 5 | `measure.py` | computed; same |
| 4 | TV of IIOC | `tv-tibial-iioc` | ROI-1 | `morphometry.py volumes` | computed (aligned grid) |
| 5 | BV in IIOC | `bv-tibial-iioc` | ROI-1 | same | computed |
| 6 | BV/TV in IIOC | `bv-tv-tibial-iioc` (%) | ROI-1 | same | computed |
| 7 | Height of IIOC | `iioc-height` | ROI-1, middle of growth plate | `iioc.py` | computed along W; "vertical" is open, the perpendicular value is `iioc-height-normal` |
| 8 | Height, medial compartment | `iioc-height-medial-compartment` | ROI-1 | `iioc.py` | computed, same caveat |
| 9 | Height, lateral compartment | `iioc-height-lateral-compartment` | ROI-1 | `iioc.py` | computed, same caveat |
| 10 | Tibial width at the growth plate | `tibial-width-at-the-growth-plate` | growth plate | `iioc.py` | computed, only as good as your two points |
| 11 | Subchondral plate thickness, medial | `subchondral-bone-plate-thickness-medial` | plate patch | `morphometry.py cortical` on `medial-plate-run.npy` | computed, **unvalidated**: `iioc.py`'s diagnostic `subchondral-plate-medial-first-run` and the sphere value disagree by about 2× on OA6-1RK and the deck does not say which it means |
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
| 22 | Tb.Nd (nodes) | `metaphyseal-tb-nd` (1/mm³) | ROI-3 | same (the spec lists the node and end ids) | computed per mm³ of the counted tissue volume, **unvalidated** |
| 23 | Tb.Tm (ends) | `metaphyseal-tb-tm` (1/mm³) | ROI-3 | same | same |
| 24 | Cortical thickness, 100 µm under the plate | `cortical-thickness-100-um-below-the-growth-plate` | cortex | `metaphysis_roi.py` makes the cortex mask, `morphometry.py cortical` measures | computed; the cortex mask is a heuristic |
| 25 | Cortical thickness, 1000 µm under the plate | `cortical-thickness-1000-um-below-the-growth-plate` | cortex | same | same |
| 26 | DFL | `distal-femoral-length-dfl` | femur | `femoral_frame.py` | computed |
| 27 | DFW | `distal-femoral-width-dfw` | femur | `femoral_frame.py` | computed |
| 28 | DFW/DFL | `width-length-ratio` | femur | `femoral_frame.py` | computed |

Diagnostics (`kind: diagnostic`) travel in the same records and are not outputs: the perpendicular heights
`*-normal`, `growth-plate-plane-rms`, `iioc-max-local-height`, `subchondral-plate-*-first-run`, `voxel-size`, and
the node and end counts and counted volume of `morphometry.py trabecular`.

Not computed: the deck's "developing new parameters" (centre lines of trabeculae along the long axis of ROI-3) and
the vertebral parameters (another bone, outside this workflow). ROI-2 TV excludes the cortex and growth-plate
clearance by `shell_clearance_mm` and `growth_clearance_mm` of the spec, a choice of the old run, not of the
deck.

## Hand-off: checking points in Amira

The lab checks the width points (#10) and the femoral landmarks (#26, #27) in Amira: write each set with
`amira_landmarks.py` (`regions-and-landmarks`, which also holds the caveat on the format) and report the files with
the measurements they check.

## Limits to state with the measurements they qualify

- Every tibial region (#4–25) follows traces made on one scan; the old run labelled its values provisional and so
  do we. They are counted on the aligned grid, a linear resampling of HU (grid rule above).
- ROI-3 (#16–23) depends on the traced distal face, and its cortex edge uses an estimated cortex depth (reported
  as `cortex_estimate_mm`): a wrong depth moves ROI-3.
- A medial or lateral value (#8, #9, #11, #12) follows the aligned frame's +U medial, confirmed on the render.
- Tb.Nd and Tb.Tm (#22, #23) are exploratory; Tb.Th, Tb.Sp, Tb.N and Ct.Th (#19–21, #24, #25) carry the
  sphere-method bias with the voxel size.
