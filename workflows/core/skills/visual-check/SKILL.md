---
name: visual-check
description: >
  Load before you judge a segmentation, a frame, a box, a region or a landmark: which view answers which question,
  and what your eyes are and are not reliable for on micro-CT.
---

# Visual check

Render a view, open it with `view_image`, and decide from what you see. Every label you keep,
every frame you accept and every region or point you hand on passes one look first, and the image goes in your
evidence, so the checker and the researcher see what you saw.

## Which view answers which question

| Question | View | Script |
|---|---|---|
| Which bone is which? Does this slice cut the joint? | one slice with a pixel grid | `render_slices.py` |
| Is a box or a pick where I meant it? | the same slice with it drawn on | `render_slices.py --boxes/--points` |
| Is each label on the right bone? Is a mask, a face or a point where I meant, seen from every side? | quad view: 3D plus three slices through one crosshair you move, step, rotate and reslice; each call starts from the last view | `quad_view.py` |
| Does one label cover two bones? Are there loose fragments? | 3D sheet: six views around the long axis, one colour per label | `render_surfaces.py` |
| What is this small thing, and which label is it under? | crop sheet: three orthogonal cuts through the piece | `render_crops.py` |
| Which of two segmentations is right here? | disagreement panel | `disagree.py` (`segmentation-check`) |

Pass the workflow's `anatomy.json` as `--names` so the legend names every label, and its display window as
`--window`. Open up to four images in one `view_image` call; your history is summarized now and then, and an image
that was summarized away shows only as its text line: call `view_image` again to see it. To compare before and
after a fix, open both in one call.

## What your eyes are good for

- **The 3D sheet is your best check** for a label covering a neighbouring bone and for a fragment merged into a big
  bone. Look at it after every change to the labels.
- **2D overlays catch gross errors and can miss small ones.** When an overlay shows something small, confirm it in
  code (`label_stats.py`, or the label value at that voxel) before you act on it.
- **Name bones only on the keyframe through the joint or on the 3D sheet.** On a single slice away from the joint,
  bones get swapped; follow the label from the keyframe instead of renaming it from the new slice.
- **Coordinates you read off an image are approximate**, by tens of pixels at the joint. Draw boxes and picks
  roughly, let the snapping scripts fit them to the bone, and look at the snapped result. A pixel on a render is
  not a voxel: never type voxel coordinates read off an image.
- **Never estimate an angle, a length or a volume by eye.** Code measures; you confirm that the measured thing is
  the right thing. A ruler's number on a quad view is code's.
- **Draw what a script saved, not a picture it made.** A script that places a mask, a surface, a point or a line writes it as
  `objects` in its result record; pass that record (never retype the entries) to `quad_view.py --objects <record>.json`, which draws every entry on its own grid, with any number of rulers.
- **A model's name for a small structure is a guess.** Name what the data and the anatomy reference support, and
  ask about the rest.

## How to look

Before you open an image, write down what you expect to see and what would mean failure; a look without a
criterion agrees with whatever it finds. After a fix, render the same view again and look again before you move on.

When part of an image is unclear, render that region again (`quad_view.py --center`, `--zoom`, `--plane`) instead of
reading more into a small picture or asking for a larger one.
