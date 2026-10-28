"""Per-label checks on a labels volume: voxels, volume in mm3, 3D pieces and their sizes, bounding box, neighbours, and,
with a ranges file, whether each label is inside the expected volume range and piece count.

  python label_stats.py --labels labels.npy --out stats.json [--ranges anatomy.json] [--header hu.json]

`--ranges` is the anatomy skill's JSON: {"labels": [{"id": 1, "name": "femur", "volume_mm3": [lo, hi], "components": 1}]}.
Prints a one-line summary with the labels that fail; the full table is in `--out`.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'microct-core/resources'))
import sidecar

CONN26 = np.ones((3, 3, 3))


def neighbours(lab, mask, label):
    """Labels touching `label` (one voxel apart, 6-connected), with the contact voxel counts."""
    ring = ndi.binary_dilation(mask) & ~mask
    ids, counts = np.unique(lab[ring], return_counts=True)
    return {int(i): int(c) for i, c in zip(ids, counts) if i != label}


def stats_for(labels, label, sp):
    sl = ndi.find_objects((labels == label).astype(np.uint8))[0]
    pad = tuple(slice(max(0, s.start - 1), s.stop + 1) for s in sl)
    sub = labels[pad]
    mask = sub == label
    pieces, n = ndi.label(mask, CONN26)
    sizes = np.sort(np.bincount(pieces.ravel())[1:])[::-1]
    v = float(np.prod(sp))
    return {
        'voxels': int(mask.sum()), 'volume_mm3': round(float(mask.sum()) * v, 4), 'pieces': int(n),
        'piece_mm3': [round(float(s) * v, 4) for s in sizes[:8]],
        'bbox_zyx': [[int(s.start), int(s.stop)] for s in sl],
        'neighbour_voxels': neighbours(sub, mask, label)}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--labels', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--ranges')
    ap.add_argument('--header', help='hu.json (default: the labels sidecar)')
    a = ap.parse_args()
    labels = np.load(a.labels)
    sp = sidecar.grid(a.header or str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    expected = {}
    if a.ranges:
        expected = {e['id']: e for e in json.loads(Path(a.ranges).read_text())['labels']}
    table, flags = {}, []
    ids = [int(i) for i in np.unique(labels) if i > 0]
    for lv in ids:
        s = stats_for(labels, lv, sp)
        e = expected.get(lv)
        if e:
            lo, hi = e['volume_mm3']
            s['name'] = e['name']
            s['volume_in_range'] = lo <= s['volume_mm3'] <= hi
            s['pieces_expected'] = e.get('components', 1)
            if not s['volume_in_range']:
                flags.append(f'{lv} {e["name"]}: {s["volume_mm3"]} mm3 outside {lo}-{hi}')
            if s['pieces'] != s['pieces_expected']:
                flags.append(f'{lv} {e["name"]}: {s["pieces"]} pieces, expected {s["pieces_expected"]}')
        table[lv] = s
    for lv, e in expected.items():
        if lv not in table:
            flags.append(f'{lv} {e["name"]}: expected but absent')
    unknown = [lv for lv in ids if expected and lv not in expected]
    if unknown:
        flags.append(f'labels {unknown} are not in the ranges file')
    Path(a.out).write_text(json.dumps(table, indent=1) + '\n')
    sidecar.emit(stats=a.out, labels=ids, volume_mm3={lv: table[lv]['volume_mm3'] for lv in ids},
                 pieces={lv: table[lv]['pieces'] for lv in ids}, flags=flags)
