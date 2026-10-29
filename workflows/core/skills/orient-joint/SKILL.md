---
name: orient-joint
description: >
  Load before SAM segmentation of a joint between two long bones, or whenever slices must show both bones through the
  joint: a coarse frame from a bone threshold alone, the oriented stack, and moving labels and points between grids.
---

# Orient a joint

SAM tracks through a stack of slices, so each slice must show the bones you want, with a keyframe through the joint.
The scanner's axes rarely do that, and tracking along the wrong axis loses a bone at the growth plate. So orient
first, from a threshold, before any segmentation exists: `orient_joint.py` (`--help`).

How it chooses: at the threshold, the bones are the largest 3D piece and the largest other piece near it, and the
largest smaller piece near the joint is the reference object. Each shaft seeds an axis; the plane the two axes span
is the bending plane; slices stack along its normal, and the keyframe is the slice through the joint. "Bone A" is
the shaft nearer the reference object. The threshold, the three sizes (how wide a shaft gets, how near the joint
the reference object sits, the smallest piece worth considering) and the display window come from the workflow's
anatomy reference; the sizes have no defaults because they scale with the animal.

A field that holds only the ends of the bones has no shaft. The script then takes the leg axis through the two
pieces' centroids and reports no bend, or stops with "No shaft in the field" naming the test that failed. When it
says a smaller piece is near and the second bone is a short stub, lower `--second-bone-frac` and check that the
keyframe holds the second bone, not the reference object.

## Look before you go on

Open `keyframe.jpg` (`visual-check`). It must cut **both long bones through the joint**, and the reference object
when there is one. Read `/outputs/intake/scan-notes.md` first: when it says the structure the reference object
stands for is outside the field, the piece taken for it is something else, harmless to the cut but setting the side
of the slice and which bone is A. If a bone is missing, cut off, or the joint space is not in the slice, do not run
SAM: read `bend_deg` and `skew_vox` in the output, and try another `--threshold-hu`.

A wrong frame makes everything after it stale: orientation is its own task, and a corrected frame reruns the rest.

## Between the grids

Anything made on the oriented stack goes back to the scan grid before you measure or report it: `to_scan.py`
(nearest neighbour, so label ids survive; it refuses a frame made on another scan). `map_points.py` moves points,
points files and candidate pieces the other way, and gives each piece the slice and box SAM needs. A slice in the
oriented frame can also be cut straight from the scan-grid volume: `quad_view.py --plane K:frame=frame.json`.
