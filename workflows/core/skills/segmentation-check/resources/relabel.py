"""Give a whole 3D piece a different label: fix a component that carries the wrong label, or name a candidate.

Without `--pieces`, the piece is the 26-connected part of the label under the voxel `--at` (the voxel must be labelled).
With `--pieces` (a candidate volume from `unlabelled.py`), it is the candidate containing the voxel (which must lie in a
candidate); it overwrites whatever label those voxels had, and the previous labels are reported. `--to 0` clears the piece.

`--swap A,B` exchanges two labels' ids everywhere (A's voxels become B and B's become A): labels that are each other's bone,
such as a femur and a tibia, which `label_stats.py`'s `swapped:` flag names. It takes no `--at` or `--to`.

Writes: <out>  the labels with the piece relabelled (.npy, the grid of --labels), with its sidecar
Prints: one JSON line {labels, voxels, previous_labels: {label id: voxels}, now}
Example: python relabel.py --labels labels.npy --out fixed.npy --at 410,220,130 --to 5 --pieces cand.npy
         python relabel.py --labels labels.npy --out fixed.npy --swap 1,2
Exits 2 with one sentence on bad input, before writing anything.
"""

import numpy as np
import sidecar
from scipy import ndimage as ndi

if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='label volume .npy on the scan grid, with its sidecar beside it')
    ap.add_argument('--out', required=True, help='relabelled labels .npy to write')
    ap.add_argument('--at', metavar='z,y,x', help='scan voxel indices of a voxel in the piece')
    ap.add_argument('--to', type=int, help='the label id to give the piece (0 clears it)')
    ap.add_argument('--swap', metavar='A,B', help='exchange two labels\' ids everywhere')
    ap.add_argument('--pieces', type=sidecar.existing, help='candidate volume .npy from unlabelled.py: the piece is the candidate containing --at')
    a = ap.parse_args()
    labels = np.load(a.labels)
    if a.swap:
        if a.at or a.to is not None or a.pieces:
            sidecar.fail('--swap exchanges two whole labels: drop --at, --to and --pieces')
        try:
            p, q = (int(v) for v in a.swap.split(','))
        except ValueError:
            sidecar.fail(f'--swap takes two label ids, e.g. 1,2; got {a.swap!r}')
        if p == q or p <= 0 or q <= 0:
            sidecar.fail(f'--swap takes two different label ids above 0, got {a.swap!r}')
        mp, mq = labels == p, labels == q
        if not mp.any() or not mq.any():
            sidecar.fail(f'labels {p} and {q} must both be in {a.labels} to swap them')
        labels[mp], labels[mq] = q, p
        np.save(a.out, labels)
        sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.labels], params={'swap': [p, q]})
        sidecar.emit(labels=a.out, swapped=[p, q], voxels={str(p): int(mq.sum()), str(q): int(mp.sum())})
        raise SystemExit(0)
    if a.at is None or a.to is None:
        sidecar.fail('--at and --to name the piece and its new label (or pass --swap A,B)')
    z, y, x = (int(v) for v in a.at.split(','))
    if a.pieces:
        src = np.load(a.pieces, mmap_mode='r')
        k = int(src[z, y, x])
        if k == 0:
            sidecar.fail(f'voxel {a.at} is in no candidate of {a.pieces}: pick a voxel inside one (centre_zyx)')
        m = np.asarray(src) == k
    else:
        lv = int(labels[z, y, x])
        if lv == 0:
            sidecar.fail(f'voxel {a.at} is unlabelled: pass --pieces <candidates.npy> to label an unlabelled piece')
        pieces, _ = ndi.label(labels == lv, np.ones((3, 3, 3)))
        m = pieces == pieces[z, y, x]
    before = {int(i): int(c) for i, c in zip(*np.unique(labels[m], return_counts=True))}
    labels[m] = a.to
    np.save(a.out, labels)
    sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.labels] + ([a.pieces] if a.pieces else []),
                  params={'at': [z, y, x], 'to': a.to})
    sidecar.emit(labels=a.out, voxels=int(m.sum()), previous_labels=before, now=a.to)
