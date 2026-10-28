---
name: bone-morphometry
description: >
  Load when a task asks for volumes, BV/TV, Tb.Th, Tb.Sp, Tb.N, trabecular nodes and ends, cortical thickness, distances
  or ratios: the definitions, the method behind each number, the QC image it needs, and which of the lab's parameters
  are computed today.
---

# Bone morphometry

Names and definitions follow Bouxsein et al. 2010 (ASBMR guidelines). Lengths are in mm, volumes in mm^3, BV/TV in %.
Code computes every number from a mask on the scan grid; you choose the region and the threshold, and you look at the
QC image before you report.

## Resources

All take paths, read the voxel size from `--grid` (the scan's `hu.json`), and print one JSON line.

| Script | Does |
|---|---|
| `morphometry.py trabecular` | TV, BV, BV/TV, Tb.Th, Tb.Sp, Tb.N in an ROI; with `--skeleton`, Tb.Nd and Tb.Tm. Writes `morphometry.json`, `thickness-mm.npy`, `separation-mm.npy`, `qc.jpg` |
| `morphometry.py cortical` | Ct.Th in a slab at a depth below a reference surface. Writes `<name>.json`, `qc-<name>.jpg` |
| `measure.py` | Distances between two points, label volumes, ratios of named values, each with unit, definition and input hashes |

```
python morphometry.py trabecular --roi roi.npy (--bone bone.npy | --hu hu.npy --threshold HU) --grid hu.json --out DIR [--skeleton]
python morphometry.py cortical --cortex cortex.npy --surface surface.npy --axis 0 --direction 1 --depth-um 100 --grid hu.json --out DIR --name Ct.Th.100
python measure.py --spec spec.json --grid hu.json --out measurements.json
```

`--roi`, `--bone` and `--cortex` are boolean `.npy` on the scan grid (`regions-and-landmarks` makes ROIs). `--surface`
is a 2D `.npy`: for each position across `--axis`, the voxel index of the reference surface along it. `--direction 1` if
depth grows with the index.

`measure.py` spec (points are `[z, y, x]` voxel indices, fractions allowed):

```json
{"distances": {"femoral_length": {"points_zyx": [[170, 330, 128], [258, 292, 338]], "definition": "straight line A to C"}},
 "volumes":   {"femur_volume": {"labels": "labels.npy", "ids": [1], "definition": "femur label"}},
 "ratios":    {"width_to_length": {"num": "femoral_width", "den": "femoral_length", "definition": "W/L"}}}
```

A ratio may use any distance or volume in the spec and earlier ratios. Its unit is `1` when both share a unit.

## Definitions and methods

| Name | Definition here | Method |
|---|---|---|
| TV | ROI voxel count x voxel volume | trabeculae plus marrow |
| BV | bone voxels in the ROI x voxel volume | bone = HU above the threshold you pass, or your mask |
| BV/TV | BV / TV, in % | |
| Tb.Th | mean diameter of the largest sphere inside bone that covers each bone voxel | sphere `local_thickness` (Hildebrand and Ruegsegger). Not twice the distance transform, which reads thin struts low |
| Tb.Sp | the same on marrow (ROI minus bone) | space outside the ROI is not marrow, so struts cut by the ROI edge read thin and gaps there read small |
| Tb.N | (BV/TV) / Tb.Th, in 1/mm | model-derived (Bouxsein 2010), not a count of struts. State "model-derived" when you report it |
| Tb.Nd | nodes per mm^3 of TV | 3D skeleton (`skimage.morphology.skeletonize`); a node is a connected cluster of skeleton voxels with 3 or more neighbours (26-connectivity) |
| Tb.Tm | ends per mm^3 of TV | skeleton voxels with exactly 1 neighbour |
| Ct.Th | mean sphere diameter over cortical voxels in a slab | sphere thickness of the cortical mask, sampled in a slab centred `--depth-um` below the reference surface, `--slab-um` thick (default 50) |

Radii are quantised at half a voxel, so a diameter can read up to one voxel low. Voxels must be isotropic; the script
fails with a sentence if they are not.

**Tb.Nd and Tb.Tm are not validated against Scanco or any reference tool.** Checked only on a synthetic cross (1 node, 6
ends, as expected). Skeleton voxels within `--edge-margin-voxels` (default 3) of the ROI edge are left out of the counts,
because the ROI cuts struts and makes false ends; `morphometry.json` also holds the counts with them in. Plate-like bone
skeletonises to a surface, so a dense, plate-rich ROI (the mouse tibial epiphysis) gives many nodes and tracks the shape
of the plates as much as the lattice. Report them as exploratory and give the ratio only as a comparison between groups.

**Ct.Th needs a cortical mask, not a bone mask.** Near a growth plate the slab also holds trabeculae and plate; the
sphere thickness there averages them in. Make the cortical mask first (`regions-and-landmarks`), look at it, and report
which mask you used. The mean is lifted by thick blobs where the wall meets a ridge: `morphometry.json` also gives the
median and standard deviation.

## The QC image each number needs

Open it with `view_image` before you report.

- **Trabecular:** `qc.jpg` shows the ROI (cyan) and bone (orange) on three slices, the Tb.Th and Tb.Sp maps, and the
  skeleton. Check that the ROI holds the structure you mean and leaves out the cortex, plate and growth plate, that the
  bone outline follows the struts (a wrong threshold shows here), and that Tb.Th colours match strut width.
- **Cortical:** `qc-<name>.jpg` shows the slab (red) on the cortical mask and the thickness along the slab. Check
  that the slab sits where you mean (depth below the right surface) and covers the wall all round.
- **Distances:** render the two points on the slice or surface (`regions-and-landmarks` `pick-check.jpg`), and look.

Never adjust a value to match an expectation. A value that looks wrong has a cause in the mask, the threshold or the
points.

## Checked against

OA6-1RK, tibial IIOC trabecular ROI, threshold 2459.875 HU, 10.5 um voxels: this `morphometry.py` gives the same
TV, BV, BV/TV, Tb.Th, Tb.Sp and Tb.N as the old run, to every digit printed. `measure.py` reproduces the old femoral
length (2.4226 mm), width (3.3935 mm) and femur volume.

## The lab's parameters (deck of 2026-10-27) and what computes them

"Script" is what produces the number. "Region" is who makes the ROI. The OA protocol skill is `oa-subchondral-protocol` in
the mouse-OA package. A region from `region_from_curves.py` still needs curves you traced and looked at.

| # | Parameter | Script and field | Region | Status |
|---|---|---|---|---|
| 1 | Patella volume | `measure.py` volumes | patella label | computed, given a patella label |
| 2 | Lateral meniscus/osteophyte volume | `measure.py` volumes | needs a segmentation of it | segmentation not covered here |
| 3 | Medial meniscus/osteophyte volume | `measure.py` volumes | as 2 | segmentation not covered here |
| 4 | TV of tibial IIOC (ROI-1) | `morphometry.py trabecular`, `TV` | OA protocol | computed |
| 5 | BV in IIOC | `BV` | OA protocol | computed |
| 6 | BV/TV in IIOC | `BV/TV` | OA protocol | computed |
| 7 | Height of IIOC | `measure.py` distances | points: OA protocol + `pick.py` | computed |
| 8 | Height, medial compartment | `measure.py` distances | as 7 | computed |
| 9 | Height, lateral compartment | `measure.py` distances | as 7 | computed |
| 10 | Tibial width at the growth plate | `measure.py` distances | as 7 | computed |
| 11 | Subchondral plate thickness, medial | none | OA protocol | not computed: no plate-thickness script here |
| 12 | Subchondral plate thickness, lateral | none | OA protocol | not computed: as 11 |
| 13 | TV of IIOC-trab (ROI-2) | `TV` | OA protocol | computed |
| 14 | BV of IIOC-trab | `BV` | OA protocol | computed |
| 15 | BV/TV in IIOC-trab | `BV/TV` | OA protocol | computed |
| 16 | TV, ROI-3 | `TV` | `region_from_curves.py between` (growth-plate surface +50 um to +250 um, `--clearance-mm 0.02` from the cortex) | computed |
| 17 | BV in ROI-3 | `BV` | as 16 | computed |
| 18 | BV/TV | `BV/TV` | as 16 | computed |
| 19 | Tb.N | `Tb.N` (model-derived) | as 16 | computed |
| 20 | Tb.Th | `Tb.Th` | as 16 | computed |
| 21 | Tb.Sp | `Tb.Sp` | as 16 | computed |
| 22 | Tb.Nd | `Tb.Nd` with `--skeleton` | as 16 | computed, not validated (above) |
| 23 | Tb.Tm | `Tb.Tm` with `--skeleton` | as 16 | computed, not validated (above) |
| 24 | Cortical thickness, 100 um under growth plate | `morphometry.py cortical --depth-um 100` | cortical mask | computed, given a cortical mask |
| 25 | Cortical thickness, 1000 um under growth plate | `--depth-um 1000` | as 24 | computed (OA6-1RK: 153 um mean on the tibial cortex, QC looked right) |
| 26 | Distal femoral length | `measure.py` distances | points: OA protocol + `pick.py` | computed |
| 27 | Distal femoral width | `measure.py` distances | as 26 | computed |
| 28 | Width-to-length ratio | `measure.py` ratios | | computed |

Vertebral set (slide 9): 1-6 are items 16-21 on a vertebral ROI made with `region_from_curves.py` (the deck's
"20 from end plate cartilage" is a clearance from the end plates; check its unit with the researcher). 7 and 8 are
Tb.Nd and Tb.Tm. 9, cortical thickness at the centre of the vertebra, is `morphometry.py cortical` with a reference
surface at one end plate and a depth of half the height. No vertebral scan has been run through these scripts.
