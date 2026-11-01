---
name: sam-segmentation
description: >
  Load when a task needs structures segmented in 3D and the `segment_sam` tool is available: what one request can
  and cannot hold, why its masks are clipped and trimmed, and what SAM cannot do.
---

# SAM segmentation

`segment_sam` is SAM 3.1 behind a tool. You draw a box per structure on one slice of a stack; the model tracks each
through every slice and writes a uint8 labels `.npy` on the grid of the volume you passed, with a sidecar of its
prompts and per-slice confidence. It runs in your sandbox and sends the scan to Meta's API (a few minutes and
about $0.10 per call; results vary slightly between runs); it reads and writes under `/outputs` or `$SCRATCH`. It is a first full 3D
segmentation of every bone and a second opinion on your own; **you own the final labels** (`segmentation-check`).

## When not to use it

- **The growth plate and anything thinner than a bone.** SAM labels whole bones; a plate, a trabecular ROI,
  cartilage or a contact face comes from the protocol's own steps (`regions-and-landmarks`).
- **A segmentation you can already verify cheaply.** Clean threshold components need no second opinion.
- **A scan that may not leave the lab.** Meta's API retains what it receives. If the study's terms forbid sending
  the scan out, do not call it, and say so.

## What the tool does, so you can plan around it

- **Orient first** (`orient-joint`) and pass the oriented stack with its keyframe. Boxes drawn by eye cut bone
  edges off: `snap_boxes.py` fits them to the threshold components, and `render_slices.py --boxes` shows them
  before you send.
- **Survey bare bone first** (`components.py --in <oriented stack>`): with no labels yet, it lists the threshold's
  largest connected components (size, box, centre, whether they touch the edge), in 3D or on one slice with `--index`.
- **One request for every bone a target could track into.** Structures in one request are tracked together and
  never share a voxel; a bone left out is tracked onto by its neighbour. Up to 16 per request, each boxed on a
  slice where it is separate from its neighbours. One request per bone costs three times as much and gives
  overlapping masks.
- **A SAM mask spans soft tissue and marrow**, several times a small bone's volume: clip to bone
  (`clip_to_bone.py`) before any volume means anything, and never refill clipped voxels by nearest label. Read the
  clipped labels' checks (`segmentation-check`) per label: a label in range keeps SAM's result, and one bad label
  does not discard the request.
- **Small structures go in their own request**, one temporary label per 3D piece, after `unlabelled.py` has found
  them on the scan grid and `map_points.py --pieces` has given each a slice and a box. Added to the big-bone
  request they cost the mid-size bone beside them its track. A piece the stack's edge cuts needs a wider
  orientation margin first.
- **Stamp the output's grid** (`sidecar.py --like oriented.json`): `segment_sam`'s own sidecar has no grid, and
  the next scripts refuse labels they cannot place.
- **Trim each small track** (`trim_tracks.py`): untrimmed, a track keeps going after its structure ends and picks
  up whatever sits at the same spot. Trimming cuts track ends, so a trimmed volume runs under the true one; say so
  when you report it.
- **Map back and merge** (`to_scan.py`, `merge_labels.py`): the big bones win overlaps, and the merge reports what
  each piece lost to them; a large loss is a To check item. Clip once more: that is `labels.npy`.

Do not claim a voxel-exact number from one call: keep the call's counts, prompts and labels as evidence, and when a
measurement must be stable, call twice and report the spread. A third rerun on one problem is a To check item.
