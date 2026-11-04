"""Clear each label's specks: the loose fragments a clipped SAM label leaves around its bone.

A speck is a 26-connected piece of one label smaller than `--min-piece-mm3`, the size `label_stats.py` and `unlabelled.py`
use, so after this `label_stats.py` reports no specks and every piece it lists is still there. Specks become background:
they are too small to be candidates for `unlabelled.py`, and in the 3D view they show as loose dots off the bone. Run it
last on a finished labels volume, before reporting it; the volume each label loses is printed, for the report.

Writes: <out>  the labels without specks (.npy, the grid of --labels), with its sidecar
Prints: one JSON line {labels, dropped: {label id: {specks, voxels, mm3}}}
Example: python drop_specks.py --labels labels.npy --out labels_clean.npy
Exits 2 with one sentence on bad input, before writing anything.
"""

import numpy as np
import sidecar
from scipy import ndimage as ndi

CONN26 = np.ones((3, 3, 3))

if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='label volume .npy on the scan grid, with its sidecar beside it')
    ap.add_argument('--out', required=True, help='labels .npy to write')
    ap.add_argument('--min-piece-mm3', type=float, default=0.01, help='mm3: pieces of a label smaller than this are cleared')
    a = ap.parse_args()
    labels = np.load(a.labels)
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    vox = float(np.prod(sp))
    out = labels.copy()
    dropped = {}
    for i, box in enumerate(ndi.find_objects(labels), start=1):
        if box is None:
            continue
        pieces, _ = ndi.label(labels[box] == i, CONN26)
        sizes = np.bincount(pieces.ravel())
        sizes[0] = 0
        speck = (sizes > 0) & (sizes * vox < a.min_piece_mm3)
        if speck.any():
            out[box][speck[pieces]] = 0
            n = int(sizes[speck].sum())
            dropped[i] = {'specks': int(speck.sum()), 'voxels': n, 'mm3': round(n * vox, 5)}
    np.save(a.out, out)
    sidecar.write(a.out, like=sidecar.sidecar_path(a.labels), inputs=[a.labels], params={'min_piece_mm3': a.min_piece_mm3})
    sidecar.emit(labels=a.out, dropped=dropped)
