---
name: bone-morphometry
description: >
  Load when a task asks for volumes, BV/TV, Tb.Th, Tb.Sp, Tb.N, trabecular nodes and ends, cortical thickness,
  distances or ratios: each measurement's definition and method, its known bias, and what its QC image must show.
---

# Bone morphometry

Names and definitions follow Bouxsein et al. 2010 (ASBMR). Lengths in mm, volumes in mm³, BV/TV in %.
`morphometry.py` is the one owner of TV, BV and BV/TV and of the thickness and skeleton measures; `measure.py`
gives distances between points, label volumes (voxels of a label, not BV) and ratios. You choose the region: the
workflow's protocol says which region each parameter uses, and this skill builds none.

## Definitions and methods

| Name | Definition | Method and caveat |
|---|---|---|
| TV | ROI voxels × voxel volume | trabeculae plus marrow |
| BV | bone voxels in the ROI × voxel volume | bone = ROI and HU above the measurement threshold (`microct-core`); no label gates it |
| BV/TV | BV / TV, in % | |
| Tb.Th | mean diameter of the largest sphere inside bone that covers each bone voxel | sphere thickness (Hildebrand and Rüegsegger), not twice the distance transform, which reads thin struts low |
| Tb.Sp | the same on marrow (ROI minus bone) | space outside the ROI is not marrow: struts and gaps cut by the ROI edge read thin and small |
| Tb.N | (BV/TV as a fraction) / Tb.Th, in 1/mm | model-derived, not a strut count: say "model-derived" when you report it |
| Tb.Nd, Tb.Tm | skeleton nodes (3 or more neighbours) and ends (1 neighbour) per mm³ of the tissue counted | 3D skeleton. Voxels within an edge margin of the ROI are left out, because the ROI cuts struts and makes false ends, so the density divides by the counted part, which the record carries. **Unvalidated against any reference tool**; plate-like bone skeletonises to a surface and gives many nodes. Report them as exploratory |
| Ct.Th | mean sphere diameter over cortical voxels in a slab | a slab centred at a depth below a reference surface. **Needs a cortical mask, not a bone mask**: near a growth plate a bone mask's slab averages in trabeculae and plate. Say which mask you used. The record also gives the median and standard deviation, since thick blobs where the wall meets a ridge lift the mean |

Radii are quantised at half a voxel, so **a structure an odd number of voxels wide reads one voxel high** (a
1-voxel plate reads 2; even widths read exactly), a larger share of a thinner structure, and Tb.N inherits the
opposite bias. Compare thicknesses only between scans of the same voxel size and state the voxel size with them
(every thickness record carries it). Whether Scanco uses the same convention is open. Voxels must be isotropic; the
script stops when they are not.

## The QC image each number needs

Open it with `view_image` before you report.

- **Trabecular** (`qc.jpg`): the ROI and bone on three slices, the Tb.Th and Tb.Sp maps, the skeleton. The ROI must
  hold the structure you mean and leave out cortex, plate and growth plate; the bone outline must follow the struts
  (a wrong threshold shows here); Tb.Th colours must match strut width.
- **Cortical** (`qc-<name>.jpg`): the slab on the cortical mask and the thickness along it. The slab must sit at
  the depth below the surface you mean and cover the wall all round. The image projects along the slab's axis, so
  it cannot show the depth itself: read the depth and slab parameters back from the record.
- **Distances:** the two points drawn on the view they were placed on (`regions-and-landmarks`, `pick-check.jpg`,
  or a quad view with `--ruler`).
