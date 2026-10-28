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

How it chooses: a threshold; the bones are the largest 3D piece plus the largest other piece lying beyond one end of it
(femur and tibia touching, or two pieces across a healthy joint space: both work); a piece beside the largest one (the
patella) is the reference object. Each end of the bones seeds a shaft axis, refit on its shaft only (35-95% of its
length from the joint); the plane spanned by the two axes is the bending plane; slices stack along its normal; the
keyframe is the slice through the joint. "Bone A" is the shaft passing nearer the reference object (at the knee, the
femur: the patella sits on it). Voxels must be isotropic. The lengths (`--shaft-radius-mm`, `--ref-radius-mm`,
`--min-object-mm3`) default to a mouse knee; rescale them for another animal or joint. Without `--threshold-hu` it uses
Otsu on the volume; the workflow's anatomy reference gives the segmentation threshold to use.

**Fields that hold only the ends of the bones.** A shaft needs a field long enough: each shaft must reach 3 shaft
radii from the joint, and the bones together must be elongated (spread along the main axis at least twice the spread
across). On OA6-1RK the pair measures 2.38 and the femur shaft reaches 3.6 radii; cropped to z 120:877 the femur shaft
is 1.0 radii and the bend reads 45 degrees instead of 64, cropped to z 80:877 (2.9 radii) 75 degrees. A healthy knee
imaged as the ends only (Zanjani-Pour 2020, the largest piece measures 1.24) has no shaft at all. Then:

- Two separate bone pieces: the leg axis is the line through their two centroids, the joint is half way across the gap,
  `shafts_found` is false and `bend_deg` and `skew_vox` are `null`. The bend is not measured; do not report one. The
  plane holds that axis and the reference object (or, with none, the widest spread of the bones), and bone A is the bigger
  bone. With no shaft the second piece must be at least a quarter of the largest (`--second-bone-frac`; the Zanjani-Pour
  tibia is 50%, the OA6-1RK patella 8%): a shorter tibia stub stops the script, and lowering `--second-bone-frac` to
  0.15 oriented the 19% stub of Zanjani-Pour (`hu[110:]`) with the tibia in the keyframe. Lower it only after you have
  looked at the keyframe.
- One piece: it stops with "No shaft in the field". Scan more of the leg, or lower `--threshold-hu` if a second bone is
  lost below the threshold. Cropped OA6-1RK (z 180:400, 200:380, :500, 300:) stops here.

## Look before you go on

Open `keyframe.jpg` (`visual-check`). It must cut **both long bones through the joint** (and the reference object when
there is one): for a knee, femur, tibia and patella. The script already stops when one bone has under 5% of the other's
voxels in the keyframe (`keyframe_bone_vox` in its output); that does not prove the right pieces are the bones, so look.
If a bone is missing, cut off, or the joint space is not in the slice, do not run SAM: check `bend_deg` (64 degrees on
OA6-1RK; `null` when there is no shaft), `skew_vox` (axes far apart out of plane: one slice cannot cut both shafts),
and try another `--threshold-hu`. A small piece taken for the reference object is harmless to the cut (on Zanjani-Pour
2020 a 311k-voxel piece took that role; the keyframe still cuts both bones) but it names bone A and the side of the slice.
Where it fails: a joint inside either 30% end portion, a non-bone piece taken for the second bone or the reference
object when no shaft is in the field, and the cases above that stop.

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
