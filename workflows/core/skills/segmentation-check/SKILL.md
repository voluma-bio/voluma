---
name: segmentation-check
description: >
  Load when you must accept, fix or hand on a labels volume: the per-label checks and what each flag means, how a
  structure is found, named or declared absent, how to read SAM against a classic segmentation, and how a To check
  item points at a region.
---

# Segmentation check

SAM proposes; whoever reports the labels owns them. Code checks gate and eyes confirm: run `label_stats.py` and
`unlabelled.py` first, both with `--ranges anatomy.json`, then look at what they flag and at the 3D sheet
(`visual-check`). Looking alone has passed a fragment carrying the wrong label. A labels volume is finished when you have made every correction below that you
can make, and each flag you looked at and could not correct, and each disagreement the CT could not settle, is a To
check item that names its region: then finish it with `finish_labels.py` (section 6), measure from the file it
writes, and report that file with its check record. The workflow's `anatomy.json` holds the label table, the expected
volumes and pieces, which labels must touch which, and which sit apart from which.

## 1. Each label

`label_stats.py --ranges anatomy.json` flags, per label:

| Flag | It means | The correction |
|---|---|---|
| volume above range | the label took bone from a neighbour | a piece wholly the neighbour's goes to it (`relabel.py`); two bones joined at a contact are split (`classic_segment.py --within <label> --seeds`, one seed per connected piece of each part, the contact piece included) |
| volume below range | it lost bone to a neighbour that is above | the pair is corrected together |
| `identity_unsupported` (far below range) | the box found a different piece, or a sliver | not that structure: the label is removed (`relabel.py --to 0`) and the real one looked for (section 2) |
| extra pieces | bone that is not this structure | seen on the 3D sheet; cleared so `unlabelled.py` finds it, or given its own label when it can be named |
| touches none of its required neighbours | the label is on the wrong bone, however good its volume | re-boxed or re-seeded on the right bone |

Pieces under `--min-piece-mm3` are specks, not pieces: a clipped SAM label carries hundreds. The ranges come from
one scan, so a value just outside is a question, not an error. On the quad view, each joint face's boundary should
run through the dark joint space, not through bone. `unlabelled.py` lists bone no label covers: each piece is a
candidate small structure or other anatomy (one touching the scan border is usually other anatomy).

`unlabelled.py --ranges anatomy.json` grows every label and every candidate through the threshold bone it reaches
and flags what is joined through bone: a contact patch over the tolerance. A volume in range and no contact in `neighbour_voxels` prove nothing here: a small label holding
a bone's cortex passed both, with a strip of bone no label covers between it and the bone.

| Flag | It means | The correction |
|---|---|---|
| `<label> is joined to <bone> through bone` | a small structure the anatomy puts across joint space (`apart_from`) shares bone with a big bone over a patch above the tolerance, directly or through bone no label covers: one label holds the other's bone | open the patch at the voxel given; give each bone's voxels to its own label (`classic_segment.py --within` with seeds, `relabel.py` for a piece apart), or redo the structure's SAM track (`sam-segmentation`, "When a track fails") or write your own cleanup and show it on a crop sheet; then run it again. A joint mineralization or sesamoid ends apart from the bone; no fused-osteophyte allowance. Where the CT shows no gap at threshold, split at the narrowest bone between them (`--within` cuts where the label pinches). Fixed, never accepted |
| `<bone> is joined to <bone> through bone`, two big bones (the femur and the tibia or the patella) | one big track took the other bone's bone, or one label is threshold bone the others left over; the next step's frame trips over it (the tibia's joint end reads as a femur's) | split it: `classic_segment.py --within <label>` with seeds from each bone's core, the joined piece included; or redo the big-bone request (`sam-segmentation`, "When a track fails"). Never set a bone to the threshold bone the other labels left. Where bone bridges the joint at threshold (OA can), split at the joint line all the same. Fixed, never accepted |
| `candidate <n> ... joined through bone to a big bone` | bone no label covers that touches a big bone over a patch above the tolerance: the big label missed part of its own bone (or other anatomy touches it) | open it; the bone's own bone goes to that label (`relabel.py --pieces`); never name it a small structure while it is fused |

The tolerance (`--contact-mm2`, 0.011 mm2: 100 voxel faces at 10.5 um) is partial volume closing a narrow joint gap:
good structures measure at most 0.006 mm2, as labels or as candidates, and bone cut off a label 0.24 to 1.28 mm2; good
femur and tibia labels at most 0.0034 mm2, and a tibia that was threshold remainder 0.31 mm2.
`fused_to` on each candidate gives its largest contact patch with each label it touches.

## 2. Find, name, or declare absent

Small structures (sesamoids, ossicles, fragments) decide measurements, and one merged into a big bone inflates it.
A finished labels volume accounts for each candidate from `unlabelled.py` and each piece `label_stats.py` flags:
seen on its crop sheet (`render_crops.py`), named from the anatomy table and labelled (`relabel.py`, or a
small-structure SAM request, `sam-segmentation`), or left unlabelled with a To check item asking what it is. A
candidate becomes a label only when it has no contact patch with a big bone over the tolerance (it is not in `fused`) and its crop shows it apart from
the bone across joint space; it never stands in for a structure whose SAM track failed (redo that track). A
structure in two pieces is two components, each labelled. A model's name for a piece is a guess.

The scan's notes come before any naming. A structure is **absent** when the notes put it
outside the field or cut off (overrule them only with a render you cite), or when no candidate sits where the
anatomy puts it after you looked; record the structure as absent, with the reason and the view it rests on. Its
measurements: outside the field or cut off, they can't be measured, which is not zero; in the field with none in its
region, they are 0, with a note. Your role says who records an output as missing, and how. Never substitute a look-alike piece to fill an output. Raise a To check item when the notes and the
CT disagree, or when the anatomy expects a structure, none is there and the notes say nothing.

## 3. SAM against a classic segmentation

`classic_segment.py` runs a seeded watershed inside the bone threshold, seeded from your labels' cores. It shares
your idea of which bone is which, so it checks **where boundaries run, not identity**; it floods every bone voxel
connected to a seed, so label every bone you want kept apart before you run it. `disagree.py` ranks the regions
where the two differ and renders a panel for the largest; run it with `--object-id` set to the id the workflow
declares for the disagreement volume and report its record's `objects` entry, settled or not. For each region above
the floor:

| You see | Do |
|---|---|
| one boundary through the joint space, the other through bone | keep the one in the joint space; note it in your report |
| a one-voxel rim of partial volume along a surface | ignore it; say so once per label |
| a fragment that is its own bone in one method and part of a big bone in the other | a small structure (section 2) |
| a region that is a large share of one of your labels (`your_label_pct`) | not a rim: most of that label is in question; settle it as a boundary or an identity before you keep the label |
| you cannot tell from the CT | keep neither by default: a To check item naming which label you kept meanwhile |

Volumes decide only when the region is a sizeable share of the smaller structure's range, or would move a big bone
across the edge of its range; a region far smaller than both ranges rests on the CT and the anatomy table. Never
average or vote.

## 4. The fix for each cause

A wrong box or a missing neighbour: a new `segment_sam` request with the prompt fixed. A whole piece with the wrong
label: `relabel.py`. Two bones under one label: `classic_segment.py --within` with seeds. A piece the researcher outlined as not part of a
region: a seed inside it from `marks_to_grid.py --seed --voxels "<the delivery's line>" --drawn-on <the image it was drawn on>` (`regions-and-landmarks`), then `relabel.py` for a piece apart from the
bone, or `classic_segment.py --within` for one joined to it; the script says which. Give the piece the label of what it
is, or 0 when it is no structure the workflow reports. After any fix, the label
checks, the quad view and the 3D sheet again.

## 5. A To check item that points at the region

The title gives the place, the question and the label kept ("Joint face, slices 140-170: bone A or bone B? Kept A").
Point its focus at the disagreement volume and the region's label, so the researcher's view opens there: the volume is
always reported (section 3).

## 6. Finish and report

`finish_labels.py` is the last step before the labels are reported, run on the volume you would report: it clears the
specks (the loose fragments a clipped label leaves, dots off the bone in 3D), runs the checks of sections 1 and 2 on the
cleaned volume, and writes it with a check record (`<out stem>-check.json`) only when no flag is open. A flag stays
open until the labels no longer raise it or you pass `--accept <key>=<why>`: the title of the To check item that holds
it when the CT cannot settle it, or why it is no fault (a structure the scan's notes put outside the field, or one you recorded as absent in its
region, section 2). A `joined:` or `fused:` flag is never accepted (the script refuses it): one label holds another
bone's bone, which a split at the contact or a redone track always fixes (section 1). Finish the labels you made, the
merged SAM labels with your fixes; `classic_segment.py`'s watershed is the cross-check of section 3, never the reported
labels (the script refuses it): it gives every threshold voxel to some label, so bones that touch at threshold always join.
Report the file it wrote and cite the check record as evidence; checks you ran on another volume (a watershed, an
earlier merge) are not this volume's. After any later change to the labels, run it again.
