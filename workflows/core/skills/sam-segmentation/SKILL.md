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

All commands are in `<this skill>/resources/` unless named otherwise. `<T>` is the segmentation threshold, not the
measurement threshold (`microct-core`, two thresholds).

1. **Orient first** (`orient-joint`). Pass the oriented stack, `axis` 0, and the keyframe. Look at `keyframe.jpg` before
   going on.
2. **Read `/outputs/intake/scan-notes.md`, then name each bone on the keyframe and draw a rough box** as `[row0, col0, row1, col1]`, ends inclusive, in pixels
   of that slice (`visual-check` explains the grid). The anatomy reference gives the structures, their labels, the display
   window, and which bones need another slice (`frame`).
3. **Snap the boxes:** `python snap_boxes.py --in oriented.npy --index <keyframe> --threshold-hu <T> --boxes r0,c0,r1,c1 ...`.
   Boxes drawn by eye cut off bone edges; snapped to the threshold components mostly inside each box (plus `--pad-mm`), they land
   within a few pixels. Draw the snapped boxes on the keyframe and look (`render_slices.py --boxes`).
4. **Big bones in one request, with their neighbours.** One call is one multiplexed request: its structures are tracked
   together and never share a voxel. Include a box for every bone a target could track into (the anatomy reference names
   them), each on a slice where it is separate from its neighbour, via the structure's `frame`. Up to 16 structures per
   call. Never one request per bone: three times the cost, overlapping masks, and a small bone beside a large one tracked
   onto it. Write the output to `labels_big_oriented.npy`.
5. **Map back, clip to bone, and check every label before going on.**
   `python <orient-joint>/resources/to_scan.py --in labels_big_oriented.npy --frame frame.json --header hu.json --out labels_big.npy`, then
   `python clip_to_bone.py --hu hu.npy --labels labels_big.npy --out labels_big_clipped.npy --threshold-hu <T>`, then
   `python <segmentation-check>/resources/label_stats.py --labels labels_big_clipped.npy --out qc/stats_big.json --ranges <anatomy.json>`.
   Clipping is not optional: a SAM mask spans soft tissue and marrow, several times the bone's volume for a small bone, and
   the anatomy ranges are bone volumes. Never refill clipped voxels by nearest label: a bone refills with its neighbour.
   Read the flags of the clipped labels as a per-label verdict, not as a verdict on SAM; `stats_big.json` gives each piece's
   size (`piece_mm3`) and a voxel inside it (`piece_voxel_zyx`), and `neighbour_voxels` the labels the label touches. Per label:
   - **In its range, one piece:** done. A big bone in range keeps SAM's label.
   - **In its range, extra pieces:** each extra piece is bone that is not this structure. Look at it on the 3D sheet. Clear it
     (`relabel.py --at <its voxel> --to 0`, so step 6's `unlabelled.py` finds it) or give it its own label (`--to N`) if it is a
     structure you can name.
   - **Above its range:** it has taken bone from a neighbour. A piece that is wholly the neighbour's: `relabel.py --to <neighbour>`
    . A piece that is partly both, joined at a contact: `classic_segment.py --within <label>
     --seeds seeds.json` with **one seed per connected piece of each part**, at the contact piece as well as the far one: a
     piece with only one part's seed is given to that part whole. Do not discard the whole request because one or
     two labels are off: the ones in range keep SAM's labels.
   - **Below its range:** it lost bone to a neighbour that is above: fix the pair together.
   - **Far below its range (`identity_unsupported`):** the box found a different piece, or a sliver of the structure. Do not
     keep the name: `segmentation-check`, section 2.
   - **Not near any neighbour the anatomy requires:** the label is on the wrong bone. Do not accept it for being in range: re-box or re-seed it on the right bone.
   Then run `label_stats.py` again, and repeat until every label is in range with one piece, or what is left is something you can
   explain (a To check item). A small structure's label is absent here by design: step 7.
6. **Find the small structures on the scan grid.** Run `unlabelled.py` on `labels_big_clipped.npy` and look at each candidate
   (`segmentation-check`, section 2). Keep the ones you can name from the anatomy reference or want to ask about.
7. **Small structures in their own request, one temporary label per 3D piece.** Do not add them to the big-bone request: they
   cost the neighbouring mid-size bone, whose track loses frames and follows a shaft.
   - **Boxes on the stack:** a candidate lives on the scan grid and the request on the oriented stack.
     `python <orient-joint>/resources/map_points.py --frame frame.json --pieces qc/cand.npy --ids 3 5 --out qc/boxes.json`
     gives each candidate's `promptFrame` (the slice that cuts most of it) and `box`. Snap each box on its own slice
     (`snap_boxes.py --index <promptFrame>`) and look at it (`render_slices.py --boxes`). A candidate is one 3D piece; a
     structure in several pieces needs one box per piece, and an unboxed piece is never found. A piece the stack's edge cuts
     is listed under `cut_by_stack` (`voxels_outside_stack` > 0): its track would be truncated, so re-orient with a larger
     `--margin-mm` (`orient-joint`) and map again before you prompt it.
   - **Labels:** `segment_sam` rejects duplicate labels, so each piece gets a **temporary label** that no label of the
     structures you keep uses, for example 61 and 62 for the two pieces of one structure. Write down which temporary label is
     which final label.
   - Send it, writing `small_oriented.npy`, and **stamp its grid right away**:
     `python <microct-core>/resources/sidecar.py --array small_oriented.npy --like oriented.json` (it keeps SAM's keys in
     `small_oriented.json` and adds the grid). `segment_sam`'s own sidecar has none, and `trim_tracks.py` refuses labels
     stamped with any other grid, so labels from a different orientation of the same scan cannot be mapped back by mistake.
8. **Trim each track to the frames it occupies.**
   `python trim_tracks.py --labels small_oriented.npy --out small_trimmed_oriented.npy --like oriented.json`
   (`--only 61 62` limits it). It keeps the unbroken run of slices around each prompt frame where the mask is non-empty and
   confidence is 0.5 or more (read from `small_oriented.json`), and checks the stamped grid before it writes anything. Untrimmed, an
   object keeps tracking after its structure ends and picks up whatever sits at the same spot (a neighbouring bone, unlabelled bone).
   Trimmed volumes run under the true volume (trimming cuts track ends): report small-structure volumes with that
   caveat, and check the rule on your scan.
9. **Map the small request back and merge.**
   `to_scan.py --in small_trimmed_oriented.npy --frame frame.json --header hu.json --out small_trimmed.npy`, then
   `python merge_labels.py --big labels_big_clipped.npy --small small_trimmed.npy --map 61:6 62:6 5:5 --out labels_merged.npy`
   (pieces go back to their label; several temporary labels may map to one). **The big bones win overlaps. This rule is
   untested**, so the merge reports how many voxels each piece lost to a big bone: a large loss is a To check item.
   Clip again: `clip_to_bone.py --labels labels_merged.npy --out labels.npy`. That is the final `labels.npy`.
10. **Check and own the labels** with `segmentation-check`. SAM's label is evidence, not an answer: SAM agreeing with a
   watershed is agreement, not accuracy.

## Results vary between runs

The API documents slight run-to-run variation in mask edges and sometimes in which objects are found. Do not claim a
voxel-exact number from one call: keep the call's `counts`, `prompt` and the labels file as evidence, and if a measurement must
be stable, call twice and report the spread. A rerun costs the same as the first call: plan reruns, do not loop on a prompt.
A third rerun on one problem is a To check item.
