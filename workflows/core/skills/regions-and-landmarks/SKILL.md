---
name: regions-and-landmarks
description: >
  Load when you must place a point or build a region SAM cannot give you: pick on a view and snap to the bone, or
  trace curves on slices and turn them into a region; the one curve schema every traced surface uses; handing points
  to Amira.
---

# Regions and landmarks

A pick is a pixel you point at on an image; code turns it into a voxel on the scan grid, and you look at the result
before you keep it. The workflow's protocol says which point or region you need and names its own region script
where it has one; use that instead of assembling the region here.

## Points

1. Render a quad view of the structure (`visual-check`) and keep its `.view.json`. Pick on the 3D pane for a point
   on a surface, on a slice pane for one inside the bone. Place the two ends of a length on a view that shows that
   length side-on (rotate the 3D or reslice along the shaft): an end-on view foreshortens it and the points land
   across it.
2. `pick.py` snaps the picks to the bone and writes `points.json` and `pick-check.jpg` (`--help` for the picks
   file). A large `snap_distance_mm` means the pick was off the bone.
3. Look at `pick-check.jpg`: the circle must sit on the feature you meant, on the right bone, on the right side of a
   ridge. A landmark a measurement uses is judged from a second view as well: depth is the one thing a single render
   hides.
4. Report the points with `pick-check.jpg` as evidence.

## Regions from curves

`region_from_curves.py` builds a region between two traced surfaces, or inside a polygon swept between slices,
clipped to a bone mask with an optional clearance from its outer surface, and writes `region-check.jpg` (`--window` sets its display window: `lo,hi`, or the scan's `scan-settings.json`). Its curve
schema (`{"axis", "height", "slices": {"<index>": [[row, col], ...]}}`) is the one way a surface is traced in any
script: a workflow's own region scripts read the same schema, so a trace means the same thing everywhere. Trace on
slices you have looked at with a pixel grid, where the shape changes and at the ends of the region; fewer than about
five slices across a curved region gives a coarse surface. Look at `region-check.jpg` before you measure in the
region.

## A researcher's mark

A mark comes in mm on the image it was drawn on, which the delivery names ("drawn on tibia-grid v1"): voxel index times
that image's spacing, not the scan's world mm. `marks_to_grid.py --drawn-on <that image's header>` (the `.json` beside its `.npy`; `/run/outputs.yaml`) maps it onto the grid you
work on (`--grid`, that grid's own header), through the scan's world mm when the two grids differ: `--curve`
splices a line or path drawn along a face on one section into that section's curve, in a copy of your annotations; `--seed` gives a labelled
voxel inside an outline and says whether its piece stands apart from the bone, to take the piece out of its label
(`segmentation-check`). The mark replaces your work only where it lies: look at it on that section's view, and bring the
neighbouring sections and the rest of the region to meet it.

## Hand the points to the lab: Amira

`amira_landmarks.py` writes points files on the scan grid as one Amira landmark set in physical millimetres, with a
`.names.json` for the order. The layout follows the open-source writer in R's `nat` package and has not been opened
in Amira itself: if Amira rejects it, report that. Report the file with each point's `pick-check.jpg`.
