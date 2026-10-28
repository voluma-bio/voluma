---
name: visual-check
description: >
  Load before you judge a segmentation, a frame, a box, a region or a landmark: how to render a view that answers the
  question, look at it with `view_image`, and what your eyes are and are not reliable for on micro-CT.
---

# Visual check

You can see images. Render a view, open it with `view_image`, and decide from what you
see. Every label you keep, every frame you accept and every region you hand on has to
pass one look first. Put the image in your evidence, so the reviewer and the researcher see
what you saw.

## Pick the view for the question

All renderers are in `<this skill>/resources/`, take paths, write one JPEG and print its path. Every image is at most 2000 px
a side and 1 MiB (the `view_image` limit); a 6-view 3D sheet of OA6-1RK is about 190 KB.

| Question | View | Resource |
|---|---|---|
| Which bone is which? Does this slice cut through the joint? | The slice with a 100 px grid | `render_slices.py --in oriented.npy --index K --grid` |
| Is a box, a pick or a curve where I meant it? | The same slice with it drawn on | `render_slices.py ... --boxes r0,c0,r1,c1:name --points r,c:name` |
| Is each label on the right bone, and is any bone unlabelled? | Overlay: label tint plus outline on the keyframe and two orthogonal cuts | `render_overlay.py --hu hu.npy --labels labels.npy --frame frame.json` |
| Does one label cover two bones? Are there loose fragments? | 3D sheet: six views around the long axis, one colour per label | `render_surfaces.py --labels labels.npy --frame frame.json` |
| What is this small thing, and which label is it under? | Crop sheet: three orthogonal cuts through the piece, labels outlined | `render_crops.py --hu hu.npy --labels labels.npy --component-at z,y,x` (or `--label N`) |
| Which segmentation is right here? | Disagreement panel: CT beside both outlines with the disagreeing voxels filled | `segmentation-check`: `disagree.py` |

Open up to four images in one `view_image` call: for example, the overlay and the 3D sheet together. **Only the images of your last two `view_image` calls stay visible**; older ones are a line of text. To compare before and after a fix, open both in one call. Pass `--names
1=femur,2=tibia` to put a legend on a sheet, and `--window lo,hi` (the workflow's anatomy reference gives the HU window) to make bone
readable.

**Coordinates on every image:** x is the column (numbers along the top), y is the row (numbers down the left), both in
pixels of the slice. A box is `r0,c0,r1,c1` = `y0,x0,y1,x1`, ends inclusive. Read a box off the grid in that order.
Overlay and crop titles name the cut axes; the oriented stack's axis 0 is the slice index.

## What your eyes are good for

These rules come from 16 model calls on one scan (OA6-1RK, 2026-10-28; `design/microct-skillset.md`, "What the model's
eyes can do"). Every result is n=1 on one scan: treat the rules as defaults, and say when a look contradicts one.

- **Code checks gate, and your eyes confirm.** Component counts, volume ranges and unlabelled pieces run first
  (`segmentation-check`); then look at what they flag, plus the 3D sheet. Looking alone missed a subtle error in 2D.
- **The 3D sheet is your best check.** It caught a tibia label covering the fibula, and small fragments merged into
  the femur, in every case tried (4 of 4). Look at it after every change to the labels.
- **2D overlays catch gross errors and can miss small ones.** A leak across the joint and an unlabelled patella were
  caught (2 of 3 overlay tests). A small fragment carrying the wrong label was reported as "unlabelled", at the wrong
  place (about 150 px off) by one of the two models tested. When an overlay shows something small, check it in code
  (`label_stats.py`, or the label value at that voxel) before acting.
- **Name bones only on the keyframe through the joint, or on the 3D sheet.** On a single slice away from the joint, the
  tibia was called the femur and the fibula the tibia (both models). When you need a bone's identity elsewhere, follow
  its label or component from the keyframe. Do not rename it from the new slice.
- **Coordinates you read off an image are approximate.** Boxes read by eye were off by up to ~55 px at the joint on a
  928 px slice (one model; the other was within 5 px on big bones and worse on the patella). Draw boxes and picks
  roughly, let the snapping resource fit them to the bone (`snap_boxes.py`, `pick.py`), and look at the snapped result.
- **Never estimate an angle, a length or a volume by eye.** Flexion read off renders came out 10-38 degrees against a
  measured 64. Measure in code, then look to confirm that the measured thing is the right thing. (The renders were not
  true lateral views, so this partly measures projection; the rule stands.)
- **Prefer stills to video.** A model once described a bone rotating into view in a video whose frames were
  identical. Take a model's account of what changed across frames as unverified. The sheet shows the same views and is
  also the evidence the reviewer sees.
- **A model's name for a small structure is a guess.** In the evidence run, one model called a small posterior piece a fabella on every
  overlay and the other on the keyframe. That is unconfirmed (see the anatomy reference): name what the data and the protocol
  support, and ask for the rest.

## How to look

1. Before you open the image, write down what you expect to see and what would mean failure.
2. Open it. Describe what you see in terms of anatomy ("the red label continues below the
   femoral condyle onto the tibial plateau, around x 300-420, y 480-560"), not colours alone.
3. Decide: accept, fix and look again, or raise a To check item (see `segmentation-check`). Say which in your
   checkpoint, with the image as evidence.
4. Once you have fixed a problem, render the same view again and look again before you move on.

A look costs real money, mostly in reasoning. Look where a
decision depends on it. Ten looks in a task is normal, and fifty means you are looping. Open the ones you need, not every cut.
