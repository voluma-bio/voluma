---
name: bone-morphometry
description: >
  Load when a task asks for volumes, BV/TV, Tb.Th, Tb.Sp, Tb.N, trabecular nodes and ends, cortical thickness, distances
  or ratios: the definitions, the method behind each number, and the QC image it needs. Which region and which parameters
  a protocol wants is in the workflow's protocol reference.
---

# Bone morphometry

Names and definitions follow Bouxsein et al. 2010 (ASBMR guidelines). Lengths are in mm, volumes in mm³, BV/TV in %.
Code computes every number from a mask; you choose the region, and you look at the QC image before you report. Which
region a parameter uses, and which script makes it, is the protocol's call (the workflow's protocol reference): this skill
defines the measurements and does not build regions.

## Resources

All take paths and print the result record (`microct-core`: `{id: {value, unit, definition, kind}}`). `morphometry.py` is the one
owner of TV, BV and BV/TV: a region script builds the region, this computes its volumes, so a deck number is produced once.

| Script | Does |
|---|---|
| `morphometry.py volumes` | TV, BV, BV/TV of a region. Writes `volumes.json` |
| `morphometry.py trabecular` | the same three, plus Tb.Th, Tb.Sp, Tb.N; with `--skeleton`, Tb.Nd and Tb.Tm. Writes `morphometry.json`, `thickness-mm.npy`, `separation-mm.npy`, `qc.jpg` |
| `morphometry.py cortical` | Ct.Th in a slab at a depth below a reference surface. Writes `<name>.json`, `qc-<name>.jpg` |
| `measure.py` | Distances between two points, label volumes, ratios of named values, each with unit, definition and input hashes |

```
python morphometry.py volumes --roi roi.npy --hu hu.npy --hu-json hu.json --out DIR [--id TV=my-tv --id BV=my-bv --id BV/TV=my-bv-tv]
python morphometry.py trabecular --roi roi.npy --hu hu.npy --hu-json hu.json --out DIR [--skeleton] [--id Tb.Th=my-id ...]
python morphometry.py cortical --cortex cortex.npy --surface surface.npy --axis 0 --direction 1 --depth-um 100 --grid hu.json --out DIR --name my-ct-th-id
python measure.py --spec spec.json --grid hu.json --out measurements.json
```

`--roi` and `--cortex` are boolean `.npy`. `volumes` and `trabecular` take the region (`--roi`), the HU on its grid (`--hu`: `hu.npy` for a
scan-grid region, the aligned stack's HU for a region traced on it, and they must share a `grid_id`; `--grid` defaults to the region's own
sidecar) and, separately, `--hu-json`, the scan's `hu.json`, for the calibration the default threshold needs (not needed with
`--threshold`). The volumes are counted on that grid. `--id KEY=output-id` names each value (keys are in `--help`; the default id is the key,
for example `Tb.Th`), and `--name` is the id of a cortical value. A diagnostic (`voxel-size`, node and end counts, the counted volume) comes in the
same record. `--surface`
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
| BV | bone voxels in the ROI x voxel volume | bone = ROI and HU above the measurement threshold (`microct-core`: the lab's 2.16/cm in this scan's HU, computed from `--hu-json`'s calibration unless you pass `--threshold`). No label gates it |
| BV/TV | BV / TV, in % | |
| Tb.Th | mean diameter of the largest sphere inside bone that covers each bone voxel | sphere `local_thickness` (Hildebrand and Ruegsegger). Not twice the distance transform, which reads thin struts low. Every thickness record carries a `voxel-size` diagnostic |
| Tb.Sp | the same on marrow (ROI minus bone) | space outside the ROI is not marrow, so struts cut by the ROI edge read thin and gaps there read small |
| Tb.N | (BV/TV) / Tb.Th, in 1/mm | model-derived (Bouxsein 2010), not a count of struts. State "model-derived" when you report it |
| Tb.Nd | nodes per mm³ of the tissue volume that was counted | 3D skeleton (`skimage.morphology.skeletonize`); a node is a connected cluster of skeleton voxels with 3 or more neighbours (26-connectivity) |
| Tb.Tm | ends per mm³ of the tissue volume that was counted | skeleton voxels with exactly 1 neighbour |
| Ct.Th | mean sphere diameter over cortical voxels in a slab | sphere thickness of the cortical mask, sampled in a slab centred `--depth-um` below the reference surface, `--slab-um` thick (default 50) |

Radii are quantised at half a voxel, so a diameter is a whole number of voxels: **a structure an odd number of voxels
wide reads one voxel high** (a 1-voxel plate reads 2, 3 reads 4; even widths read exactly). On a trabecular ROI 6-7 voxels
thick on average that was +8-9% (72.4 against 66.8 um for the same mask upsampled 2x), and Tb.N = (BV/TV)/Tb.Th inherits the
opposite bias. Compare thicknesses only between scans of the same voxel size, and state the voxel size with them. Whether
Scanco uses the same convention is open. Voxels must be isotropic; the script fails with a sentence if they are not.

**Tb.Nd and Tb.Tm are not validated against Scanco or any reference tool.** Checked only on a synthetic cross (1 node, 6
ends, as expected). Both are counts per tissue volume (1/mm³, the lab's definition). Skeleton voxels within
`--edge-margin-voxels` (default 3) of the ROI edge are left out of the counts, because the ROI cuts struts and makes false ends,
so the density divides by the part of the ROI those counts come from: the values carry `counted_volume_mm3`, and
`morphometry.json` holds the counts with and without the edge voxels. In a slab 19 voxels thick that interior is under half of
the ROI. Plate-like bone skeletonises to a surface, so a dense, plate-rich ROI gives many nodes and tracks the shape of the
plates as much as the lattice. A count of a few dozen nodes or ends is too small for a ratio. Report them as exploratory and
give the ratio only as a comparison between groups.

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
