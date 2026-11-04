---
name: sam-segmentation
description: >
  Load when a step needs structures segmented in 3D and the `segment_sam` tool is available: what one request can
  and cannot hold, why its masks are clipped and trimmed, and what SAM cannot do.
---

# SAM segmentation

`segment_sam` is SAM 3.1 behind a tool. You prompt each structure on a slice of a stack; the model tracks each
through every slice and writes a uint8 labels `.npy` on the grid of the volume you passed, with a sidecar of its
prompts and per-slice confidence. It runs in your sandbox and sends the scan to Meta's API (a few minutes and
about $0.10 per call; results vary slightly between runs); it reads under `/inputs`, `/outputs` or your `$WORK` folder and writes only in `$WORK` (`/outputs` is read-only). It is a first full 3D
segmentation of every structure you prompt and a second opinion on your own; **you own the final labels** (`segmentation-check`).

## When not to use it

- **A segmentation you can already verify cheaply.** Clean threshold components need no second opinion.
- **A scan that may not leave the lab.** Meta's API retains what it receives. If the study's terms forbid sending
  the scan out, do not call it, and say so.

## Prompts

Per structure, on a slice: a **box** (the whole structure; one per slice), and any number of **points** (pixels
on it; `negative: true` for pixels off it). A prompt needs a box or a positive point. In a volume:

- **A negative point** keeps a neighbour out when a box catches a piece of it: put it on the neighbour inside the box.
- **`otherFrames`**: more prompts for the same structure on other slices (one per slice). When a track drifts or
  jumps to a neighbour on some slices, prompt the structure again on a slice where it is wrong or clear. Tracking
  starts at the earliest prompted slice.
- **`direction`** (`forward` or `backward`, default `both`): tracks one way from the earliest prompted slice. Meta bills the slices tracked
  (at least 50 per call), so when a structure lies on one side of its prompt, or you only need part of the stack,
  this and a `subVolume` cost less.
- **`concept`** instead of `structures`: one noun phrase ("bone"), every instance found and tracked (up to 16 per slice in a volume, any number in an image; the call fails if labels would pass 255, so
  lower `firstLabel`),
  labels numbered in the order the model first shows them. Use it for "every X" when you have no boxes yet, then
  prompt what it missed or merged with boxes. A phrase that matches nothing is not an error: the call returns no
  objects (`counts` empty). On windowed CT slices, "bone", "femur" and "skeleton" matched nothing when we tried them,
  so do not plan a step on a concept finding bone; check what it returned. It cannot be mixed with boxes or points in a call, and it takes no
  `direction`.
- **A 2D `.npy`** is one image (prompts on slice 0, no `axis`): a rendered slice you want segmented alone.

## Planning requests

Open `references/strategies.md` before you plan your requests: how to group structures into requests. Then the
workflow's anatomy reference: which structures to prompt, how they group, and which to leave out.

## What the tool does, so you can plan around it

- **Orient first** (`orient-joint`) and pass the oriented stack with its keyframe. Boxes drawn by eye cut a
  structure's edges off: `snap_boxes.py` fits them to the threshold components, and `render_slices.py --boxes` shows them
  before you send.
- **Survey the threshold first** (`components.py --in <oriented stack>`): with no labels yet, it lists the threshold's
  largest connected components (size, box, centre, whether they touch the edge), in 3D or on one slice with `--index`.
- **A SAM mask spans its structure's surroundings**, several times a small structure's volume: clip it to the
  structure's intensity range (for bone, `clip_to_bone.py`) before any volume means anything, and never refill clipped voxels by nearest label. Read the
  clipped labels' checks (`segmentation-check`) per label: a label in range keeps SAM's result, and one bad label
  does not discard the request.
- **Stamp the output's grid** (`sidecar.py --like oriented.json`): `segment_sam`'s own sidecar has no grid, and
  the next scripts refuse labels they cannot place.
- **Trim each small track** (`trim_tracks.py`): untrimmed, a track keeps going after its structure ends and picks
  up whatever sits at the same spot. Trimming cuts track ends, so a trimmed volume runs under the true one; say so
  when you report it.
- **Map back and merge** (`to_scan.py`, `merge_labels.py`): a voxel both requests claim goes to the nearer
  side's own voxels, and the merge reports each piece's contested voxels by big label and where they went, and what each big
  label lost (`big_lost`); a piece with a large contested count, or a big label that lost much, is a To check item. It
  refuses a small track holding more than a tenth of a big bone: that track followed the bone. Drop it, prompt the
  structure again, and give the bone the big track missed to that bone (`segmentation-check`). Clip once more: that is `labels.npy`.

Do not claim a voxel-exact number from one call: keep the call's counts, prompts and labels as evidence, and when a
measurement must be stable, call twice and report the spread. A third rerun on one problem is a To check item.
