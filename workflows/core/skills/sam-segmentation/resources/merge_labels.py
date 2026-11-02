"""Merge a small-structure request into the big-bone labels; a contested voxel goes to the nearer side.

`segment_sam` rejects duplicate labels, so a structure in several 3D pieces was sent with one temporary label per piece
(61 and 62 for the two pieces of label 6). `--map temp:final` renames each; several temps may map to one final label, and
`temp:0` drops one. The two volumes must be on the same grid (map the small request to the scan grid with `to_scan.py` first).

One rule: a voxel only one request claims keeps that label. A voxel both claim (a small label over a big label) goes to the
label of the nearest voxel only one request claims, so the cut falls midway between the two requests' own voxels. Neither
request wins by default: big bones winning gave a third of each OA7-1L sesamoid to the femur, and small structures
winning gave a leaking small piece 0.3 mm3 of OA6-1RK's patella (`.context/evidence.md`, sam-segmentation). Each
contested voxel is counted in the output by big label and by where it went, so a leak shows: a small label with a large
contested count against its volume, or a big label that lost much, is a To check item. Refused: a temp label that is also
a label in `--big`, a label in `--small` that `--map` does not mention, volumes of different shape or grid id.

Writes: <out>  the merged labels (.npy, the grid of --big), with its sidecar (the map)
Prints: one JSON line {labels, merged: {temp label: {final, voxels, contested: {big label: {to_small, to_big}}}}, volume_mm3: {label id: volume of the result}}
Example: python merge_labels.py --big labels_big.npy --small small_trimmed.npy --map 61:6 62:6 5:5 --out labels_merged.npy
Exits 2 with one sentence on bad input, before writing anything.
"""

import numpy as np
import sidecar
from scipy import ndimage

if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--big', type=sidecar.existing, required=True, help='scan-grid labels of the big bones (clipped)')
    ap.add_argument('--small', type=sidecar.existing, required=True, help='scan-grid labels of the small request (trimmed, mapped back)')
    ap.add_argument('--map', nargs='+', required=True, metavar='temp:final', help='temporary label : label it goes back to (0 drops it)')
    ap.add_argument('--out', required=True, help='merged labels .npy to write')
    a = ap.parse_args()
    try:
        mapping = {int(t): int(f) for t, f in (m.split(':') for m in a.map)}
    except ValueError:
        sidecar.fail(f'--map takes temp:final integer pairs such as 61:6 62:6, got {a.map}')
    big = np.load(a.big)
    small = np.load(a.small, mmap_mode='r')
    if big.shape != small.shape:
        sidecar.fail(f'{a.big} {big.shape} and {a.small} {small.shape} are on different grids: map the small request to the scan grid first')
    g_big, g_small = sidecar.grid(sidecar.sidecar_path(a.big)), sidecar.grid(sidecar.sidecar_path(a.small))
    if g_big['grid_id'] != g_small['grid_id']:
        sidecar.fail('the two volumes have different grid ids: both must be on the scan grid')
    clash = sorted(set(mapping) & {int(i) for i in np.unique(big)})
    if clash:
        sidecar.fail(f'temporary labels {clash} are already labels in {a.big}: choose temporary labels the big bones do not use')
    present = {int(i) for i in np.unique(small) if i > 0}
    stray = sorted(present - set(mapping))
    if stray:
        sidecar.fail(f'{a.small} holds labels {stray} that --map does not mention: map each to its final label (or to 0 to drop it)')
    small = np.asarray(small)
    final = np.zeros(small.shape, big.dtype)
    for temp, label in mapping.items():
        final[small == temp] = label
    out = big.copy()
    one_sided = (final > 0) & (big == 0)
    out[one_sided] = final[one_sided]
    contested = (final > 0) & (big > 0)
    to_small = np.zeros(small.shape, bool)
    if contested.any():
        # nearest one-sided voxel, searched in the contested voxels' box widened by the box's own size
        spans = [(int(n.min()), int(n.max()) + 1) for n in np.nonzero(contested)]
        box = tuple(slice(max(0, lo - (hi - lo)), hi + (hi - lo)) for lo, hi in spans)
        sub_c, sub_final, sub_big = contested[box], final[box], big[box]
        owner = np.where(sub_final > 0, sub_final, sub_big)
        _, idx = ndimage.distance_transform_edt(sub_c | (owner == 0), return_indices=True)
        nearest = owner[tuple(idx)]
        to_small[box] = sub_c & (nearest == sub_final)
        out[box][sub_c] = nearest[sub_c]
    report = {}
    for temp, label in mapping.items():
        m = small == temp
        by_big = {}
        for b in np.unique(big[m & contested]):
            c = m & (big == b)
            by_big[int(b)] = {'to_small': int((c & to_small).sum()), 'to_big': int((c & ~to_small).sum())}
        report[temp] = {'final': label, 'voxels': int(m.sum()), 'contested': by_big}
    vox = float(np.prod(g_big['spacing_zyx_mm']))
    np.save(a.out, out)
    sidecar.write(a.out, like=sidecar.sidecar_path(a.big), inputs=[a.big, a.small], params={'map': {str(k): v for k, v in mapping.items()}})
    ids, counts = np.unique(out[out > 0], return_counts=True)
    sidecar.emit(labels=a.out, merged=report, volume_mm3={int(i): round(float(c) * vox, 4) for i, c in zip(ids, counts)})
