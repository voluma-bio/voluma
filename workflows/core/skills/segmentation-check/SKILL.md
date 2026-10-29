---
name: segmentation-check
description: >
  Load when you must accept, fix or hand on a labels volume: the per-label checks and what each flag means, how a
  structure is found, named or declared absent, how to read SAM against a classic segmentation, and how a To check
  item points at a region.
---

# Segmentation check

SAM proposes; you own the final labels. Code checks gate and your eyes confirm: run `label_stats.py` and
`unlabelled.py` first, then look at what they flag and at the 3D sheet (`visual-check`). Looking alone has passed a
fragment carrying the wrong label. A labels volume leaves your task when every label passes the checks below and
every disagreement you could not settle is a To check item that names its region. The workflow's `anatomy.json`
holds the label table, the expected volumes and pieces, and which labels must touch which.

## 1. Each label

`label_stats.py --ranges anatomy.json` flags, per label:

| Flag | It means | Do |
|---|---|---|
| volume above range | the label took bone from a neighbour | a piece wholly the neighbour's: `relabel.py --to <neighbour>`; two bones joined at a contact: `classic_segment.py --within <label> --seeds`, one seed per connected piece of each part, the contact piece included |
| volume below range | it lost bone to a neighbour that is above | fix the pair together |
| `identity_unsupported` (far below range) | the box found a different piece, or a sliver | not that structure: remove the label (`relabel.py --to 0`) and look for the real one (section 2) |
| extra pieces | bone that is not this structure | look at it on the 3D sheet; clear it so `unlabelled.py` finds it, or give it its own label when you can name it |
| touches none of its required neighbours | the label is on the wrong bone, however good its volume | re-box or re-seed it on the right bone |

Pieces under `--min-piece-mm3` are specks, not pieces: a clipped SAM label carries hundreds. The ranges come from
one scan, so a value just outside is a question, not an error. On the quad view, each joint face's boundary should
run through the dark joint space, not through bone. `unlabelled.py` lists bone no label covers: each piece is a
candidate small structure or other anatomy (one touching the scan border is usually other anatomy).

## 2. Find, name, or declare absent

Small structures (sesamoids, ossicles, fragments) decide measurements, and one merged into a big bone inflates it.
For each candidate from `unlabelled.py` or piece `label_stats.py` flags: render its crop sheet (`render_crops.py`),
name it from the anatomy table or call it unknown, and label it (`relabel.py`, or a small-structure SAM request,
`sam-segmentation`). A structure in two pieces is two components, each labelled. One you cannot name stays
unlabelled, with a To check item asking what it is: a model's name for it is a guess.

Read `/outputs/intake/scan-notes.md` before you name anything. A structure is **absent** when the notes put it
outside the field or cut off (overrule them only with a render you cite), or when no candidate sits where the
anatomy puts it after you looked; write the structure and the reason in the checkpoint. Its outputs: `null` with the
reason when nothing could be measured (outside the field, cut off); `0` with a note when its region is in the field
and holds none. Never substitute a look-alike piece to fill an output. Raise a To check item when the notes and the
CT disagree, or when the anatomy expects a structure, none is there and the notes say nothing.

## 3. SAM against a classic segmentation

`classic_segment.py` runs a seeded watershed inside the bone threshold, seeded from your labels' cores. It shares
your idea of which bone is which, so it checks **where boundaries run, not identity**; it floods every bone voxel
connected to a seed, so label every bone you want kept apart before you run it. `disagree.py` ranks the regions
where the two differ and renders a panel for the largest. For each region above the floor:

| You see | Do |
|---|---|
| one boundary through the joint space, the other through bone | keep the one in the joint space; note it in the checkpoint |
| a one-voxel rim of partial volume along a surface | ignore it; say so once per label |
| a fragment that is its own bone in one method and part of a big bone in the other | a small structure (section 2) |
| you cannot tell from the CT | keep neither by default: a To check item naming which label you kept meanwhile |

Volumes decide only when the region is a sizeable share of the smaller structure's range, or would move a big bone
across the edge of its range; a region far smaller than both ranges rests on the CT and the anatomy table. Never
average or vote.

## 4. Fix, then check again

The cheapest fix that addresses the cause: a wrong box or missing neighbour, fix the prompt and call `segment_sam`
again; a whole piece with the wrong label, `relabel.py`; two bones under one label, `classic_segment.py --within`
with seeds. After any fix, run the label checks and look at the quad view and the 3D sheet again.

## 5. A To check item that points at the region

`checkpoint` with `toCheck: {title, focus: {structureIds, annotationIds, volumeId, label}}` (both arrays required):
the title gives the place and the question ("Joint face, slices 140-170: bone A or bone B?"), the text both methods'
labels and the one you kept. Report `disagreement.npy` as a `volume` output of kind `labels` so the focus resolves
to it.
