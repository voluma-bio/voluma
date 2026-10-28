---
name: sam-segmentation
description: >
  Load when a micro-CT task needs structures segmented in 3D and the `segment_sam` tool is available: box prompts,
  what goes in one request and what does not, small structures and track trimming, clipping, mapping back, and what SAM
  cannot do.
---

# SAM segmentation

`segment_sam` is SAM 3.1 behind a tool. You draw a box per structure on one slice; the model tracks each through every
slice and writes a uint8 labels `.npy` on the grid of the volume you passed, with a sidecar `labels.json` beside it
(`axis`, `shape`, `prompt`, and per object: `label`, `name`, `promptFrame`, `box`, and `confidence` per slice). It
segments whole bones in about a minute for about $0.10 per scan. It is the first full 3D segmentation of every bone and a
second opinion on your own; **you own the final labels** (`segmentation-check`).

The tool runs outside the sandbox (no network there): it reads the volume you name and writes the labels to the path you
give, under `/outputs` or `/scratch`. Everything else here is numpy in the sandbox. Results vary slightly between runs.

## When not to use it

- **The growth plate and anything thinner than a bone.** SAM labels whole bones. The plate, a trabecular ROI,
  cartilage or a contact face stay with the protocol's own steps (`regions-and-landmarks`).
- **A segmentation you can already verify cheaply.** If the threshold components are clean, SAM adds cost, not
  information.
- **A scan that may not leave the lab.** SAM runs on Meta's API (Standard mode: not trained on, still retained). If the
  study's terms forbid sending the scan out, do not call it, and say so.

## Steps

1. **Orient first** (`orient-joint`). Pass the oriented stack, `axis` 0, and the keyframe. Look at `keyframe.jpg` before
   going on.
2. **Name each bone on the keyframe and draw a rough box** as `[row0, col0, row1, col1]`, ends inclusive, in pixels
   of that slice (`visual-check` explains the grid). Use the window the anatomy skill gives. The anatomy skill lists the
   structures, their labels, and which need another slice (`frame`).
3. **Snap the boxes:**
   `python <this skill>/resources/snap_boxes.py --in oriented.npy --index <keyframe> --threshold-hu <T> --boxes r0,c0,r1,c1 ...`.
   Boxes drawn by eye cut 14-20 px off the front of the patella and tibia (patella Dice 0.82-0.86); snapped to the threshold
   components mostly inside each box, +3 px, they land within 3 px of the bone. Draw the snapped boxes on the keyframe and
   look (`render_slices.py --boxes`).
4. **Big bones in one request, with their neighbours.** One call is one multiplexed request: its structures are tracked
   together and never share a voxel. Include a box for every bone a target could track into: without a fibula box the
   tibia tracked into the fibula (819,000 voxels), with it 209,000. Put a neighbour's box on a slice where it is separate,
   via the structure's `frame`. Up to 16 structures per call. Never one request per bone: three times the cost, overlapping
   masks (653,000 voxels claimed by femur and patella), and a small bone beside a large one tracked onto it (Dice 0.02).
   Then give `labels.npy` its grid (`microct-core`, `sidecar.py --like oriented.json`).
5. **Small structures in a second request, trimmed.** Do not add sesamoids, joint mineralizations or fragments to the
   big-bone request: they cost the patella (Dice 0.95 to 0.86), because the patella track loses frames and follows the
   femoral shaft. Send them in their own `segment_sam` call (about $0.10), each with a box snapped on the slice where its
   component is largest and clear of big bones, and **one box per 3D piece** of a structure in several pieces (an unboxed
   piece is never found; Dice 0.45 for a two-piece label with one box). Then trim each track to the frames it occupies:
   `python <this skill>/resources/trim_tracks.py --labels small.npy --out trimmed.npy --targets <label>:<promptFrame> ...`.
   It keeps the unbroken run of slices around each prompt frame where the mask is non-empty and confidence is 0.5 or more
   (read from `small.json`; without it, mask overlap with the neighbouring slice, IoU 0.3). Untrimmed, an object keeps
   tracking after its structure ends and picks up whatever sits at the same spot (201,000 voxels of another label, 49,000 of
   the tibia). With boxes you can place, trimmed tracks reached Dice 0.90-0.98 for 6 of 8 small labels on OA6-1RK (0.80
   and 0.45 for the other two). Merge the two label volumes with the big bones winning overlaps, except that a small label
   must not take patella or femur voxels you have already labelled; if it does, raise it. Trimmed volumes run 10-20%
   under the reference (trimming cuts track ends): report small-structure volumes with that caveat. The rule was set
   after seeing one scan: check it on yours.
6. **Map back and clip.** Map labels to the scan grid (`orient-joint`, `to_scan.py`). SAM masks include soft tissue (a third
   of the patella mask; whole-mask volumes run 15-60% over on small structures). Clip each label to a filled threshold
   envelope before reporting a volume:
   `python <this skill>/resources/clip_to_envelope.py --hu hu.npy --labels labels.npy --out clipped.npy --threshold-hu <T>`.
   It moves bone-voxel Dice by at most 0.002, so it changes what the numbers count, not how well the bones agree. Never
   refill clipped voxels by nearest label: the tibia refills with fibula.
7. **Check and own the labels** with `segmentation-check`. SAM's label is evidence, not an answer: SAM agreeing with a
   watershed (Dice 0.95-0.98 on the big bones) is agreement, not accuracy. Where the two differ at the joint, the
   watershed looked right in every panel inspected.

## Results vary between runs

The API documents slight run-to-run variation in mask edges and sometimes in which objects are found. Repeat requests on
one stack agreed at Dice 0.994-0.998 on OA6-1RK. Do not claim a voxel-exact number from one call: keep the call's `counts`,
`prompt` and the labels file as evidence, and if a measurement must be stable, call twice and report the spread. A rerun
costs the same as the first call: plan reruns, do not loop on a prompt. A third rerun on one problem is a To check item.

Everything above is the recipe as of 2026-10-28 and was measured on one scan (OA6-1RK) plus two public femurs: the shape
is stable, the numbers may move.
