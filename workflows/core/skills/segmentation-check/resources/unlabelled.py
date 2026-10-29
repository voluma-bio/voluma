"""Find bone no label covers: candidate small structures (sesamoids, mineralizations, fragments) for you to name.

Candidates are the 26-connected pieces of (bone at or above `--threshold-hu`, with no label within `--rim-mm` of it) at
least `--min-mm3` big. The rim keeps the partial-volume skin around a labelled bone from joining them into one piece. Open
each candidate with `render_crops.py --component-at <centre>`, name it from the anatomy reference, then label it
(`relabel.py`) or raise a To check item.

Writes: <out>  uint16 volume on the grid of --labels, each candidate its id (1 = largest), with its sidecar
Prints: one JSON line {candidates, count, top}; top is the 12 largest, each {id, voxels, volume_mm3, centre_zyx, bbox_zyx}
Example: python unlabelled.py --hu hu.npy --labels labels.npy --out cand.npy --threshold-hu 2500
Exits 2 with one sentence on bad input, before writing anything.
"""

import numpy as np
import sidecar
from scipy import ndimage as ndi

if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--hu', type=sidecar.existing, required=True, help='hu.npy of the scan')
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='label volume .npy on the scan grid, with its sidecar beside it')
    ap.add_argument('--out', required=True, help='candidate volume .npy to write')
    ap.add_argument('--threshold-hu', type=float, required=True, help='HU: voxels at or above this are bone')
    ap.add_argument('--min-mm3', type=float, default=0.01, help='mm3: smallest candidate kept')
    ap.add_argument('--rim-mm', type=float, default=0.02, help='mm: bone this close to any label is not a candidate (at least 1 voxel)')
    a = ap.parse_args()
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels, mmap_mode='r')
    if hu.shape != labels.shape:
        sidecar.fail(f'hu {hu.shape} and labels {labels.shape} are on different grids: map the labels to the scan first')
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    vox = float(np.prod(sp))
    rim = max(1, round(a.rim_mm / sp[0]))
    out = np.zeros(hu.shape, np.uint16)
    cands = []
    step = 64  # z-chunks with a halo of `rim` slices keep the dilation exact without a full-volume boolean copy
    covered = np.zeros(hu.shape, bool)
    for z0 in range(0, hu.shape[0], step):
        lo, hi = max(0, z0 - rim), min(hu.shape[0], z0 + step + rim)
        d = ndi.binary_dilation(np.asarray(labels[lo:hi]) > 0, iterations=rim)
        covered[z0:z0 + step] = d[z0 - lo:z0 - lo + min(step, hu.shape[0] - z0)]
    free = (np.asarray(hu) >= a.threshold_hu) & ~covered
    del covered
    pieces, n = ndi.label(free, np.ones((3, 3, 3)))
    sizes = np.bincount(pieces.ravel())
    sizes[0] = 0
    keep = [int(i) for i in np.argsort(-sizes) if sizes[i] * vox >= a.min_mm3 and sizes[i] > 0]
    objs = ndi.find_objects(pieces)
    for rank, i in enumerate(keep, 1):
        sl = objs[i - 1]
        m = pieces[sl] == i
        out[sl][m] = rank
        centre = (np.argwhere(m).mean(0) + [s.start for s in sl]).round().astype(int).tolist()
        cands.append({'id': rank, 'voxels': int(sizes[i]), 'volume_mm3': round(float(sizes[i]) * vox, 4), 'centre_zyx': centre,
                          'bbox_zyx': [[int(s.start), int(s.stop)] for s in sl]})
    np.save(a.out, out)
    sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.hu, a.labels],
                  params={'threshold_hu': a.threshold_hu, 'min_mm3': a.min_mm3, 'rim_mm': a.rim_mm, 'rim_vox': rim})
    sidecar.emit(candidates=a.out, count=len(cands), top=cands[:12])
