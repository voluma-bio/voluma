---
name: segmentation-check
description: >
  Load when you must accept, fix or hand on a labels volume: the per-label checks and what each flag means, how a
  structure is found, named or declared absent, how to read SAM against a classic segmentation, and how a To check
  item points at a region.
---

# Segmentation check

SAM proposes; the task that submits the labels owns them. Code checks gate and eyes confirm: run `label_stats.py` and
`unlabelled.py` first, then look at what they flag and at the 3D sheet (`visual-check`). Looking alone has passed a
fragment carrying the wrong label. A labels volume is finished when every label passes the checks below and every
disagreement the CT could not settle is a To check item that names its region. The workflow's `anatomy.json`
holds the label table, the expected volumes and pieces, and which labels must touch which.

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

## 2. Find, name, or declare absent

Small structures (sesamoids, ossicles, fragments) decide measurements, and one merged into a big bone inflates it.
A finished labels volume accounts for each candidate from `unlabelled.py` and each piece `label_stats.py` flags:
seen on its crop sheet (`render_crops.py`), named from the anatomy table and labelled (`relabel.py`, or a
small-structure SAM request, `sam-segmentation`), or left unlabelled with a To check item asking what it is. A
structure in two pieces is two components, each labelled. A model's name for a piece is a guess.

The scan's notes come before any naming. A structure is **absent** when the notes put it
outside the field or cut off (overrule them only with a render you cite), or when no candidate sits where the
anatomy puts it after you looked; write the structure and the reason in the checkpoint, and report the structure as `{kind: "missing", reason}`. Its measurements: `null` with the
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

## 4. The fix for each cause

A wrong box or a missing neighbour: a new `segment_sam` request with the prompt fixed. A whole piece with the wrong
label: `relabel.py`. Two bones under one label: `classic_segment.py --within` with seeds. After any fix, the label
checks, the quad view and the 3D sheet again.

## 5. A To check item that points at the region

`checkpoint` with `toCheck: {title, focus: {on: [block ids], volumeId?, label?}}` (`on` required):
the title gives the place and the question ("Joint face, slices 140-170: bone A or bone B?"), the text both methods'
labels and the one kept. The focus resolves only when `disagreement.npy` is reported: run `disagree.py` with `--object-id` set to the id
the workflow declares for it, and pass its record's `objects` entry to `report_output`.
