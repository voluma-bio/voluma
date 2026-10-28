---
name: regions-and-landmarks
description: >
  Load when you must place a point or build a region that SAM cannot give you: pick on a rendered view or a slice and
  snap to the bone, or trace curves on slices and turn them into a region mask. Covers the pick, snap, show, save loop.
---

# Regions and landmarks

A pick is a pixel you point at on an image. Code turns it into a voxel on the scan grid; you look at the result before
you keep it. Never type voxel coordinates you read off an image: a pixel on a render is not a voxel.

Generic: any bone, any joint. The protocol that says which point or region you need (growth plate, ROI, landmarks) is in
the workflow's protocol reference, which also names the script that builds a protocol region when the protocol has one (use it
instead of assembling the region here).

## Loop

1. **Render** a view of the structure (`visual-check`). For a 3D pick, render one view with `render_surfaces.py --azimuth DEG` (a 100 px grid) and keep its `.camera.json`: it holds the `image` and `camera` keys of the surface-pick JSON.
2. **Pick** on it: read the pixel from the image's pixel grid, write the picks JSON.
3. **Snap**: run `pick.py`. It writes `points.json` and `pick-check.jpg`.
4. **Look** at `pick-check.jpg` (`view_image`): red x is your pick, green circle is where it landed. Check the circle sits on
   the feature you meant, on the right bone, and on the right side of a ridge. If not, change the pixel and run again.
   Judge from at least one other view for a point that matters, since depth is the one thing a single render hides.
5. **Save**: only then report the points (`report_output`) with `pick-check.jpg` as evidence.

For a region the same: `region_from_curves.py` writes `region-check.jpg` (region cyan, your curve red, slices spread over the
region). Look at it before you measure in the region.

## pick.py

```
python pick.py --picks picks.json (--mask bone.npy | --labels labels.npy --ids 2) --grid hu.json --out DIR [--hu hu.npy]
```

Output `points.json`: `{"points": [{"name", "zyx": [z, y, x], "snap_distance_mm", "method", ...}], "grid_id",
"spacing_zyx_mm", "inputs"}`. `zyx` are voxel indices on the scan grid. `snap_distance_mm` is how far the snap moved the pick:
a large value means the pick was off the bone, so look again.

**Surface pick**, on a 3D render. All vectors are `[z, y, x]` voxel indices on the scan grid, pixels are `[col, row]` from
the top left of the image:

```json
{"mode": "surface", "image": "view.jpg",
 "camera": {"position": [z, y, x], "focal_point": [z, y, x], "view_up": [z, y, x], "view_angle": 30},
 "picks": [{"name": "A", "pixel": [500, 400]}]}
```

`view_angle` is the vertical field of view in degrees (VTK's). The ray from the pixel goes into the mask and snaps to the first surface
voxel it meets (`method: ray_hit`). If it misses the bone it takes the surface voxel nearest the ray (`nearest_to_ray`, with
the distance from the ray as `snap_distance_mm`): a miss is a warning.

**Slice pick**, on an axis-aligned slice. Rows are the lower-numbered of the two remaining axes, columns the higher:

```json
{"mode": "slice", "axis": 0,
 "picks": [{"name": "P", "index": 250, "pixel": [250, 200], "snap": "nearest"}]}
```

`snap` is `exact` (the pixel as given), `nearest` (default: nearest mask pixel on the slice), `center` (centroid of the mask on
the slice; `on_mask` says whether it lies on the bone: a concave section can put it in the marrow), or `edge_min` and `edge_max`
(the lowest or highest column of the mask on the slice, at the median row).

## region_from_curves.py

Two modes. Both write `region.npy` (boolean, scan grid, with sidecar), `region-check.jpg` and print the voxel count, volume
in mm³ and bounding box. Both take an optional bone mask (`--bone` or `--labels`/`--ids`) to clip to, and
`--clearance-mm` to also drop voxels closer than that to the **outer** surface of the mask you pass. For a filled bone that
is the periosteum, so the cortex stays inside the region; a clearance from the inner cortex needs the cortex depth added, which
is the protocol's job.

```
python region_from_curves.py between --surface-a A.json --surface-b B.json --grid hu.json --bone bone.npy --out DIR
python region_from_curves.py polygon --polygons poly.json --grid hu.json --bone bone.npy --out DIR
```

**between**: the voxels between two surfaces along one axis. Each surface is a curves JSON, or a 2D `.npy` height map
(then give `--axis` and `--height-axis`). Curves JSON: one polyline per traced slice, `[row, col]` points on that slice
(rows are the lower-numbered of the two axes left after `axis`; `height` says whether the surface height is the `row` or `col`):

```json
{"axis": 1, "height": "row", "slices": {"100": [[140, 80], [123, 95], [122, 120]], "190": [[138, 80], [103, 100]]}}
```

This curves schema (`axis`, `height`, `slices`) and `surface_from_curves` in `region_from_curves.py` are the only way surfaces are
traced and interpolated: a workflow's own region scripts import that function rather than carry a second one, so a trace means
the same thing in every script. A polyline is read as height as a function of the other coordinate, joined linearly. Between traced slices the surface is
joined linearly; the region exists only between the first and last traced slices (or `--slice-range lo hi`) and only
where the polylines reach along the other axis. `--offset-a-mm` and `--offset-b-mm` move a surface along the height axis,
which makes a slab at a set distance from a surface (for example a 100 um band starting 30 um above a traced surface).

**polygon**: `{"axis": 0, "slices": {"230": [[row, col], ...], "270": [[row, col], ...]}}`, one closed outline per traced slice,
at least two slices. Slices between are interpolated by signed distance, so the outline morphs smoothly; it is not an extrusion.
Trace slices where the shape changes, and at the ends of the region.

Trace on slices you have looked at with a pixel grid (`visual-check`). Fewer than about five traced slices across a curved
region gives a coarse surface: add slices where the curve bends.

## Hand the points to the lab: Amira

```
python amira_landmarks.py --points points.json --header hu.json --out landmarks.landmarkAscii
```

`--points` is a `pick.py` `points.json` or a plain `{"name": [z, y, x]}` file. Each point is moved to physical millimetres with
the DICOM affine in `hu.json` and written as one Amira landmark set (`# AmiraMesh 3D ASCII 2.0`, `ContentType "LandmarkSet"`);
`<out>.names.json` lists the order, because the format has no names. The lab loads it in Amira on the same series to check the
points. The file layout follows the open-source writer in R's `nat` package and has not been opened in Amira itself: if Amira
rejects it, report that. Report the file as evidence with the `pick-check.jpg` of each point.

## Checked on

OA6-1RK. `pick.py` surface picks agree with a VTK cell picker on the same render to within 1 to 2 voxels. `between`, fed the
old run's growth-plate face and traced boundary, rebuilds the old tibial trabecular ROI: 1,130,584 voxels against 1,129,591
(0.09% more, all extra).