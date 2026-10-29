---
name: orient-joint
description: >
  Load before SAM segmentation of a joint between two long bones, or whenever slices must show both bones through the
  joint: a coarse frame from a bone threshold alone (shaft axes, the plane they span, a keyframe through the joint),
  the oriented stack, and mapping labels back to the scan grid.
---

# Orient a joint

SAM tracks through a stack of slices, so each slice must show the bones you want, with a keyframe through the joint.
The scanner's axes often do not do that, and tracking along the wrong axis loses a bone at the growth plate. So orient
first, from a threshold, before any segmentation exists.

```
python <this skill>/resources/orient_joint.py --in hu.npy --header hu.json --out /outputs/orient \
    --threshold-hu <bone threshold> --shaft-radius-mm R --ref-radius-mm R --min-object-mm3 V [--window lo,hi]
```

The threshold, the three sizes and the display window come from the workflow's anatomy reference. The sizes have no default
because they scale with the animal: the widest a shaft gets (`--shaft-radius-mm`), how near the joint the reference object
sits (`--ref-radius-mm`), and the smallest piece worth considering (`--min-object-mm3`). Without `--threshold-hu` it uses Otsu
on the volume.

It writes `frame.json` (the frame: `R_zyx`, `origin_zyx`, `shape`, `parent_grid_id`, `grid_id`, the one schema every frame uses,
described in `microct-core/resources/frame.py`, plus this fit's diagnostics and `keyframe`), `oriented.npy` (float32 HU stack,
axis 0 = slices, its own `grid_id`) and `keyframe.jpg`, and prints the keyframe index, the bend angle between the shafts and
`skew_vox`.

How it chooses: a threshold; the bones are the largest 3D piece plus the largest other piece near it that is at least
`--second-bone-frac` (default a quarter) of its size (two long bones touching, or two pieces across a healthy joint space:
both work); the largest smaller piece near the joint is the reference object. Each end of the bones seeds a shaft axis, refit
on its shaft only (35-95% of its length from the joint); the plane spanned by the two axes is the bending plane; slices stack
along its normal; the keyframe is the slice through the joint. "Bone A" is the shaft passing nearer the reference object.
Voxels must be isotropic.

**Fields that hold only the ends of the bones.** A shaft needs a field long enough: each shaft must reach 3 shaft radii from the
joint, and the bones together must be elongated (spread along the main axis at least twice the spread across). A field holding
the bone ends and a short stub of each shaft has no shaft at all. Then:

- Two separate bone pieces: the leg axis is the line through their two centroids, the joint is half way across the gap,
  `shafts_found` is false and `bend_deg` and `skew_vox` are `null`. The bend is not measured; do not report one. The
  plane holds that axis and the reference object (or, with none, the widest spread of the bones), and bone A is the bigger
  bone. The plane rule ignores which bone the reference object sits on here; it sets only the plane and the side of the slice.
- One piece, or a second piece under `--second-bone-frac` of the largest: it stops with "No shaft in the field", naming
  which test failed. When it says a smaller piece is near and the second bone is a short stub, lower `--second-bone-frac`
  (0.15 oriented a 19% stub) and check that the keyframe holds the second bone, not the reference object. Otherwise scan more
  of the leg.

## Look before you go on

Open `keyframe.jpg` (`visual-check`). It must cut **both long bones through the joint** (and the reference object when
there is one). Read `/outputs/intake/scan-notes.md` first (`scan-intake`): when it says the structure the reference object
stands for is outside the field, the piece taken for the reference object is something else (`segmentation-check`,
section 2). The script already stops when one bone has under 5% of the other's voxels in the keyframe (`keyframe_bone_vox` in
its output); that does not prove the right pieces are the bones, so look.
If a bone is missing, cut off, or the joint space is not in the slice, do not run SAM: check `bend_deg` (`null` when there is
no shaft), `skew_vox` (axes far apart out of plane: one slice cannot cut both shafts), and try another `--threshold-hu`.
A small piece taken for the reference object is harmless to the cut, but it sets the side of the slice and, when shafts are
found, which bone is A.
Where it fails: a joint inside either 30% end portion, a non-bone piece taken for the second bone (a fragment at least a
quarter of the largest piece) or for the reference object, and the cases above that stop.

A wrong frame makes everything after it stale: orientation is its own task, and a corrected frame reruns the rest.

## Mapping back

Anything made on the oriented stack (SAM labels, a trimmed labels volume) goes back to the scan grid before you
measure or report (`microct-core` names the files):

```
python <this skill>/resources/to_scan.py --in labels_big_oriented.npy --frame frame.json --header hu.json --out labels_big.npy
```

Nearest neighbour, so ids survive. It refuses a frame made on another scan (`parent_grid_id` against `hu.json`). Cuts in the
oriented frame can also be taken straight from the scan-grid volume: `quad_view.py --plane 0:frame=frame.json:axis=0`
(`visual-check`).

## Points and pieces between the grids

A candidate found on the scan grid (`unlabelled.py`) needs a box on the stack before SAM can be asked about it:

```
python <this skill>/resources/map_points.py --frame frame.json --pieces qc/cand.npy --ids 3 5 --out qc/boxes.json
python <this skill>/resources/map_points.py --frame frame.json --to-oriented z,y,x [z,y,x ...]
python <this skill>/resources/map_points.py --frame frame.json --to-scan s,r,c [s,r,c ...]
python <this skill>/resources/map_points.py --frame frame.json --points-file points.json --out mapped.json   # a points file to the frame's other grid
```

`--pieces` gives each candidate piece a `promptFrame` (the slice that cuts most of it) and a `box` on that slice, ready for
`snap_boxes.py` (`sam-segmentation`, step 7). The two point forms print the mapped coordinates (fractional).
