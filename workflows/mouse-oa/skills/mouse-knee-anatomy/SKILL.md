---
name: mouse-knee-anatomy
description: >
  Load when you name, check or prompt bones in a mouse knee micro-CT: the label table with expected volumes
  (resources/anatomy.json), the HU window and bone threshold, where the small structures sit, the fibula hint,
  the SAM prompt list, and the questions about labels 5 and 6 that only the lab can answer.
---

# Mouse knee anatomy

This is the mouse-OA workflow's anatomy: the label ids you write, the numbers `segmentation-check` compares
against, and what is still unknown. Every number comes from one scan (OA6-1RK, spacing 0.0105 mm isotropic): treat
it as n=1. The ranges are widened guesses, not population ranges. A volume outside a range is a reason to look,
not proof of a wrong label.

## Scan settings

| Item | Value | Where it is used |
|---|---|---|
| Display window | 1000 to 8000 HU | orient, keyframe and overlay renders, box drawing (the same window the orientation step used) |
| Bone threshold | 2500 HU | `snap_boxes`, envelopes, BV; `bone_threshold_hu` in `anatomy.json`. The old OA6-1RK run used 2459.875 HU (a Scanco-equivalent value), so numbers differ by well under 1% |
| Voxel | read it from `hu.json` (`spacing_zyx_mm`) | never hard-code 0.0105 |

## Label table

`resources/anatomy.json` is the machine-readable table: `labels[]` with `id`, `name`, `volume_mm3 [lo, hi]`,
`components` (expected number of 3D pieces) and `notes`. Run
`label_stats.py --labels labels.npy --hu hu.npy --ranges <this dir>/resources/anatomy.json`.

| Id | Name | OA6-1RK reference (mm3, pieces) | Range in anatomy.json |
|---|---|---|---|
| 1 | femur | 8.395, 1 | 6.30 to 10.91 |
| 2 | tibia | 7.044, 1 | 5.28 to 9.16 |
| 3 | patella | 1.276, 1 | 0.96 to 1.66 |
| 4 | fibula | 0.992, 1 | 0.74 to 1.29 |
| 5 | medial-joint-mineralization (name is unresolved, see below) | 0.286, 1 | 0.11 to 0.57 |
| 6 | lateral-joint-mineralization | 0.411, 2 | 0.16 to 0.82 |
| 7 | medial-sesamoid | 0.275, 1 | 0.11 to 0.55 |
| 8 | lateral-sesamoid | 0.229, 1 | 0.09 to 0.46 |
| 9 | anterior-joint-mineralization | 0.217, 3 | 0.09 to 0.43 |
| 10 | anterior-tibial-margin-fragment | 0.076, 1 | 0.03 to 0.15 |
| 11 | lateral-tibial-margin-fragment | 0.051, 1 | 0.02 to 0.10 |
| 12 | proximal-patellar-ossification | 0.121, 1 | 0.05 to 0.24 |

The reference volumes are from a watershed on the 2500 HU threshold. SAM masks run 15 to 60% over on small
structures until clipped to a bone envelope; trimmed small SAM tracks run 10 to 20% under the reference. The
ranges are wide enough to hold both, but say which you used when you report a small volume.

Names for labels 5 to 12 are the reference run's working names. The reference marked its own review as
preliminary: none of them is lab-confirmed. Use the names as given; do not rename on your own.

## Where each structure sits and how to find it

Centroids are in scan voxel indices (z, y, x) on OA6-1RK. On that scan the long axis is z (joint end of the
tibia at about z 400, the femur above it), lateral is low y (the fibula centroid is at y 180, the patella near y
310, the tibia at y 312), and the patella is anterior (low x). A scan with another orientation will differ: find
the structure on the keyframe, do not look it up by index.

| Id | Centroid z, y, x | What to look for |
|---|---|---|
| 1 femur | 248, 308, 223 | the upper long bone; condyles at the joint end |
| 2 tibia | 586, 312, 265 | the lower long bone; plateau under the condyles |
| 3 patella | 235, 310, 55 | the small bone in front of the joint, absent on slices off the joint |
| 4 fibula | 616, 180, 398 | thin bone lateral and posterior to the tibia; touches the tibia, so the two can fuse on a threshold |
| 5 | 396, 358, 336 | compact piece at the joint line behind the joint, medial of the midline |
| 6 | 411, 196, 239 | two pieces on the lateral side near the joint line |
| 7 | 301, 419, 298 | piece medial and behind, about 1 mm above the joint line, at the back of the femoral condyle |
| 8 | 288, 181, 307 | the same on the lateral side |
| 9 | 378, 363, 120 | three small pieces: seeds at (395, 368, 92) and (336, 213, 75), both anterior, and (360, 456, 278), posterior and medial |
| 10 | 446, 292, 150 | small piece on the tibial margin, front |
| 11 | 423, 172, 355 | small piece on the tibial margin, lateral |
| 12 | 108, 329, 143 | small piece at the proximal end of the patella, separate from it |

What each looks like on the keyframe and in 3D, from the reference review: the four big bones are obvious on the
keyframe through the joint. The small structures are blobs a few tens of voxels across. On the keyframe they
are easy to miss or to see as part of a big bone. On the 3D six-view sheet a merged small structure shows as a
bump or a disconnected piece on the femur or tibia. The 3D sheet caught a small piece merged into the femur
and a tibia label covering the fibula in every case tried (n=1 scan). Name a small structure only on the keyframe
through the joint or on the 3D sheet, never from an off-joint slice: both vision models misnamed bones on an off-joint
slice.

## Open questions for the lab (do not settle them yourself)

1. **Label 5.** The reference calls it "medial-joint-mineralization". Both vision models (Muse Spark on every
   overlay, Muse Wonder on the keyframe) called it a fabella. Whether it is a fabella or a medial joint
   mineralization is **unresolved**, and nobody has confirmed either. Keep the name `medial-joint-mineralization`
   as the label name, say in any report that the identity is an open question, and raise a To check item if a
   measurement depends on it.
2. **Label 6** (lateral joint mineralization, two pieces) and **label 9** have the same status: reference working
   names, not confirmed.
3. **Labels 10 to 12:** keep separate. Whether they belong to the tibia or patella volumes is the lab's call.

## Deck parameters #1 to #3

| Deck # | Parameter | Status |
|---|---|---|
| 1 | Patella volume | the volume of label 3 from `label_stats.py` (reference 1.276 mm3, core only; label 12 is separate). Whether label 12 counts toward the patella is open |
| 2 | Lateral meniscus / osteophyte volume | **no label maps to it yet.** Candidates are labels 6, 8, 9 and 11, but which structure the lab means is an open question. An unmineralized meniscus is not visible on a bone threshold at all. Report "not mapped", not a number |
| 3 | Medial meniscus / osteophyte volume | same: candidates are label 5 and label 7, and label 5's identity is unresolved. Report "not mapped" |

## Fibula hint

The tibia label tracks into the fibula unless the fibula has its own box. Put the fibula box on a slice where it is
separate from the tibia: on OA6-1RK, oriented-stack slice 340 (a tibia plus fibula slice with no patella). That slice
is not the keyframe, so it is the one place you box a bone you cannot name from the slice alone: name it from the
3D sheet or from the component code tracked from the keyframe. On another scan, find the slice by scrolling the
oriented stack toward the shaft until the fibula separates.

## SAM prompt list

- **Request 1, the four big bones together:** femur (1), tibia (2), patella (3), fibula (4), one box each, even
  though only the first three are measured: the fibula box stops the tibia track from taking it.
- **Request 2, the small structures on their own:** labels 5 to 12, each with a box on the slice where its piece
  is largest and clear of the big bones, **one box per 3D piece** (label 6 needs two, label 9 three), trimmed with
  `trim_tracks.py` afterwards. Never add small structures to request 1: they cost the patella.

## Evidence limits

Everything above rests on one scan and, for the vision claims, 16 model calls. Vision models name bones correctly
on the keyframe and the 3D sheet, miss small errors on 2D overlays, and misname bones on off-joint slices.
Code checks (components, volumes, unlabelled components) come first.
