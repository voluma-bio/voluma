---
name: orient-joint
description: >
  Load before SAM segmentation of a joint between two long bones, or whenever slices must show both bones through the
  joint: a coarse frame from a bone threshold alone (shaft axes, the plane they span, a keyframe through the joint),
  the oriented stack, and mapping labels back to the scan grid.
---

# Orient a joint

SAM tracks through a stack of slices, so each slice must show the bones you want, with a keyframe through the joint.
The scanner's axes often do not do that: tracking along the wrong axis lost a bone at the growth plate (epiphysis
covered 5% and 34% on two public scans, against 97-99% oriented). So orient first, from a threshold, before any
segmentation exists.

```
python <this skill>/resources/orient_joint.py --in hu.npy --header hu.json --out /outputs/orient \
    --threshold-hu <bone threshold> [--window lo,hi]
```

It writes `frame.json` (the frame), `oriented.npy` (float32 HU stack, axis 0 = slices, its own `grid_id`) and
`keyframe.jpg`, and prints the keyframe index, the bend angle between the shafts and `skew_vox`.

How it chooses: a threshold; the two bones are one 3D piece because they touch at the joint; each end of that piece
seeds a shaft axis, refit on its shaft only (35-95% of its length from the joint); the plane spanned by the two axes
is the bending plane; slices stack along its normal; the keyframe is the slice through the joint. "Bone A" is the shaft
passing nearer the reference object (at the knee, the femur: the patella sits on it). Voxels must be isotropic. The
three lengths (`--shaft-radius-mm`, `--ref-radius-mm`, `--min-object-mm3`) default to a mouse knee; rescale them for
another animal or joint. Without `--threshold-hu` it uses Otsu on the volume; the workflow's anatomy skill gives the
threshold to use.

## Look before you go on

Open `keyframe.jpg` (`visual-check`). It must cut **both long bones and the reference object through the joint**: for a
knee, femur, tibia and patella. If a bone is missing, cut off, or the joint space is not in the slice, do not run SAM:
check `bend_deg` (about 64 degrees on OA6-1RK), `skew_vox` (axes far apart out of plane: one slice cannot cut both
shafts), and try another `--threshold-hu`. Where it fails: a joint inside either 30% end portion, a nearly straight joint
(under 10 degrees, it falls back to the plane through bone A and the reference object), a large non-bone object near the
joint taken for the reference object (it then stops with a sentence).

A wrong frame makes everything after it stale: orientation is its own task, and a corrected frame reruns the rest.

## Mapping back

Anything made on the oriented stack (SAM labels, a trimmed labels volume) goes back to the scan grid before you
measure or report:

```
python <this skill>/resources/to_scan.py --in labels_oriented.npy --frame frame.json --header hu.json --out labels.npy
```

Nearest neighbour, so ids survive. A round trip through the stack costs about 1% Dice on OA6-1RK (0.990-0.995 per bone).
Cuts in the oriented frame can also be taken straight from the scan-grid volume: `render_overlay.py --frame frame.json`.
