"""Find bone no label covers, and bone that joins a small structure to a big bone.

Candidates are the 26-connected pieces of (bone at or above `--threshold-hu`, with no label within `--rim-mm` of it) at
least `--min-mm3` big. The rim keeps the partial-volume skin around a labelled bone from joining them into one piece. Open
each candidate with `render_crops.py --component-at <centre_zyx>`, name it from the anatomy reference, then label it
(`relabel.py`) or raise a To check item.

Every label also grows through the bone it reaches: a 6-connected flood over threshold bone from the labels, each voxel to
the label that gets there first. Label pieces under `--min-mm3` seed nothing, so the specks a clip leaves on a neighbour's
surface grow no contact. A candidate's `fused_to` is {label: mm3 of the candidate that label's flood took}: a candidate
fused to the tibia is bone the tibia label missed, not a small structure to name.

With `--ranges` (the anatomy reference's anatomy.json), two flags, read from the optional per-label key
`apart_from: [ids]` (a small structure the anatomy puts across joint space or cartilage, below threshold, from those bones):
- `joined`: the grown label and a grown `apart_from` bone share bone faces in one patch of more than `--contact-voxels`
  voxels: they are joined through bone, directly or through bone no label covers. Per pair: the contact voxels (largest
  patch, total), how many of them are labelled on both sides (`direct`), and a voxel in the largest patch.
- `fused`: the candidates a big bone's flood reaches (a big bone is any id some label lists in `apart_from`): bone a big
  label missed, or other anatomy touching it, never a small structure while it is fused.

Writes: <out>  uint16 volume on the grid of --labels, each candidate its id (1 = largest), with its sidecar
Prints: one JSON line {candidates, count, top, joined, fused, flags}; top is the 12 largest, each {id, voxels, volume_mm3,
  centre_zyx (a voxel inside it), bbox_zyx, fused_to}; with --ranges, joined (every pair in contact), fused (candidate ids) and
  flags
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
# Largest contact patch tolerated between a small structure and a big bone, in voxels (0.0105 mm grid). Good labels, where
# a joint gap closed by partial volume is the only contact: 50 at most on OA6-1RK (run 3fc56eec, label 6 on the femur), 22
# on OA6-2RK (4df02afe, label 5 on the femur). A small label holding a big bone's surface: 2208 to 11572 (4df02afe labels 6
# and 7). Scale with the voxel size.
DEFAULT_CONTACT_VOXELS = 100


def inside_voxel(mask, offset):
    """A voxel inside `mask` near its middle (a centroid can fall outside a ring), in the coordinates `offset` shifts to."""
    pts = np.argwhere(mask)
    return (pts[len(pts) // 2] + offset).tolist()


def grow_labels(labels, bone, min_vox):
    """Each label flooded through `bone`, 6-connected, from its pieces of at least `min_vox` voxels; 0 where none reaches."""
    grown = np.zeros_like(labels)
    if not labels.any():
        return grown
    box = ndi.find_objects((labels > 0).astype(np.uint8))[0]

    def build(seeds, flood):
        lab = labels[box]
        regions = connected_regions(lab, connectivity=3, background=0)
        small = np.bincount(regions.ravel()) < min_vox
        small[0] = False
        seeds[...] = np.where(small[regions], 0, lab)
        del regions
        flood[...] = bone[box] | (seeds > 0)

    grown[box] = grow(grown[box].shape, build, lambda image: None)  # a flat elevation: first to arrive wins
    return grown


def contact(grown, labels, bone, s, b, box):
    """Voxels of grown `s` that share a face with grown `b`, both bone, inside `box` (grown `s`, padded by one)."""
    g, lab, bn = grown[box], labels[box], bone[box]
    side = np.zeros(g.shape, bool)
    direct = np.zeros(g.shape, bool)
    mine = (g == s) & bn
    for ax in range(3):
        for sh in (1, -1):
            nb = np.roll(g, sh, ax) == b
            nb &= np.roll(bn, sh, ax)
            side |= mine & nb
            direct |= mine & nb & (lab == s) & (np.roll(lab, sh, ax) == b)
    if not side.any():
        return None
    patches, _ = ndi.label(side, CONN26)
    sizes = np.bincount(patches.ravel())
    sizes[0] = 0
    big = int(sizes.argmax())
    return {'largest_patch_voxels': int(sizes[big]), 'voxels': int(side.sum()), 'direct': int(direct.sum()),
            'voxel_zyx': inside_voxel(patches == big, [t.start for t in box])}


if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--hu', type=sidecar.existing, required=True, help='hu.npy of the scan')
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='label volume .npy on the scan grid, with its sidecar beside it')
    ap.add_argument('--out', required=True, help='candidate volume .npy to write')
    ap.add_argument('--threshold-hu', type=sidecar.threshold_arg, required=True, help='voxels at or above it are bone: the scan\'s segmentation threshold: its scan-settings.json, or a number in HU')
    ap.add_argument('--min-mm3', type=float, default=0.01, help='mm3: smallest candidate kept, and smallest label piece that seeds the flood')
    ap.add_argument('--rim-mm', type=float, default=0.02, help='mm: bone this close to any label is not a candidate (at least 1 voxel)')
    ap.add_argument('--ranges', type=sidecar.existing, help='the anatomy reference\'s anatomy.json: which labels sit apart from which bones (apart_from)')
    ap.add_argument('--contact-voxels', type=int, default=DEFAULT_CONTACT_VOXELS,
                    help='largest contact patch, in voxels, tolerated between a label and a bone it sits apart from (partial volume across a narrow gap)')
    a = ap.parse_args()
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels)
    if hu.shape != labels.shape:
        sidecar.fail(f'hu {hu.shape} and labels {labels.shape} are on different grids: map the labels to the scan first')
    expected = {e['id']: e for e in json.loads(Path(a.ranges).read_text())['labels']} if a.ranges else {}
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    vox = float(np.prod(sp))
    min_vox = a.min_mm3 / vox
    rim = max(1, round(a.rim_mm / sp[0]))
    bone = np.zeros(hu.shape, bool)
    covered = np.zeros(hu.shape, bool)
    step = 64  # z-chunks (with a halo of `rim` slices, which keeps the dilation exact) spare full-volume float and boolean copies
    for z0 in range(0, hu.shape[0], step):
        bone[z0:z0 + step] = hu[z0:z0 + step] >= a.threshold_hu
        lo, hi = max(0, z0 - rim), min(hu.shape[0], z0 + step + rim)
        d = ndi.binary_dilation(labels[lo:hi] > 0, iterations=rim)
        covered[z0:z0 + step] = d[z0 - lo:z0 - lo + min(step, hu.shape[0] - z0)]
    grown = grow_labels(labels, bone, min_vox)  # before the candidate pieces: the two never hold memory at once
    covered = bone & ~covered
    pieces, n = ndi.label(covered, CONN26)
    del covered
    sizes = np.bincount(pieces.ravel())
    sizes[0] = 0
    keep = [int(i) for i in np.argsort(-sizes) if sizes[i] >= min_vox and sizes[i] > 0]
    objs = ndi.find_objects(pieces)
    out = np.zeros(hu.shape, np.uint16)
    cands = []
    for rank, i in enumerate(keep, 1):
        sl = objs[i - 1]
        m = pieces[sl] == i
        out[sl][m] = rank
        ids, counts = np.unique(grown[sl][m], return_counts=True)
        cands.append({'id': rank, 'voxels': int(sizes[i]), 'volume_mm3': round(float(sizes[i]) * vox, 4),
                      'centre_zyx': inside_voxel(m, [s.start for s in sl]), 'bbox_zyx': [[int(s.start), int(s.stop)] for s in sl],
                      'fused_to': {int(k): round(float(c) * vox, 4) for k, c in zip(ids, counts) if k}})
    del pieces

    report = {}
    if a.ranges:
        flags, joined = [], []
        name = {lv: e['name'] for lv, e in expected.items()}
        boxes = ndi.find_objects(grown)
        for s, e in sorted(expected.items()):
            if s > len(boxes) or boxes[s - 1] is None:
                continue
            box = tuple(slice(max(0, t.start - 1), t.stop + 1) for t in boxes[s - 1])
            for b in e.get('apart_from', []):
                c = contact(grown, labels, bone, s, b, box)
                if c is None:
                    continue
                joined.append({'label': s, 'bone': b, **c})
                if c['largest_patch_voxels'] > a.contact_voxels:
                    through = 'directly' if c['direct'] * 2 > c['voxels'] else 'mostly through bone no label covers'
                    flags.append(
                        f'{s} {name[s]} is joined to {b} {name.get(b, "")} through bone, {through}: a contact patch of '
                        f'{c["largest_patch_voxels"]} voxels ({c["voxels"]} in all, tolerance {a.contact_voxels}) at {c["voxel_zyx"]}. '
                        f'The anatomy puts it across joint space from the {name.get(b, b)}, so one label holds the other\'s bone: '
                        f'open it there, give each bone\'s voxels to its own label (classic_segment.py --within {s} or --within {b} '
                        f'with seeds; relabel.py for a piece apart), or redo the structure (a tight segment_sam box with negative points on the '
                        f'{name.get(b, b)}) or write your own cleanup and show it on a crop sheet; then run this again. Label {s} must end '
                        f'apart from label {b}; a threshold candidate is never its label by itself')
        bigs = {b for e in expected.values() for b in e.get('apart_from', [])}
        fused = [c for c in cands if bigs & set(c['fused_to'])]
        for c in fused:
            to = ', '.join(f'{name.get(k, k)} {v}' for k, v in c['fused_to'].items())
            flags.append(f'candidate {c["id"]}, {c["volume_mm3"]} mm3 at {c["centre_zyx"]}, is bone no label covers joined through '
                         f'bone to a big bone (mm3 of it each label reaches first: {to}). Open it (render_crops.py --component-at): '
                         f'a big bone\'s own bone goes to that label (relabel.py --pieces {a.out} --at {",".join(map(str, c["centre_zyx"]))} '
                         '--to <id>); while it is fused it is not a small structure to name or label, even when a SAM track for that '
                         'structure failed; other anatomy stays unlabelled')
        report = {'joined': joined, 'fused': [c['id'] for c in fused], 'flags': flags}
    np.save(a.out, out)
    sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.hu, a.labels],
                  params={'threshold_hu': a.threshold_hu, 'min_mm3': a.min_mm3, 'rim_mm': a.rim_mm, 'rim_vox': rim,
                          'contact_voxels': a.contact_voxels})
    sidecar.emit(candidates=a.out, count=len(cands), top=cands[:12], **report)
