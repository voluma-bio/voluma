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

All renderers are in `<this skill>/resources/`, take paths, write one JPEG and print a JSON line with its path. Every image is at most 2000 px
a side and 1 MiB (the `view_image` limit).

| Question | View | Resource |
|---|---|---|
| Which bone is which? Does this slice cut through the joint? | The slice with a 100 px grid | `render_slices.py --in oriented.npy --index K --grid` |
| Is a box, a pick or a curve where I meant it? | The same slice with it drawn on | `render_slices.py ... --boxes r0,c0,r1,c1:name --points r,c:name` |
| Is each label on the right bone, and is any bone unlabelled? Is a mask, a face or a point where I meant, from every side? | Quad view: 3D plus three slices through one crosshair, which you move, step, rotate and reslice | `quad_view.py --hu hu.npy --labels labels.npy` (below) |
| Does one label cover two bones? Are there loose fragments? | 3D sheet: six views around the long axis, one colour per label | `render_surfaces.py --labels labels.npy --frame frame.json` |
| What is this small thing, and which label is it under? | Crop sheet: three orthogonal cuts through the piece, labels outlined | `render_crops.py --hu hu.npy --labels labels.npy --component-at z,y,x` (or `--label N`) |
| Which segmentation is right here? | Disagreement panel: CT, your labels and the classic labels side by side, disagreeing voxels filled | `segmentation-check`: `disagree.py` |

Open up to four images in one `view_image` call: for example, two quad views to compare before and after. **Only the images of your last two `view_image` calls stay visible**; older ones are a line of text. To compare before and after a fix, open both in one call. Pass `--names
<the anatomy reference's anatomy.json>` (or `1=name,2=name`) to name every label in the legend, and `--window lo,hi` (the workflow's anatomy reference gives the HU window; a negative low end works as is: `--window -500,6000`) to make bone
readable.

**Coordinates on a slice image (`render_slices`, `render_crops`):** x is the column (numbers along the top), y is the row (numbers down the left), both in
pixels of the slice. A box is `r0,c0,r1,c1` = `y0,x0,y1,x1`, ends inclusive. Read a box off the grid in that order.
Crop titles name the cut axes; the oriented stack's axis 0 is the slice index. A quad view is scaled and can be zoomed or oblique, so
its grid is not pixels of the slice: read its tick labels (voxel indices of the scan axes on a pane named `axis K = N`, mm from the crosshair
on an oblique one) and pick on it with `pick.py`, which uses the pixel -> voxel map in its `view.json`.

## Look with the quad view

`quad_view.py` draws one JPEG (about 1700 px, 0.5 MiB): the 3D pane (bone ivory; labels coloured when shown; the three planes as
outlines) and slice panes 0, 1, 2 (top right, bottom left, bottom right; the scan's `axis 0`, `axis 1`, `axis 2`), one crosshair linking them (each pane's border is the colour of its plane
in 3D, and of its line in the other panes). Panes are centred on the crosshair. Every call prints the state: crosshair, panes, timings.
Each call starts from the last view and changes it; write each to a new path in one directory you can write to (not beside your
inputs, which may be read-only). The first call builds surfaces (tens of seconds); later calls in the same directory reuse them.

```
Q=<this skill>/resources/quad_view.py
python $Q --hu hu.npy --labels labels.npy --names anatomy.json --out v/1.jpg                    # first look
python $Q --from v/1.view.json --center <label name> --zoom 3 --out v/2.jpg                            # look closely at a label, a point or z,y,x
python $Q --from v/2.view.json --move axis0+10 --out v/3.jpg                                    # step 10 slices along scan axis 0
python $Q --from v/3.view.json --rotate 60,0 --out v/4.jpg                                      # turn the 3D camera (azimuth, elevation)
python $Q --from v/4.view.json --points shaft=pts.json --ruler a,b --plane 1:contains=a,b --out v/5.jpg   # reslice side-on along a bone
python $Q --from v/5.view.json --frame f.json --mask roi=roi.npy --face plate=face.npy --hide labels --out v/6.jpg   # show a placement
```

- `--mask`, `--face` and `--labels` volumes are sampled from their own grid: pass the `frame.json` of any grid that is not the scan's
  with `--frame` (the `grid_id` in the array's sidecar picks it). A point file needs a `grid_id` on the scan grid, as `pick.py` writes.
- `--points NAME=file`: NAME is the layer `--show`/`--hide` toggles; the points keep the names inside the file, and `--ruler`/`--center`/`contains=` use those.
- A point shows on a slice only when the plane passes within a few pixels of it; the ruler is dashed on panes it does not lie in, and its
  length is the 3D distance in mm. `--plane 1:normal=z,y,x:up=z,y,x` makes any oblique plane (vectors in mm); `--plane 1:axis=1` goes back.
- `--center` and `--move` change what you look at, so look again; the state is in the `.view.json` beside each image.
- **Make your own views.** A checker renders from the output files, not from the worker's images or `view.json`: a view you did not
  make cannot show what the worker left out.
- Every image is for looking. Lengths, angles and volumes come from code on the arrays (a ruler's number is that code's, not a reading).
- Options: `quad_view.py --help` and its docstring.

## What your eyes are good for

These rules are defaults from a small test on one scan: say when a look contradicts one.

- **Run the code checks first** (`segmentation-check`), then look at what they flag, plus the 3D sheet.
- **The 3D sheet is your best check.** It catches a label covering a neighbouring bone and small fragments merged into a big
  bone. Look at it after every change to the labels.
- **2D overlays catch gross errors and can miss small ones**, and can report a small fragment at the wrong place. When an
  overlay shows something small, check it in code (`label_stats.py`, or the label value at that voxel) before acting.
- **Name bones only on the keyframe through the joint, or on the 3D sheet.** On a single slice away from the joint, bones get
  swapped. When you need a bone's identity elsewhere, follow its label or component from the keyframe. Do not rename it from
  the new slice.
- **Coordinates you read off an image are approximate**, by tens of pixels at the joint. Draw boxes and picks roughly, let the
  snapping resource fit them to the bone (`snap_boxes.py`, `pick.py`), and look at the snapped result.
- **Never estimate an angle, a length or a volume by eye.** Measure in code, then look to confirm that the measured thing is
  the right thing.
- **Prefer stills to video.** A model's account of what changed across frames is unverified. The sheet shows the same views and
  is also the evidence the reviewer sees.
- **A model's name for a small structure is a guess:** name what the data and the protocol support, and ask for the rest.

## How to look

1. Before you open the image, write down what you expect to see and what would mean failure.
2. Open it. Describe what you see in terms of anatomy ("the red label continues past the
   joint line onto the other bone, around x 300-420, y 480-560"), not colours alone.
3. Decide: accept, fix and look again, or raise a To check item (see `segmentation-check`). Say which in your
   checkpoint, with the image as evidence.
4. Once you have fixed a problem, render the same view again and look again before you move on.

A look costs real money, mostly in reasoning. Look where a
decision depends on it. Ten looks in a task is normal, and fifty means you are looping. Open the ones you need, not every cut.
