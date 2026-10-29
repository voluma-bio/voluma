"""Give a whole 3D piece a different label: fix a component that carries the wrong label, or name a candidate.

Without `--pieces`, the piece is the 26-connected part of the label under the voxel `--at` (the voxel must be labelled).
With `--pieces` (a candidate volume from `unlabelled.py`), it is the candidate containing the voxel (which must lie in a
candidate); it overwrites whatever label those voxels had, and the previous labels are reported. `--to 0` clears the piece.

Writes: <out>  the labels with the piece relabelled (.npy, the grid of --labels), with its sidecar
Prints: one JSON line {labels, voxels, previous_labels: {label id: voxels}, now}
Example: python relabel.py --labels labels.npy --out fixed.npy --at 410,220,130 --to 5 --pieces cand.npy
Exits 2 with one sentence on the input it checks; a missing file is a Python error.
"""

import numpy as np
import sidecar
from scipy import ndimage as ndi

if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--labels', required=True, help='label volume .npy on the scan grid, with its sidecar beside it')
    ap.add_argument('--out', required=True, help='relabelled labels .npy to write')
    ap.add_argument('--at', required=True, metavar='z,y,x', help='scan voxel indices of a voxel in the piece')
    ap.add_argument('--to', type=int, required=True, help='the label id to give the piece (0 clears it)')
    ap.add_argument('--pieces', help='candidate volume .npy from unlabelled.py: the piece is the candidate containing --at')
    a = ap.parse_args()
    labels = np.load(a.labels)
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
