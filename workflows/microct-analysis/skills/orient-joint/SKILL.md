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

How it chooses: a threshold; the bones are the largest 3D piece plus the second largest if it is at least a quarter of
its size (femur and tibia touching, or two pieces across a healthy joint space: both work); each end of the bones
seeds a shaft axis, refit on its shaft only (35-95% of its length from the joint); the plane spanned by the two axes
is the bending plane; slices stack along its normal; the keyframe is the slice through the joint. "Bone A" is the shaft
passing nearer the reference object (at the knee, the femur: the patella sits on it); without a reference object near
the joint (no patella in the field) the longer shaft is bone A and the side of the slice it falls on is arbitrary. Voxels must be isotropic. The
three lengths (`--shaft-radius-mm`, `--ref-radius-mm`, `--min-object-mm3`) default to a mouse knee; rescale them for
another animal or joint. Without `--threshold-hu` it uses Otsu on the volume; the workflow's anatomy reference gives the
segmentation threshold to use.

## Look before you go on

Open `keyframe.jpg` (`visual-check`). It must cut **both long bones and the reference object through the joint**: for a
knee, femur, tibia and patella. If a bone is missing, cut off, or the joint space is not in the slice, do not run SAM:
check `bend_deg` (about 64 degrees on OA6-1RK, about 25 on the nearly extended healthy knee of Zanjani-Pour 2020), `skew_vox` (axes far apart out of plane: one slice cannot cut both
shafts), and try another `--threshold-hu`. Where it fails: a joint inside either 30% end portion, a nearly straight joint
(under 10 degrees, it falls back to the plane through bone A and the reference object, or stops with a sentence when
there is none), a bone under a quarter of the largest piece (a short tibia stub: it counts as a reference object, and a
`bend_deg` near zero shows that only one bone was found), a non-bone piece near the joint taken for the reference object
(on Zanjani-Pour 2020 a small sesamoid took that role; the keyframe still cuts both bones).

A wrong frame makes everything after it stale: orientation is its own task, and a corrected frame reruns the rest.

## Mapping back

Anything made on the oriented stack (SAM labels, a trimmed labels volume) goes back to the scan grid before you
measure or report. The oriented SAM output is `labels_oriented.npy`; the scan-grid result is `labels.npy` (or a
named intermediate), which is the only grid a number is measured on:

```
python <this skill>/resources/to_scan.py --in labels_oriented.npy --frame frame.json --header hu.json --out labels.npy
```

Nearest neighbour, so ids survive. It refuses a frame made on another scan (`parent_grid_id` against `hu.json`). A round trip
through the stack costs about 1% Dice on OA6-1RK (0.990-0.995 per bone). Cuts in the oriented frame can also be taken
straight from the scan-grid volume: `render_overlay.py --frame frame.json`.

## Points and pieces between the grids

A candidate found on the scan grid (`unlabelled.py`) needs a box on the stack before SAM can be asked about it:

```
python <this skill>/resources/map_points.py --frame frame.json --pieces qc/cand.npy --ids 3 5 --out qc/boxes.json
python <this skill>/resources/map_points.py --frame frame.json --to-oriented z,y,x [z,y,x ...]
python <this skill>/resources/map_points.py --frame frame.json --to-scan s,r,c [s,r,c ...]
```

`--pieces` gives each candidate piece a `promptFrame` (the slice that cuts most of it) and a `box` on that slice, ready for
`snap_boxes.py` (`sam-segmentation`, step 7). The two point forms print the mapped coordinates (fractional). On OA6-1RK the boxes it gave
for three candidates were within 1-2 px of the extent of the reference labels on the same slice.
