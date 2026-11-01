# Mouse knee anatomy

This is the mouse-OA workflow's anatomy: the label ids you write, the numbers `segmentation-check` compares
against, and what is still unknown. Every number comes from one scan (OA6-1RK, spacing 0.0105 mm isotropic): treat
it as n=1. The ranges are widened guesses, not population ranges. A volume outside a range is a reason to look,
not proof of a wrong label. `anatomy.json` beside this file is the machine-readable table.

## Scan settings

| Item | Value | Where it is used |
|---|---|---|
| Display window | 1000 to 8000 HU | orient, keyframe and quad view renders, box drawing (the same window the orientation step used) |
| Segmentation threshold | 2500 HU (`segmentation_threshold_hu` in `anatomy.json`) | `--threshold-hu` of `orient_joint`, `snap_boxes`, `clip_to_bone`, `unlabelled`, `classic_segment`, `disagree`; it builds masks and is **not** the BV threshold |
| Measurement threshold | the lab's 2.16/cm, computed from `hu.json` (2459.875 HU on OA6-1RK) | every BV, BV/TV and TV script computes it; see `microct-core` |
| Voxel | read it from `hu.json` (`spacing_zyx_mm`) | never hard-code 0.0105 |
| Orientation sizes | `--shaft-radius-mm 1.2 --ref-radius-mm 3.15 --min-object-mm3 0.0035` | `orient_joint` (`orient-joint`): a mouse femur shaft is under 1.2 mm in radius, the patella sits within 3.15 mm of the joint |

## Orienting the knee

In `orient-joint` terms the reference object is the patella and bone A is the femur (the patella sits on it). The keyframe cuts
femur and tibia through the joint, and the patella when it is in the field (`examples/README.md` in the skill directory, orientation). A field of the bone ends only has no shaft, and a tibia cut to a short stub can fall under
`--second-bone-frac`. When the notes put the patella outside the field, a piece taken for the reference object is something
else (the fibula head, say): it is harmless to the cut but sets the side of the slice.

## Label table

`anatomy.json` has `labels[]` with `id`, `name`, `volume_mm3 [lo, hi]`, `components` (expected number of 3D pieces) and
`notes`; `label_stats.py --ranges` reads it.

| Id | Name | OA6-1RK reference (mm3, pieces) | Range in anatomy.json |
|---|---|---|---|
| 1 | femur | 8.395, 1 | 6.30 to 10.91 |
| 2 | tibia | 7.044, 1 | 5.28 to 9.16 |
| 3 | patella | 1.276, 1 | 0.96 to 1.66 |
| 4 | fibula | 0.992, 1 | 0.74 to 1.29 |
| 5 | medial-joint-mineralization (the reference's name, unconfirmed) | 0.286, 1 | 0.11 to 0.57 |
| 6 | lateral-joint-mineralization | 0.411, 2 | 0.16 to 0.82 |
| 7 | medial-sesamoid | 0.275, 1 | 0.11 to 0.55 |
| 8 | lateral-sesamoid | 0.229, 1 | 0.09 to 0.46 |
| 9 | anterior-joint-mineralization | 0.217, 3 | 0.09 to 0.43 |
| 10 | anterior-tibial-margin-fragment | 0.076, 1 | 0.03 to 0.15 |
| 11 | lateral-tibial-margin-fragment | 0.051, 1 | 0.02 to 0.10 |
| 12 | proximal-patellar-ossification | 0.121, 1 | 0.05 to 0.24 |

The reference volumes are from a watershed on the 2500 HU threshold. Unclipped SAM masks run over the reference and trimmed
small SAM tracks run under it (`sam-segmentation`); the ranges hold both, but say which you used when you report a small volume.

Names for labels 5 to 12 are the reference run's working names. The reference marked its own review as preliminary: none of
them is lab-confirmed or anatomically checked. Use the names as given; do not rename on your own.

## Structures can be missing from the field

The table above lists what a complete knee holds. A scan may not image all of it: a field of the bone ends only can leave out
the patella, and a young or healthy joint may have none of the joint mineralizations. Take what is present from the scan's
notes (`/outputs/intake/scan-notes.md`) and the keyframe, not from this table. A patella is a large bone (about 1 mm³) in
front of the femur, in the trochlear groove; a small piece near the joint is a sesamoid or a fragment, whatever its box was
called (in a field with no patella, the medial sesamoid, 0.06 mm³, was boxed as "patella"). What to do when a structure is
missing: `segmentation-check`, section 2.

## Where each structure sits and how to find it

Centroids are in scan voxel indices (z, y, x) on OA6-1RK. On that scan the long axis is z (joint end of the tibia at about z
400, the femur above it), lateral is low y (the fibula centroid is at y 180, the patella near y 310, the tibia at y 312), and
the patella is anterior (low x). A scan with another orientation will differ: find the structure on the keyframe, do not look
it up by index.

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

The small structures are blobs a few tens of voxels across, easy to miss on the keyframe or to take for part of a big bone;
a merged one shows on the 3D sheet as a bump or a disconnected piece. How to look and what the models get wrong: `visual-check`.

## Open questions for the lab (do not settle them yourself)

1. **Label 5.** The lab's working reading is that label 5 (position and shape) fits the **medial meniscus with its
   osteophytes**, which is how deck #3 uses it (see the protocol reference); that is not anatomically checked. The
   reference's name for it is "medial-joint-mineralization", which is the reference's name and unconfirmed; one of the two
   vision models also called it a fabella. Keep the label name `medial-joint-mineralization` in `anatomy.json` and the label
   table, say in any report that the identity is an open question, and raise a To check item if a measurement depends on it.
   Labels 7 and 8 sit where fabellae are expected; that is also not checked.
2. **Label 6** (lateral, two pieces) is deck #2's lateral meniscus with osteophytes in the same working reading, and **label 9**
   has the same status as the names above: a reference working name, not confirmed.
3. **Which labels count toward a side.** Whether label 9's pieces and the tibial margin fragments (labels 10, 11) belong to a
   side's meniscus-and-osteophyte volume is open; the scripts count only labels 5 and 6 until the lab says.
4. **Labels 10 to 12:** keep separate. Whether they belong to the tibia or patella volumes is the lab's call. Whether label 12
   counts toward the patella (#1) is open.

## Segmentation notes

How `sam-segmentation`'s general strategies play out on the mouse knee. On OA6-1RK, small structures sent in the
big-bone request cost the patella its track (Dice with the reference 0.95 to 0.86).

- **Request 1, the four big bones together:** femur (1), tibia (2), patella (3), fibula (4), one box each, even though only the
  first three are measured: the fibula box stops the tibia track from taking it. Put the fibula box on a slice where it is
  separate from the tibia: on OA6-1RK, oriented-stack slice 340 (a tibia plus fibula slice with no patella). That slice is not
  the keyframe, so name the fibula from the 3D sheet or from the component tracked from the keyframe. On another scan, scroll
  the oriented stack toward the shaft until the fibula separates.
- **Request 2, the small structures on their own** (`sam-segmentation`, small structures): labels 5 to 12, found as candidates, with
  one temporary label per 3D piece (label 6 has two pieces, label 9 three).
