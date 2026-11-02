# Suggested plan for a mouse knee

The order a lab would work in, as eight steps. Write the run's own plan from it and from the scan: drop a step whose
anatomy is not in the field, split or merge steps across workers, and change the plan when the scan calls for it.
Each step names the outputs it reads and reports by id; an output's latest files are listed in `/run/outputs.yaml`.
A step's heading ends with its section in `examples/README.md`, what correct looks like for what it places.

Each step is written in four parts. Pass all four on in a brief: the worker needs the check-first lines as much as
the method.

- **Needs:** the outputs it reads.
- **Check first:** what must hold in those inputs in this step's region, looked at before any work. An input can be
  right elsewhere and wrong exactly where this step measures.
- **Makes:** the outputs it reports, with the protocol steps (`oa-protocol.md`, "Steps, in order") that make them.
- **Leaves:** what later steps read from it, and what a new version of an input would put out of date.

A protocol script writes a cropped object for the viewer and, beside it, the full-grid files the next script runs on
(ROI-1's `iioc-tissue.npy`, the cortex's `cortex.npy`, the plate runs, where the face was traced). No other worker can
open your folder, so report every file the script's result record names with the output it belongs to, the output's
own file first. A later step takes the output's files from `/run/outputs.yaml`.

When a check-first fails, ask whether the fault could make any other output wrong. If it could, the worker tells
main what it saw and where, and main decides whether the input gets a new version: patella voxels in the tibia label
also make the patella volume wrong, even though the femur is fine. If the input is right and this step needs it finer
(the growth plate traced more closely than segmentation drew it), the worker refines it for its own region and
reports that as part of its basis.

## Before you plan

Once intake reports, read `scan-notes`: what the researcher's files say the field holds and lacks, which knee,
which side. A structure the notes or intake's pieces put outside the field takes its outputs with it: mark them
missing with the reason. A fact of this scan that a later look would otherwise get wrong (a left knee, a cut-off
patella) goes on the affected outputs as an expect line.

Look at the labels in 3D before the steps that measure on them start, and at the landmarks before the lengths:
a wrong label or frame makes every step after it out of date.

The tibial steps (3 to 7) share a frame, a traced growth plate and a feel for this tibia; one worker that owns them
keeps what it learns. The femur (step 8) is independent of the tibia after segmentation and can run beside it.

## 1. Intake (`intake`)

- **Needs:** `/inputs`.
- **Check first:** the spacing the researcher stated against the header (a mismatch is a To check item).
- **Makes:** `header`, `scan` (cleaned: holder, padding and debris set to air, with the removal mask), `frame` (the
  rough orientation and its keyframe), `scan-notes` and `bone-pieces` (`scan-intake`, `orient-joint`).
- **Leaves:** every step reads `scan`. Segmentation starts from `bone-pieces`. A new `scan` puts everything out
  of date.

## 2. Segmentation (`segmentation`)

- **Needs:** `scan`, `frame`, `bone-pieces`.
- **Check first:** the keyframe cuts femur and tibia through the joint, with the joint space dark between them; every
  piece intake named is one you can find.
- **Makes:** `bone-labels` (with the structures in it), `bone-threshold`, `disagreement`, and the label volumes #1–3
  (protocol step 10). `small-structures`, the account of labels 5 to 12 (`anatomy.md`): each labelled, absent with the reason and the
  view it rests on, or unresolved with a To check item (`sam-segmentation`, `segmentation-check`, `anatomy.md`
  "Segmentation notes").
- **Leaves:** steps 3 to 8 read the tibia or the femur from `bone-labels`. A new version of it puts all of them out
  of date, so settle the labels here, on the 3D sheet, before anyone measures.

## 3. Tibial frame and IIOC, ROI-1 (`iioc`)

- **Needs:** `scan`, the tibia in `bone-labels`.
- **Check first:** from the articular surface to about 1 mm below the growth plate, the tibia label holds no femur,
  patella, meniscus or fibula voxels, and its top runs through the joint space, not through femur. Which side is
  medial: the fibula is lateral. On a view of the aligned grid that shows the fibula beside the tibia (an axial
  slice just below the plateau), find which way along U is medial on this knee, and record it before you name a
  compartment. `tibia_frame.py`'s sign rule assumes one knee and one scan orientation and has no flip, so where +U
  is lateral, keep the frame and name the medial and lateral fields of the annotations from what you saw.
- **Makes:** `tibia-grid` (the aligned frame; protocol step 1), `growth-plate-proximal-face` (step 2: `plate_faces.py`
  proposes both faces where it finds the plate; you trace the plate over the whole tibia from there and open every
  `qc-faces` sheet),
  `articular-surface`, `roi-iioc`, the four rulers and #4–10 (steps 3 and 7). Report both height definitions with
  the plane residual (protocol, "What the deck says").
- **Leaves:** steps 4 to 7 work on `tibia-grid` and read `roi-iioc` and the faces. A new `tibia-grid` or proximal
  face puts steps 4 to 7 out of date.

## 4. Subchondral bone plate (`subchondral-plate`)

- **Needs:** `tibia-grid`, `roi-iioc` (its plate runs), `articular-surface`.
- **Check first:** each compartment's patch sits on the side step 3 recorded as medial or lateral, under the
  articular top surface.
- **Makes:** `roi-subchondral-plate-medial` and `-lateral`, #11–12 (protocol step 8).
- **Leaves:** step 5 removes the plate from ROI-1.

## 5. IIOC trabecular bone, ROI-2 (`trabecular-roi`)

- **Needs:** `tibia-grid`, `roi-iioc` (its `iioc-tissue.npy`), `growth-plate-proximal-face`, the plate from step 4.
- **Check first:** the plate is visible as a band under the articular surface across ROI-1's whole front-to-back
  extent; where it is not, say how you placed the boundary there.
- **Makes:** `under-plate-boundary` (annotation B), `roi-iioc-trabecular`, #13–15 (protocol steps 4, 5, 7).
  ROI-2 covers the trabecular core over ROI-1's whole front-to-back extent, not only the sections you traced.

## 6. Proximal tibial metaphysis, ROI-3 (`metaphyseal-roi`)

- **Needs:** `tibia-grid`, `growth-plate-proximal-face` (with where it was traced), the tibia below the growth plate.
- **Check first:** below the growth plate, where ROI-3 and the cortex go, the tibia label holds no fibula voxels:
  the fibula joins the tibia toward the shaft, and a cortex mask that reaches it is wrong.
- **Makes:** `growth-plate-distal-face` (annotation C, over at least the proximal face's range: trace the distal face
  over the whole tibia from `plate_faces.py`'s proposal and open every `qc-faces` sheet), `cortex`, `roi-metaphyseal`, #16–23 (protocol steps 6, 7).
  Where the plate is eroded, report the eroded ranges and `plate-eroded-fraction` from `roi3.json` with the face, and
  raise a To check item naming them.
- **Leaves:** step 7 measures on this `cortex` and distal face and never traces the face again. A new distal face
  puts step 7 out of date.

## 7. Tibial cortical thickness (`cortical`)

- **Needs:** `cortex` (its `cortex.npy`), `growth-plate-distal-face`, `tibia-grid`.
- **Check first:** at both levels the cortex mask is the wall only, all round, with no marrow, trabeculae or fibula.
- **Makes:** `roi-cortex-100um`, `roi-cortex-1000um`, #24–25 (protocol step 8).

## 8. Distal femur (`femoral-geometry`)

- **Needs:** `scan`, the femur in `bone-labels`.
- **Check first:** at the condyles and the intercondylar groove the femur label holds no patella, sesamoid or tibia
  voxels and covers the condyles' surface; orient the femur for its own views (`orient-joint`).
- **Makes:** points `a` to `d`, `dfl-ruler`, `dfw-ruler`, #26–28 (protocol step 9), and the Amira landmarks file
  (step 11).
