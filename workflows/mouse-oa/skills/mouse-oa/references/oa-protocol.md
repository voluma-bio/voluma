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

**One spec for the numbers.** `/workflow/workflows/mouse-oa/skills/mouse-oa/resources/protocol.json` is keyed by output id
(`outputs.yaml`'s ids) and holds every number the protocol fixes and the output ids a script writes its values under: ROI-3's
start, length and clearance, Ct.Th's depth and slab, the plate patch width, the clearances of ROI-2, the points each femoral
distance joins. A script takes that path as `--spec` and reads its entry; there is no flag for a protocol number or an output id, and
the record says what was used (the spec's hash in `inputs`, and its numbers in `params`). A label volume (#1-3) takes its label ids
from `/workflow/workflows/mouse-oa/outputs.yaml` (`measure.py --outputs`), the one place the labels are declared. A region script
reads the entry of its own region (`roi-iioc`, `roi-iioc-trabecular`, `roi-metaphyseal`); `morphometry.py` and `measure.py` take
`--output <id>`, the region's id (or the slab's, or the values' own) whose entry they read. Change a protocol number there, once;
prose here and in the examples names the quantity, not its value. Every QC image uses the scan's display window: pass
`--window <scan-settings.json>` (the `scan-settings` output's file) to `tibia_frame.py`, `iioc.py`,
`tibial_trabecular.py`, `metaphysis_roi.py`, `morphometry.py trabecular` and `region_from_curves.py` (the first four require it).

**Grid rule.** A volume is counted where the region is defined: a region traced on the aligned stack is counted on
the aligned stack, on `tibia-hu.npy`, a linear resampling of the scan. Counting ROI-1 on the unresampled scan grid
instead moves BV/TV by about 0.26 points: a known resampling effect, left in. State which grid a number was counted
on.

## Steps, in order

| # | Do | Script | Look at |
|---|---|---|---|
| 1 | Align the tibia (`--out frame`; the later tibial steps work on this frame): the shaft's long axis on W (0° in coronal and sagittal sections; the growth plate keeps its own roll), +W from joint toward shaft, crop around the joint end | `tibia_frame.py` (it refuses a femur passed as the tibia, and a `--joint-end` on the wrong side: fix the labels or the flag it names) | `tibia-frame-qc.jpg` (coronal) and `tibia-frame-qc-sagittal.jpg`: joint at top, the tibial plateau at the top of the outline (not the femoral condyles and the notch between them), the fibula beside the shaft, tibia outline following the bone; on the two sections of each sheet that carry the yellow axis line, the centroid dots and the line run down the middle of the tibial shaft, below the metaphyseal flare and not on the fibula (the other four cut the shaft obliquely, so no line is drawn on them; the line lying on the magenta W line is not a check, the fit puts it there). Dots on the flare or the fibula, or `converged: false`: rerun with `--axis-mm` on the shaft. Shaft still leaning where the dots are wrong: `--tilt-deg`, after which the yellow line leaves magenta by about the tilt. A crop that cuts bone: set the epiphysis range |
| 2 | Propose the growth plate's two faces, check them, and trace the proximal face (annotation A) | `segment_plate` (`plate_faces.py` only when it is not in your tools or returns an error), `prune_plate.py` for strays, then you write `annotations.json` | `qc-plate-<n>.jpg`: every proposed section (the default), each framed on the U span the proposal covered, flagged stretches ticked red, suspect band pieces named in the title; `qc-prune-<n>.jpg` for what you pruned; then zoomed coronal sections of `tibia-hu.npy` with a pixel grid over each flagged or wrong stretch, and over each stretch you trace beyond the spans |
| 3 | ROI-1 (IIOC), heights, width, plate columns (`--out iioc`; the later tibial steps read ROI-1 and its faces) | `iioc.py`, with `--labels`: the scan-grid `labels.npy` the frame was made from | `qc-coronal.jpg` and `qc-heights.jpg` against `examples/README.md` (iioc), and every `qc-faces-<n>.jpg`: the proximal face as delivered, on every traced section, which you open sheet by sheet before you report |
| 4 | Trace the boundary under the subchondral plate (annotation B) | you | coronal sections with the ROI-1 outline |
| 5 | ROI-2 (IIOC trabecular) | `tibial_trabecular.py` | `qc-coronal.jpg` against `examples/README.md` (trabecular-roi) |
| 6 | Check the distal face the proposal gave and retrace what is wrong or flagged (annotation C), then ROI-3 and the cortex under the plate (`--out meta`; the cortical step reads this cortex and face) | `metaphysis_roi.py` | `qc-roi3.jpg` and `qc-roi3-axial.jpg` against `examples/README.md` (metaphyseal-roi), and every `qc-faces-<n>.jpg`: both faces as delivered, on every traced section, which you open sheet by sheet |
| 7 | TV, BV, BV/TV of ROI-1 and ROI-2 (#4–6, #13–15); TV, BV, BV/TV, Tb.N, Tb.Th, Tb.Sp, nodes and ends of ROI-3 (#16–23) | `morphometry.py volumes --output roi-iioc` and `roi-iioc-trabecular`; `trabecular --output roi-metaphyseal` | the QC images `trabecular` writes (`bone-morphometry`) |
| 8 | Ct.Th at the two levels below the distal face (#24, #25), on the cortex mask and face `metaphyseal-roi` wrote (the face is traced once; `metaphysis_roi.py` is not run again); plate thickness per compartment (#11, #12) on the plate runs `iioc.py` wrote, under the articular top surface | `morphometry.py cortical --output roi-cortex-100um`, `roi-cortex-1000um`, `roi-subchondral-plate-medial` or `-lateral` (the slab's declared id; its depth and thickness are in the spec) | its QC image against `examples/README.md` (cortical, subchondral-plate) |
| 9 | Femoral landmarks: four points on a 3D render of the femur (`regions-and-landmarks`, picks named `a` to `d`), then compute | `femoral_frame.py --spec <protocol.json>` on the `points.json` files `pick.py` wrote | each `pick-check.jpg` against `examples/README.md` (femoral-geometry); the script refuses a bad landmark (D) |
| 10 | Volumes of labels 3, 5 and 6 (#1–3) | `measure.py --spec <protocol.json> --outputs /workflow/workflows/mouse-oa/outputs.yaml --output patella-volume lateral-meniscus-osteophyte-volume medial-meniscus-osteophyte-volume --labels labels.npy` | the 3D sheet (`visual-check`) |
| 11 | Hand the points to the lab | `amira_landmarks.py` | the lab opens it in Amira |

`iioc.py --gp-shift-mm` and `tibial_trabecular.py --upper-shift-mm` rerun with a moved trace, to see how much a
boundary matters: a sensitivity check, not an error bar.

## Aligned grid and annotations

`tibia_frame.py` writes `tibia-hu.npy`, `tibia-mask.npy` and `tibia-frame.json` on an **aligned grid**: array
axes (W, V, U), the scan's voxel size, W from the joint toward the shaft. W is the tibia's long axis, fitted on the
shaft: the centroids of the filled shaft sections between `--axis-mm` (default 2.0 to 3.9 mm from the joint end, below the
flare on the lab scans; sampled from the scan, so the range may reach past the crop) lie on a line along W, under 0.1° off in both planes (`axis_residual_deg`). The fit
follows the centroids, so when the dots are pulled off the shaft (by the flare, the fibula, or a label piece), move
`--axis-mm` first; use `--tilt-deg CORONAL SAGITTAL` only for a lean the line misses: positive CORONAL when the shaft's
lower end sits at larger U than its top on the coronal sheet (V on the sagittal one), the degrees you read off; the script
turns W to cancel it, and `axis_residual_deg` then reads about minus the tilt. +U medial and +V anterior come from a sign
rule on scan y and the joint end that assumes one knee and one scan orientation: **confirm it on the QC montage**
before you name a side (a left knee flips it). Every annotation is an index on that grid and carries its `grid_id`;
the scripts refuse a file without one or from another grid, because indices mean nothing on another frame. They
also refuse, before writing anything, a key they don't know, a value of the wrong form, and an index outside the grid. The
femoral landmarks are the exception: `[z, y, x]` on the scan grid.

What the annotations are (their keys, which are required, and the refusals are in each script's `--help`; the curve
schema is `regions-and-landmarks`'):

- **A, for `iioc.py`.** The growth plate's proximal face across the whole width, on at least two coronal sections.
  Before you call `segment_plate`, confirm on `tibia-frame-qc.jpg` that the grid is the tibia (the plateau on top, the fibula beside the
  shaft): the model has no femur guard and proposes the femur's growth plate as readily. If the grid is the femur, fix the tibia pick first.
  `segment_plate` proposes it (and annotation C) with the fine-tuned plate model: dense curves on every tenth section where the model finds
  the plate, and no points where it is flagged (its three checkpoints disagree, too few of them found the plate, or a face is off the tibia
  mask). Run `plate_faces.py`, which writes the same files from a density search, only when `segment_plate` is not in your tools or returns
  an error; faces you judge wrong are retraced, never replaced by the other proposal. The proposal covers only part of the tibia (the V range and each section's U span are in `plate-faces.json`
  and the script's output) and is where you start, not where you stop: you trace the plate over the whole tibia at plate level, on zoomed
  views, past every span end, on the sections with no span, and out to the V ends. `iioc.py` and `metaphysis_roi.py` stop on a face whose
  curves have a gap over the plate wider than the spec's `max_gap_um` (about 24 rows): on a section, two points that far apart where the tibia lies
  within that below the line between them and anywhere above it (a line across empty space between two pieces of bone does not count); across V, two sections that
  far apart over the rows with tibia near the face. They do not test where a face ends, in U or V: the mask does not show where the plate ends
  (the condyles overhang it, the fibula lies beside it), so open the ends on the QC. `iioc.py` does stop where ROI-1's side runs through bone (a patch over the spec's `cut_max_area_mm2` with bone off the tibia mask for `cut_depth_um` beyond it, by V and U range; bone the femur, patella or fibula label holds, `cut_other_bones`, does not count): the tibia label stops inside the bone there, and retracing the face cannot fix that. The fix is the labels (segmentation-check) and a rerun of `tibia_frame.py`, which makes a new aligned grid: `iioc.py` refuses annotations from another `grid_id`, so the curves, eroded marks and width points are traced again on it. Check the tibia label reaches the cortex before you trace (suggested plan, step 2). They name the V rows and U ranges; they also stop on a point more than
  `off_tibia_margin_um` off the tibia mask, and on a face that jumps between neighbouring traced sections by more than `max_jump_um` plus
  their distance apart (the median W change over the bone both cover): trace each section they name from its own image. Say where the proposal covered and where you traced. Copy its two curve keys
  (`growth_plate_curves`, `growth_plate_distal_curves`) into your `annotations.json`; its flagged stretches are in `plate-faces.json`.
  The proposal is a model's, not a trace: it follows the plate well across the middle of the tibia and goes wrong in known ways. On the first
  and last few sections in V, where the plate is partial, it can draw a full-width line through other bone, its largest errors: open those
  sections first. A stray band piece on separate bone can be bridged into the line. `plate-faces.json` lists the model's band pieces
  (`pieces`) and marks `suspect` the ones with faces on them that lie on a small separate part of the tibia mask; the QC sheet names them
  in its title. Open each suspect's section: a band piece on the fibula (thin bone beside the tibia) is a stray, drop it. A fibula the
  section's mask joins to the tibia is never marked suspect: look beside the tibia on every section too. Take strays
  out with `prune_plate.py` (`--help`) before you trace: `--drop-pieces` for a stray that is its own piece, `--cut` for a U range where a
  stray is joined to the plate by a bridge of band (one piece, so dropping it would drop the plate too), or for any stretch of the line
  that is on the wrong bone. It only removes points, from both faces at once, and lists each range it emptied: trace the ones that are
  plate, and report its drops and cuts with the faces. Look also for a long straight stretch or a jump to another bone. Its band can thin to about a voxel and its thickness was never checked against an expert, so check the distal face as hard as the
  proximal one. Untested, so yours to trace: an eroded or bridged plate (expect a plausible band drawn through the erosion; mark
  `plate_eroded` as below), the wrap down the condyles at the ends (it runs straight there), and coverage out to the U and V ends.
  `plate_faces.py`'s proposal, when you use it, goes wrong differently: it jumps up into dark marrow spaces of the epiphysis and draws a
  convincing sheet on the wrong structure where the plate is eroded.
  One instruction covers a flagged stretch, a stretch that is wrong but not flagged, and every extension: you read each point's position
  from a zoomed image by looking, on the plate band, and put the points no farther apart than `max_gap_um` (closer where it turns). Code may
  write down the positions you read; a detector, an interpolation or a fill choosing the positions is not tracing, and a face that passes
  the spacing and mask checks is not thereby on the plate. Correct means the same visible plate band, end to end: it can wrap down the
  condyles at the sides, where the plate turns steeply down the arch, and you follow it there; what is wrong is a
  switch onto cortex or marrow. Where one height per (V, U) cannot represent what you see (in the notch, which can run nearly in
  the section's plane), read the neighbouring sections and a view across them, trace the nearest single-valued face, and raise it as a To
  check item; do not flatten it and do not call it eroded. Look at every proposed section's render, and every `qc-faces-<n>.jpg` sheet (the
  faces as delivered, solid where your points define them, dotted where the surface is held past them, over the tibia's outline, cropped to the faces' height range and 0.8 mm beyond it). Where
  the plate is destroyed, mark the U range where it is gone in
  `plate_eroded` (`{"<V>": [{"u": [first, last], "eroded": "<why>"}]}`, integer U) on every traced section it reaches, flagged or not
  (add a section beside the span if it spills over), and trace the remaining bone there with both faces, the section's curve reaching both ends of the range: the mark
  never replaces the points. Retrace a stretch that is wrong but not flagged the same way. Retracing is required; a To check item naming the stretch is in addition, never instead (`examples/README.md`, iioc:
  eroded plate). The marked ranges and their share of the plate are in `iioc.json`: report them. A growth-plate line or path the researcher drew
  on a coronal section of the tibia grid goes into that section's curve of the face it corrects: the face your brief names, or the
  face output the mark was drawn on (`marks_to_grid.py --curve --voxels "<the delivery's line>" --drawn-on <the image the delivery names> --into annotations.json --key growth_plate_curves` for
  the proximal face, `growth_plate_distal_curves` for the distal; `regions-and-landmarks`). A mark drawn on anything else
  names no face, and a correction can sit nearer the other face than its own: with no face named, or the brief and the mark
  naming different faces, apply nothing and report that, so the researcher is asked. Retrace the sections beside it to meet it. Where part of the tibia label is really femur or fibula
  above the articular surface, a correction traces the true articular surface over that patch, and ROI-1 keeps
  only what lies below. The U index of each plateau compartment's middle (a height point outside ROI-1's footprint
  stops the script: move it). The two width points (#10), within 2 sections of each other and on the growth plate's
  proximal face, on the tibia (`iioc.py` stops on a point more than the spec's `width_point_off_face_um` from the face on
  its section, or more than `off_tibia_margin_um` off the tibia): the centre of the fibula–tibia junction on the tibial
  surface, and the most prominent point on the other side. Optional: where "the
  middle of the growth plate" is for #7 (default: midway between the width points), the coronal section the heights
  are measured on (default: where the footprint's growth-plate-to-top distance is largest), and the plate patches per
  compartment (default: the spec's `plate_patch_width_um` wide around the compartment midpoint).
- **B, for `tibial_trabecular.py`.** The boundary between the subchondral plate and the trabecular compartment,
  with the end points on the inner side of the cortex: the first and last point of each curve limit ROI-2 across.
  The V range it covers.
- **C, for `metaphysis_roi.py`.** The growth plate's distal face, over at least the proximal face's V range. The proposal
  (`segment_plate`, or `plate_faces.py`) gives it with the proximal face (same sections, same flagged stretches): check and retrace it the same way, in step 6. There is no thickness
  fallback: ROI-3 starts a fixed offset below this face (the spec's `start_um`), so a face a few tens of µm off moves ROI-3 (a
  guessed band thickness on OA6-1RK moved ROI-3 BV/TV from 23% to 15%). Where the plate is eroded (OA6-1RK from U~296 on
  section V=231) the two faces meet or cross: trace the remaining bone with both faces, densely, mark the U range where the plate is gone in `plate_eroded` on every traced section it reaches (a neighbouring section the proposal did not flag too),
  and raise a To check item. `metaphysis_roi.py` then accepts faces that meet inside the marked range, cuts ROI-3 `start_um` below the
  remaining bone, and reports the marked ranges and their share (`roi3.json`): say so in your report. OA6-1RK's eroded plate (bone destruction,
  possibly age-related) is not representative of the lab's knees, most of which keep the plate whole. Look at the faces drawn on the sections before you run.
- **D, the landmark points files** (scan grid, each name once across the files, straight from `pick.py`: do not
  copy coordinates into a new file). `a` midpoint of the upper line of the intercondylar groove, `b` intercondylar
  notch, `c` midpoint of the ridge on the lateral condyle, `d` vertex of the medial condyle (deck slide 7). `a` and
  `b` go on a long view of the femur that shows the shaft and the groove side-on; `c` and `d` can go on the
  joint-face view. `femoral_frame.py` refuses a landmark more than 0.05 mm from femur bone, a DFL under 0.4 of DFW
  (`a` and `b` placed end-on), an `a`-`b` that runs side to side or a `c`-`d` that does not
  (against the femur's mediolateral axis, which it finds from the label, checks against the knee's bending plane in the
  `frame` output and prints: the sides and the front swapped, which happens when an image's axes are read as the wrong scan axes) or an SI axis pointing away from the femur: re-place the points; the
  refusal is not a warning to explain. The printed axis says which scan direction runs side to side, not which side is
  lateral or where the front is: read those from a render of this scan. When the refusal says the axis is confirmed,
  a render that seems to disagree has its image axes mislabelled: name the scan axis along each image axis, then
  re-place. Three refusals are not about the points, so do not move them: a femur label too short along its shaft to
  give the axes (the labels or the field of view cut the shaft off); points whose two rulers both fit the knee's bending plane
  but not the label's axis (the refusal says so); and an axis the bending plane does not confirm that a render of this scan,
  its image axes named, contradicts. For each, stop and raise a To check item naming it.

`oa6-1rk-annotations.json` in this directory is the OA6-1RK annotation set (A and B, no C) in that schema, with
the `grid_id` of the frame it was traced on: a worked example of the keys and the point order, and a record of that
scan, not a starting point for another.

## What the deck says, and what replaces the old run

- #10 tibial width: a chord on one coronal section with both ends on the growth plate's proximal face, from the centre
  of the fibula–tibia junction on the tibial surface to the prominent point on the other side. The old run's chord
  joined the two ends of its traced face: do not reuse those points.
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

The only table of the parameters. **Output id** is the id the value is written under (and the id `outputs.yaml`
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
  as `cortex_estimate_mm`, the wall's thickness just below the plate): a wrong depth moves ROI-3. The edge is that
  one depth all round, so where the wall is locally thicker ROI-3 reaches into it (at the tibial tuberosity, for example).
- A medial or lateral value (#8, #9, #11, #12) follows the aligned frame's +U medial, confirmed on the render.
- Tb.Nd and Tb.Tm (#22, #23) are exploratory; Tb.Th, Tb.Sp, Tb.N and Ct.Th (#19–21, #24, #25) carry the
  sphere-method bias with the voxel size.
