"""Per-label checks on a labels volume: voxels, volume, 3D pieces, bounding box, neighbours, and range flags.

Per label: voxels, volume in mm3, 3D pieces and their sizes, bounding box, neighbours and, with a ranges file, whether the
label is inside the expected volume range and piece count.

Pieces smaller than `--min-piece-mm3` are specks, not pieces: clipping a SAM mask to bone leaves hundreds of them, and
counting them would flag every label. They are reported as `specks` (count and volume) and left out of `pieces`. The default
is the size `unlabelled.py` uses for a candidate.

`--ranges` is the anatomy reference's anatomy.json: {"labels": [{"id": 1, "name": "femur", "volume_mm3": [lo, hi], "components": 1}]}.
`piece_mm3` lists the largest pieces and `piece_voxel_zyx` a voxel inside each, in the same order; `piece_touches_edge` says,
in the same order, whether the piece reaches the scan's edge (what lies there is out of the field of view, or cut by it).
One more rule reads optional anatomy keys: `must_touch: [ids]` flags a label that comes within `touch_mm` (default 0.05) of
none of a neighbour the anatomy requires, so a joint gap of a few voxels does not flag a correct label while a label on the
wrong bone, which touches only background, does. `within_mm` lists the labels found within that reach and their distances.
A label whose volume is under the range's low end divided by `--far-factor` is not a slightly-off version of that structure:
the piece is something else, or a sliver of it. It gets `identity_unsupported: true` and a flag that says to remove the label
and look for the real structure (`segmentation-check`, section 2); the ids are also in `unsupported`. Above the range stays
an ordinary range flag: that label usually took bone from a neighbour. A label in the ranges file but absent, and a label
the file does not list, are flagged.

Writes: <out>  the full per-label table (JSON, keyed by label id)
Prints: one JSON line {stats, labels, volume_mm3, pieces, specks, unsupported, flags}; flags is the sentences for the labels that fail
Example: python label_stats.py --labels labels.npy --out stats.json --ranges anatomy.json
Exits 2 with one sentence on bad input, before writing anything.
"""
import json
from pathlib import Path

import numpy as np
import sidecar
from scipy import ndimage as ndi

CONN26 = np.ones((3, 3, 3))
DEFAULT_TOUCH_MM = 0.05  # closes a joint gap or a clip that opened a voxel or two, not a wrong bone; scale with voxel size for another scanner


def neighbours(lab, mask, label):
    """Labels touching `label` (one voxel apart, 6-connected), with the contact voxel counts."""
    ring = ndi.binary_dilation(mask) & ~mask
    ids, counts = np.unique(lab[ring], return_counts=True)
    return {int(i): int(c) for i, c in zip(ids, counts) if i != label}


def near_labels(sub, mask, label, sp, reach_mm):
    """{label: distance in mm} for labels with a voxel within `reach_mm` of `mask` (inside `sub`, padded by the reach)."""
    dist = ndi.distance_transform_edt(~mask, sampling=sp)
    near = dist <= reach_mm
    return {int(i): round(float(dist[near & (sub == i)].min()), 4) for i in np.unique(sub[near]) if i not in (0, label)}


def stats_for(labels, label, sp, min_piece_mm3, reach_mm=None):
    sl = ndi.find_objects((labels == label).astype(np.uint8))[0]
    k = 1 if reach_mm is None else max(1, int(np.ceil(reach_mm / min(sp))))
    pad = tuple(slice(max(0, s.start - k), s.stop + k) for s in sl)
    sub = labels[pad]
    mask = sub == label
    pieces, n = ndi.label(mask, CONN26)
    counts = np.bincount(pieces.ravel())[1:]
    order = np.argsort(-counts)
    sizes = counts[order]
    v = float(np.prod(sp))
    specks = sizes[sizes * v < min_piece_mm3]
    keep = order[sizes * v >= min_piece_mm3]
    sizes = counts[keep]
    n = len(sizes)
    objs = ndi.find_objects(pieces)
    edge = [bool(any(t.start + q.start == 0 or t.stop + q.start == d for t, q, d in zip(objs[i], pad, labels.shape)))
            for i in keep[:8]]
    voxels = []  # one voxel inside each of the first 8 pieces, for `relabel.py --at` and the seeds of `classic_segment.py`
    for i in keep[:8]:
        pts = np.argwhere(pieces[objs[i]] == i + 1)
        voxels.append((pts[len(pts) // 2] + [t.start + q.start for t, q in zip(objs[i], pad)]).tolist())
    within = {} if reach_mm is None else {'within_mm': near_labels(sub, mask, label, sp, reach_mm)}
    return {
        **within,
        'voxels': int(mask.sum()), 'volume_mm3': round(float(mask.sum()) * v, 4), 'pieces': int(n),
        'specks': {'count': len(specks), 'mm3': round(float(specks.sum()) * v, 5)},
        'piece_mm3': [round(float(s) * v, 4) for s in sizes[:8]], 'piece_voxel_zyx': voxels, 'piece_touches_edge': edge,
        'bbox_zyx': [[int(s.start), int(s.stop)] for s in sl],
        'neighbour_voxels': neighbours(sub, mask, label)}


if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='label volume .npy, with its sidecar beside it')
    ap.add_argument('--out', required=True, help='JSON file to write')
    ap.add_argument('--ranges', type=sidecar.existing, help='the anatomy reference\'s anatomy.json: expected volume range, pieces and neighbours per label')
    ap.add_argument('--header', type=sidecar.existing, help='hu.json, for the spacing (default: the labels sidecar)')
    ap.add_argument('--far-factor', type=float, default=10,
                    help='a volume under the range low end divided by this is not that structure')
    ap.add_argument('--min-piece-mm3', type=float, default=0.01, help='mm3: smaller pieces are specks, not counted as pieces')
    a = ap.parse_args()
    labels = np.load(a.labels)
    sp = sidecar.grid(a.header or str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    expected = {}
    if a.ranges:
        expected = {e['id']: e for e in json.loads(Path(a.ranges).read_text())['labels']}
    table, flags, unsupported = {}, [], []
    ids = [int(i) for i in np.unique(labels) if i > 0]
    for lv in ids:
        e = expected.get(lv)
        s = stats_for(labels, lv, sp, a.min_piece_mm3, e.get('touch_mm', DEFAULT_TOUCH_MM) if e and e.get('must_touch') else None)
        if e:
            lo, hi = e['volume_mm3']
            s['name'] = e['name']
            s['volume_in_range'] = lo <= s['volume_mm3'] <= hi
            s['pieces_expected'] = e.get('components', 1)
            s['identity_unsupported'] = s['volume_mm3'] < lo / a.far_factor
            if s['identity_unsupported']:
                unsupported.append(lv)
                flags.append(f'{lv} {e["name"]}: {s["volume_mm3"]} mm3 is under {lo}/{a.far_factor:g}: this label is not the {e["name"]} (another piece, or a sliver of it). '
                             'Remove the label, then look for the real one (unlabelled.py candidates, the keyframe)')
            elif not s['volume_in_range']:
                flags.append(f'{lv} {e["name"]}: {s["volume_mm3"]} mm3 outside {lo}-{hi}')
            if s['pieces'] != s['pieces_expected']:
                flags.append(f'{lv} {e["name"]}: {s["pieces"]} pieces, expected {s["pieces_expected"]}')
            missing = [t for t in e.get('must_touch', []) if t not in s['within_mm']]
            if missing:
                flags.append(f'{lv} {e["name"]}: not within {e.get("touch_mm", DEFAULT_TOUCH_MM)} mm of label {missing} '
                             f'(within reach: {sorted(s["within_mm"])}); is it on the right bone?')
        table[lv] = s
    for lv, e in expected.items():
        if lv not in table:
            flags.append(f'{lv} {e["name"]}: expected but absent')
    unknown = [lv for lv in ids if expected and lv not in expected]
    if unknown:
        flags.append(f'labels {unknown} are not in the ranges file')
    Path(a.out).write_text(json.dumps(table, indent=1) + '\n')
    sidecar.emit(stats=a.out, labels=ids, volume_mm3={lv: table[lv]['volume_mm3'] for lv in ids},
                 pieces={lv: table[lv]['pieces'] for lv in ids}, specks={lv: table[lv]['specks']['count'] for lv in ids}, unsupported=unsupported, flags=flags)
