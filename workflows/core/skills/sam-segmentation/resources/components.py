"""List the connected bone components of a threshold, biggest first, before any labels exist.

A component is a connected set of voxels at or above `--threshold-hu`: 26-connected in the whole volume (what `unlabelled.py`
uses), 8-connected on one slice with `--index`. Use it to survey the bone, or a slice's bone, before you box or label
anything. `--min-mm3` drops the specks first; `count` is how many components pass it, `top` the `--top` largest.
The input is the scan or an oriented stack, with its sidecar beside it (for the voxel size); indices are on that grid.
Centres and boxes are voxel indices (bbox ends exclusive);
`touches_border` is true when the component reaches the edge of the volume (or slice).

Writes: nothing
Prints: one JSON line {threshold_hu, index, count, top}; top is a list of {id, voxels, volume_mm3, centre_zyx, bbox_zyx,
  touches_border} (id 1 = largest). With `--index` the slice is 2D: each entry has area_mm2 in place of volume_mm3, and
  centre_yx and bbox_yx in place of the zyx fields, in that slice's rows and columns; `index` is the slice (axis 0).
Example: python components.py --in hu.npy --threshold-hu 2500 --top 10
         python components.py --in hu.npy --threshold-hu 2500 --index 159 --min-mm3 0.01
Exits 2 with one sentence on bad input, before reading the volume.
"""
import numpy as np
import sidecar
from scipy import ndimage as ndi

if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--in', dest='inp', type=sidecar.existing, required=True, help='the scan (hu.npy) or an oriented stack, with its sidecar beside it (for the voxel size)')
    ap.add_argument('--threshold-hu', type=float, required=True, help='HU: voxels at or above this are bone')
    ap.add_argument('--index', type=int, help='slice of the volume (axis 0): find 2D components on it instead of 3D components')
    ap.add_argument('--top', type=int, default=10, help='how many of the largest components to list')
    ap.add_argument('--min-mm3', type=float, default=0.0, help='mm3 (mm2 with --index): smallest component kept')
    a = ap.parse_args()
    if a.top < 1:
        sidecar.fail('--top must be at least 1')
    if a.min_mm3 < 0:
        sidecar.fail('--min-mm3 must not be negative')
    hu = np.load(a.inp, mmap_mode='r')
    if hu.ndim != 3:
        sidecar.fail(f'{a.inp} has shape {hu.shape}: expected a 3D volume')
    if a.index is not None and not 0 <= a.index < hu.shape[0]:
        sidecar.fail(f'--index {a.index} is outside the volume\'s {hu.shape[0]} slices (0 to {hu.shape[0] - 1})')
    side = sidecar.sidecar_path(a.inp)
    if not side.exists():
        sidecar.fail(f'{side} not found: components needs the sidecar beside --in for the voxel size')
    sp = sidecar.grid(side)['spacing_zyx_mm']
    two_d = a.index is not None
    img = np.asarray(hu[a.index]) if two_d else np.asarray(hu)
    unit = float(np.prod(sp[1:] if two_d else sp))
    lab, n = ndi.label(img >= a.threshold_hu, np.ones((3,) * img.ndim))
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    sizes[0] = 0
    keep = [int(i) for i in np.argsort(-sizes) if sizes[i] > 0 and sizes[i] * unit >= a.min_mm3]
    objs = ndi.find_objects(lab)
    ax = 'yx' if two_d else 'zyx'
    top = []
    for rank, i in enumerate(keep[:a.top], 1):
        sl = objs[i - 1]
        centre = (np.argwhere(lab[sl] == i).mean(0) + [s.start for s in sl]).round().astype(int).tolist()
        top.append({'id': rank, 'voxels': int(sizes[i]), 'area_mm2' if two_d else 'volume_mm3': round(float(sizes[i]) * unit, 4),
                    f'centre_{ax}': centre, f'bbox_{ax}': [[int(s.start), int(s.stop)] for s in sl],
                    'touches_border': any(s.start == 0 or s.stop == d for s, d in zip(sl, img.shape))})
    sidecar.emit(threshold_hu=a.threshold_hu, index=a.index, count=len(keep), top=top)
