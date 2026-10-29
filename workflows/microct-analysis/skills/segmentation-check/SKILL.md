---
name: segmentation-check
description: >
  Load when you must accept, fix or hand on a labels volume (from SAM, a watershed or a correction): checks per label,
  finding unlabelled small structures, reading SAM-vs-classic disagreements, fixing labels, and raising To check items
  that point at the region.
---

# Segmentation check

SAM proposes, and you own the final labels. Code checks gate and your eyes confirm: run the checks in section 1 first,
then look at what they flag and at the 3D sheet (`visual-check`). Looking alone has missed a fragment carrying the wrong
label on a 2D slice. A labels volume leaves your task only after every label has passed the checks below, and every
disagreement you could not settle has been raised as a To check item that names the region. The workflow's anatomy reference
gives the label table and the expected volumes (`anatomy.json`). This skill gives the method. Resources are in
`<this skill>/resources/`; all inputs are on the scan grid.

## 1. Check each label

```
python label_stats.py --labels labels.npy --out qc/stats.json --ranges <the anatomy reference's anatomy.json>
```

Per label: voxels, volume in mm³, the number of 3D pieces and their sizes, the bounding box and the labels it touches.
With `--ranges` it flags a volume outside the range and a piece count that differs from the expected one. Pieces under
`--min-piece-mm3` (0.01) are counted as `specks`, not pieces: a clipped SAM label carries hundreds, and counting them would
flag every label. Look at the specks total if it is large. Then:

- **Read the flags literally.** With the workflow's `anatomy.json`, `label_stats.py` also flags a label that touches none of the
  neighbours the anatomy requires, within a small reach (`must_touch` and `touch_mm`: a fibula that is nowhere near the tibia is on
  the wrong bone, however good its volume). Treat it as a wrong seed or box and fix it (section 4); raise it as a To check item
  only if the CT leaves it open. The table's `piece_touches_edge` says which pieces reach the scan edge: data to read, not a flag.
- **A flag that says "not a <name>" (`identity_unsupported`) is a verdict on the piece, not on the structure.** Remove the
  label and look for the real structure (section 2).
- **One bone, one main piece.** A second large piece means the label is on two bones, or a bone has broken. Look at
  the 3D sheet. (Clipping can split a thin bone: check the pieces after `clip_to_bone.py` too.)
- **Volume inside the anatomy reference's range.** Unclipped SAM masks include soft tissue (`sam-segmentation`): clip first,
  then compare. The ranges come from one scan; a value just outside is a question,
  not an error.
- **No label on two bones.** On the quad view (`visual-check`), check each joint face: the boundary should run through the dark joint space, not
  through bone.
- **Nothing left over.** `unlabelled.py --hu hu.npy --labels labels.npy --out qc/cand.npy --threshold-hu <T>` lists bone pieces
  that no label covers (with a 0.02 mm rim around labels ignored, so the partial-volume skin does not join them). Each is a
  candidate small structure, or other anatomy: on OA6-1RK the four biggest candidates sit at the edge of the scan and are not
  part of the knee labels. A candidate touching the scan border is usually that.

## 2. Find and name the small structures

Sesamoids, joint mineralizations, ossicles and margin fragments decide measurements. A fragment merged into the femur inflates
the femur. For each candidate from `unlabelled.py`, or each piece `label_stats.py` flags:

1. Render its crop sheet and look: `render_crops.py --hu hu.npy --labels labels.npy --component-at <centre_zyx>`. Name it from
   the anatomy reference's table, or call it unknown.
2. Treat each 3D piece as its own component: a structure in two pieces needs one SAM box and one temporary label per piece (`sam-segmentation`).
3. Label it, either by relabelling the piece (`relabel.py --labels labels.npy --out fixed.npy --at z,y,x --to N --pieces
   qc/cand.npy`) or with a small-structure SAM request (`sam-segmentation`, steps 6-9, which starts from these candidates).
   Then look at the quad view again.
4. If you cannot name it, leave it unlabelled and raise a To check item that asks what it is. Do not borrow a name because
   a model offered one.

**Absent, or just not found.** Read `/outputs/intake/scan-notes.md` (`scan-intake`) before you name anything. A piece the data
does not support (`identity_unsupported`, or a position the anatomy table does not give) is not that structure: remove its label
(`relabel.py --at <its voxel> --to 0`, once for each piece; the piece then shows up in `unlabelled.py`; name it from the anatomy table if you can,
otherwise leave it unnamed) and look for the real one among the candidates and on the keyframe. Then:
- **Absent** when the notes say the structure is outside the field or cut off (overrule them only with a render that shows it,
  and say so in the checkpoint), or when you looked and no candidate sits where the anatomy puts it. Write the structure and
  the reason in the checkpoint.
- **Found**: label it as above.

Reporting an absent structure's outputs: `value: null` and the reason as the note when the structure is outside the field or cut
off (nothing could be measured). `0` with a note when its region is in the field and holds none (a healthy joint with no
ossification). Do not substitute a different piece to fill the output.

Raise a To check item when the notes and the CT disagree, or when the anatomy expects a structure, no candidate is there and the
notes say nothing. Not when the notes settle it.

## 3. Read SAM against a classic segmentation

`classic_segment.py --hu hu.npy --labels labels.npy --out qc/classic.npy --threshold-hu <T>` runs a seeded watershed inside
bone, seeded from the eroded core (0.05 mm) of each label, on the Gaussian gradient. It shares SAM's idea of which bone is
which, so it checks where boundaries run, **not identity**: a label on two bones stays on two bones. Identity errors are
caught by section 1 and the 3D sheet. It floods every bone voxel connected to a seed, so a bone that has no label (a fibula you did
not box, an unlabelled fragment) is absorbed by its neighbour: label every bone you want kept apart before you run it (on OA6-1RK,
classic labels grown from SAM's femur, tibia and patella alone agreed with the reference at Dice 0.92 / 0.90 / 0.92, against SAM's
0.97 / 0.95 / 0.94, for that reason). Then:

```
python disagree.py --hu hu.npy --labels labels.npy --classic qc/classic.npy --threshold-hu <T> --frame frame.json --names <anatomy.json> --out qc/disagree
```

It finds the bone voxels the classic method labels that your labels give to another label or to nothing, groups them into
3D regions, ranks them by size (floor 0.005 mm³), writes `disagreement.npy` (region ids, 1 = largest) and `regions.json`, and
renders a panel for the six largest. Pass `--ids 1,2,3` to look only at the big bones. For each region above the floor, look
at its panel and decide:

| You see | Do |
|---|---|
| One method's boundary runs through the joint space and the other's through bone | Keep the one in the joint space. Note it in the checkpoint. |
| A one-voxel rim of partial volume along the surface | Ignore it. Say so once for the whole label. |
| A fragment that is its own bone in one method and part of a big bone in the other | Treat it as a small structure (section 2): name it from the anatomy table, then give it its own label. |
| You cannot tell from the CT | Keep neither by default: raise a To check item, and say in it which label you kept meanwhile and why. |

Do not keep your label because it is yours, and do not take the classic one because it is the check. Use evidence that does not
come from either method. Each panel prints the region's assignment and size at the top ("region 2 (0.0056 mm3): yours = 1 femur,
classic = 8 lateral-sesamoid"): read that line first, then the tinted region in each half, which is the colour of the label that
side gave it. For a zoom on the region, use the panel, or `quad_view.py --center <region centre z,y,x> --names <anatomy.json> --zoom 4`;
`render_crops.py` takes a whole connected piece of bone, so on a region that touches a big bone it shows the big bone. Then the
3D sheet and the anatomy table.

**Compare volumes only when the region is a sizeable share of the smaller structure's range.** If the classic label is a structure
the table lists (a sesamoid) and the region is a large part of that structure's range, or would move the big bone's volume across
the edge of its range, the volume check decides it. A region far smaller than both ranges cannot: on OA6-1RK, region 2 (4,849 voxels,
0.006 mm³) is 0.1% of the femur's range width and 1.5% of the sesamoid's, so neither volume tells you anything, and the call
rests on the CT (the panel shows a separate bone beside the femur) and the anatomy table. Region 1 in the same run runs the other way
(yours = lateral-sesamoid, classic = femur, 0.01 mm³). A region you keep as it was, against the other method, needs the
reason written in the checkpoint; if the reason is only "the panel was unclear", it is the last row of the
table, and the region goes to the researcher as a To check item with `focus` on it.

Never average or vote. Settle a region on the anatomy, or hand it on. How much to expect: on OA6-1RK, an earlier validator
flagged 5.4% of the watershed's bone for SAM's labels (its own definition); `disagree.py` on the same run, big bones only,
flags 2.6%. So a large region is worth a To check item even when you keep
your label.

## 4. Fix

Choose the cheapest fix that addresses the cause:

- Wrong box or missing neighbour: fix the prompt and call `segment_sam` again. One rerun is normal; the limit on reruns is in
  `sam-segmentation`.
- A whole piece carries the wrong label: `relabel.py`.
- Two bones share one label across a contact: split them with a watershed restricted to that label,
  `classic_segment.py ... --within <label> --seeds seeds.json` (`{"<label>": [[z,y,x], ...]}`, one entry per part, a seed
  anywhere inside its part). The cut falls where the label pinches. On OA6-1RK it split a tibia label that had swallowed the
  fibula back to Dice 0.998 (tibia) and 0.987 (fibula).

After any fix, run the label checks and the quad view and 3D sheet looks again.

## 5. Hand on what you could not settle

Raise one To check item per region with `checkpoint`: `toCheck: {title, focus: {structureIds: [], annotationIds: [], volumeId:
<the disagreement labels volume output>, label: <region>}}` (both arrays are required). In the title, give the place and the
question ("Medial joint face, slices 140-170: femur or tibia?"). In the text, give both methods' labels and the one you kept.
Report `disagreement.npy` as a `volume` output of kind `labels` so the focus resolves.

## When you check a task

What a checker re-derives and opens for a task that made or used labels:

- Re-derive under `/scratch/recheck/`: `label_stats.py` and `unlabelled.py` on the worker's labels, and any distance or
  volume with `measure.py`.
- Open the 3D sheet, a quad view centred on the keyframe, and the crop of anything `unlabelled.py` found (`visual-check`).
- Causes to name for `needs-review`: a wrong box, a missing neighbour, a merged fragment, a label on two bones, a number out of
  range with no explanation, a result that cannot be traced to a file.

Your eyes are fallible on small things and on bone names away from the joint: confirm in code before you reject, and say
which of the two you relied on.
