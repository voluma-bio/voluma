"""Find bone no label covers, and bone that joins a small structure to a big bone.

Candidates are the 26-connected pieces of (bone at or above `--threshold-hu`, with no label within `--rim-mm` of it) at
least `--min-mm3` big. The rim keeps the partial-volume skin around a labelled bone from joining them into one piece. Open
each candidate with `render_crops.py --component-at <centre_zyx>`, name it from the anatomy reference, then label it
(`relabel.py`) or raise a To check item.

Every label and every candidate grows through the bone it reaches: a 6-connected flood over threshold bone, each voxel to
the seed that gets there first. Label pieces under `--min-mm3` seed nothing, so the specks a clip leaves on a neighbour's
surface grow no contact. Two grown seeds are in contact where their bone shares voxel faces; the contact measure is the
largest 26-connected patch of those faces, in mm2. A sesamoid across a joint gap that partial volume closes touches its
bone over a small patch; bone cut off a label by the candidate rim (a bone's cortex under a small label) touches it over
the whole cut. A candidate's `fused_to` is {label: its largest contact patch with that label, mm2}.

With `--ranges` (the anatomy reference's anatomy.json), two flags, read from the optional per-label key
`apart_from: [ids]` (a small structure the anatomy puts across joint space or cartilage, below threshold, from those bones);
both flag a contact patch over `--contact-mm2`:
- `joined`: the grown label and a grown `apart_from` bone: they are joined through bone, directly or through bone no label
  covers. Per pair: the contact (largest patch, total), how much of it is labelled on both sides (`direct`), and a voxel in
  the largest patch.
- `fused`: a candidate and a big bone (any id some label lists in `apart_from`): bone that big label missed, or other
  anatomy touching it, never a small structure while it is fused. Per candidate: each big bone's contact over the tolerance.

Writes: <out>  uint16 volume on the grid of --labels, each candidate its id (1 = largest), with its sidecar
Prints: one JSON line {candidates, count, top, joined, fused, flags}; top is the 12 largest, each {id, voxels, volume_mm3,
  centre_zyx (a voxel inside it), bbox_zyx, fused_to}; with --ranges, joined (every pair in contact), fused (each flagged
  candidate's patch) and flags
Example: python unlabelled.py --hu hu.npy --labels labels.npy --out cand.npy --threshold-hu scan-settings.json --ranges anatomy.json
Exits 2 with one sentence on bad input, before writing anything.
"""
import json
from pathlib import Path

import numpy as np
import sidecar
from classic_segment import grow
from scipy import ndimage as ndi
from skimage.measure import label as connected_regions

CONN26 = np.ones((3, 3, 3))
# Largest contact patch tolerated between a small structure and a big bone, mm2 (today's 100 voxel faces at 10.5 um). Good
# structures, where a joint gap closed by partial volume is the only contact: at most 0.0055 as labels on OA6-1RK (run
# 3fc56eec, label 6 on the femur) and 0.0024 on OA6-2RK (4df02afe, label 5 on the femur), 0.0061 as candidates (OA6-1RK
# with labels 6, 7, 8 or 12 removed: label 6's larger piece on the femur). A small label or candidate holding a big bone's
# surface: 0.24 to 1.28 (4df02afe labels 6 and 7, and label 6's piece as a candidate). Two scans: OA narrows the joint gap.
DEFAULT_CONTACT_MM2 = 0.011


def inside_voxel(mask, offset):
    """A voxel inside `mask` near its middle (a centroid can fall outside a ring), in the coordinates `offset` shifts to."""
    pts = np.argwhere(mask)
    return (pts[len(pts) // 2] + offset).tolist()


def grow_seeds(seeds, bone, min_vox):
    """Each seed id flooded through `bone`, 6-connected, from its pieces of at least `min_vox` voxels (cleared from `seeds`);
    0 where none reaches."""
    grown = np.zeros_like(seeds)
    if not seeds.any():
        return grown
    box = ndi.find_objects((seeds > 0).astype(np.uint8))[0]
    lab = seeds[box]
    # before grow's own arrays exist: the int64 regions and the watershed's 13 bytes per voxel never hold memory at once
    regions = connected_regions(lab, connectivity=3, background=0)
    small = np.bincount(regions.ravel()) < min_vox
    small[0] = False
    lab[small[regions]] = 0
    del regions

    def build(out, flood):
        out[...] = lab
        flood[...] = bone[box] | (lab > 0)

    grown[box] = grow(grown[box].shape, build, lambda image: None)  # a flat elevation: first to arrive wins
    return grown


def contact(grown, labels, bone, s, b, box, face_mm2):
    """Where grown `s` and grown `b` share voxel faces, both bone, inside `box` (grown `s`, padded by one): the largest
    26-connected patch of `s`'s voxels on those faces and the total, in mm2, how much of it is labelled on both sides, and
    a voxel in the largest patch. None without contact."""
    g, lab, bn = grown[box], labels[box], bone[box]
    mine, theirs = (g == s) & bn, (g == b) & bn
    side = np.zeros(g.shape, bool)
    direct = np.zeros(g.shape, bool)
    for ax in range(3):
        n = g.shape[ax]
        for here, there in ((slice(0, n - 1), slice(1, n)), (slice(1, n), slice(0, n - 1))):
            h = tuple(here if k == ax else slice(None) for k in range(3))
            t = tuple(there if k == ax else slice(None) for k in range(3))
            face = mine[h] & theirs[t]
            side[h] |= face
            direct[h] |= face & (lab[h] == s) & (lab[t] == b)
    if not side.any():
        return None
    patches, _ = ndi.label(side, CONN26)
    sizes = np.bincount(patches.ravel())
    sizes[0] = 0
    big = int(sizes.argmax())
    return {'largest_patch_mm2': round(float(sizes[big]) * face_mm2, 5), 'mm2': round(float(side.sum()) * face_mm2, 5),
            'direct_mm2': round(float(direct.sum()) * face_mm2, 5), 'voxel_zyx': inside_voxel(patches == big, [t.start for t in box])}


def padded_box(i, boxes):
    return tuple(slice(max(0, t.start - 1), t.stop + 1) for t in boxes[i - 1])


if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--hu', type=sidecar.existing, required=True, help='hu.npy of the scan')
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='label volume .npy on the scan grid, with its sidecar beside it')
    ap.add_argument('--out', required=True, help='candidate volume .npy to write')
    ap.add_argument('--threshold-hu', type=sidecar.threshold_arg, required=True, help='voxels at or above it are bone: the scan\'s segmentation threshold: its scan-settings.json, or a number in HU')
    ap.add_argument('--min-mm3', type=float, default=0.01, help='mm3: smallest candidate kept, and smallest label piece that seeds the flood')
    ap.add_argument('--rim-mm', type=float, default=0.02, help='mm: bone this close to any label is not a candidate (at least 1 voxel)')
    ap.add_argument('--ranges', type=sidecar.existing, help='the anatomy reference\'s anatomy.json: which labels sit apart from which bones (apart_from)')
    ap.add_argument('--contact-mm2', type=float, default=DEFAULT_CONTACT_MM2,
                    help='mm2: largest contact patch tolerated between a small structure and a bone it sits apart from (partial volume across a narrow gap)')
    a = ap.parse_args()
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels)
    if hu.shape != labels.shape:
        sidecar.fail(f'hu {hu.shape} and labels {labels.shape} are on different grids: map the labels to the scan first')
    expected = {e['id']: e for e in json.loads(Path(a.ranges).read_text())['labels']} if a.ranges else {}
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    vox = float(np.prod(sp))
    face_mm2 = vox ** (2 / 3)
    min_vox = a.min_mm3 / vox
    rim = max(1, round(a.rim_mm / sp[0]))
    bone = np.zeros(hu.shape, bool)
    free = np.zeros(hu.shape, bool)  # bone no label is within the rim of
    step = 64  # z-chunks (with a halo of `rim` slices, which keeps the dilation exact) spare full-volume float and boolean copies
    for z0 in range(0, hu.shape[0], step):
        bone[z0:z0 + step] = hu[z0:z0 + step] >= a.threshold_hu
        lo, hi = max(0, z0 - rim), min(hu.shape[0], z0 + step + rim)
        d = ndi.binary_dilation(labels[lo:hi] > 0, iterations=rim)
        free[z0:z0 + step] = bone[z0:z0 + step] & ~d[z0 - lo:z0 - lo + min(step, hu.shape[0] - z0)]
    shape = hu.shape
    del d, hu  # unmaps the HU file, whose pages otherwise stay resident
    pieces, n = ndi.label(free, CONN26)
    del free
    sizes = np.bincount(pieces.ravel())
    sizes[0] = 0
    keep = [int(i) for i in np.argsort(-sizes) if sizes[i] >= min_vox and sizes[i] > 0]
    objs = ndi.find_objects(pieces)
    out = np.zeros(shape, np.uint16)
    cands = []
    for rank, i in enumerate(keep, 1):
        sl = objs[i - 1]
        m = pieces[sl] == i
        out[sl][m] = rank
        cands.append({'id': rank, 'voxels': int(sizes[i]), 'volume_mm3': round(float(sizes[i]) * vox, 4),
                      'centre_zyx': inside_voxel(m, [s.start for s in sl]), 'bbox_zyx': [[int(s.start), int(s.stop)] for s in sl]})
    del pieces, objs
    np.save(a.out, out)
    # the candidate volume becomes the seeds: candidate k as base + k, the labels beside them (the rim keeps the two apart)
    base = int(labels.max())
    out[out > 0] += base
    out += labels
    grown = grow_seeds(out, bone, min_vox)
    del out
    boxes = ndi.find_objects(grown)
    for c in cands:
        box = padded_box(c['id'] + base, boxes)
        touched = np.unique(grown[box])
        c['fused_to'] = {}
        for b in touched[(touched > 0) & (touched <= base)]:
            t = contact(grown, labels, bone, c['id'] + base, int(b), box, face_mm2)
            if t:
                c['fused_to'][int(b)] = t

    report = {}
    if a.ranges:
        flags, joined = [], []
        name = {lv: e['name'] for lv, e in expected.items()}
        for s, e in sorted(expected.items()):
            if s > len(boxes) or boxes[s - 1] is None:
                continue
            box = padded_box(s, boxes)
            for b in e.get('apart_from', []):
                c = contact(grown, labels, bone, s, b, box, face_mm2)
                if c is None:
                    continue
                joined.append({'label': s, 'bone': b, **c})
                if c['largest_patch_mm2'] > a.contact_mm2:
                    through = 'directly' if c['direct_mm2'] * 2 > c['mm2'] else 'mostly through bone no label covers'
                    flags.append(
                        f'{s} {name[s]} is joined to {b} {name.get(b, "")} through bone, {through}: a contact patch of '
                        f'{c["largest_patch_mm2"]} mm2 ({c["mm2"]} in all, tolerance {a.contact_mm2:g}) at {c["voxel_zyx"]}. '
                        f'The anatomy puts it across joint space from the {name.get(b, b)}, so one label holds the other\'s bone: '
                        f'open it there, give each bone\'s voxels to its own label (classic_segment.py --within {s} or --within {b} '
                        f'with seeds; relabel.py for a piece apart), or redo the structure (a tight segment_sam box with negative points on the '
                        f'{name.get(b, b)}) or write your own cleanup and show it on a crop sheet; then run this again. Label {s} must end '
                        f'apart from label {b}; a threshold candidate is never its label by itself. If the CT shows no gap between them at '
                        f'threshold there, keep the labels and raise a To check item naming the patch')
        bigs = {b for e in expected.values() for b in e.get('apart_from', [])}
        fused = []
        for c in cands:
            over = {b: t for b, t in c['fused_to'].items() if b in bigs and t['largest_patch_mm2'] > a.contact_mm2}
            if not over:
                continue
            fused.append({'id': c['id'], 'patches': over})
            at = '; '.join(f'{b} {name.get(b, "")}: a contact patch of {t["largest_patch_mm2"]} mm2 ({t["mm2"]} in all) at {t["voxel_zyx"]}'
                           for b, t in sorted(over.items(), key=lambda bt: -bt[1]['largest_patch_mm2']))
            flags.append(f'candidate {c["id"]}, {c["volume_mm3"]} mm3 at {c["centre_zyx"]}, is bone no label covers joined through '
                         f'bone to a big bone (tolerance {a.contact_mm2:g} mm2): {at}. Open it (render_crops.py --component-at): a big '
                         f'bone\'s own bone goes to that label (relabel.py --pieces {a.out} --at {",".join(map(str, c["centre_zyx"]))} '
                         '--to <id>); while it is fused it is not a small structure to name or label, even when a SAM track for that '
                         'structure failed; other anatomy stays unlabelled')
        report = {'joined': joined, 'fused': fused, 'flags': flags}
    sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.hu, a.labels],
                  params={'threshold_hu': a.threshold_hu, 'min_mm3': a.min_mm3, 'rim_mm': a.rim_mm, 'rim_vox': rim,
                          'contact_mm2': a.contact_mm2})
    sidecar.emit(candidates=a.out, count=len(cands), top=cands[:12], **report)
