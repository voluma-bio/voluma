"""Clip each label to bone: keep only the voxels at or above the segmentation threshold, so volumes count bone.

A SAM mask spans whole bones, marrow and some soft tissue, so its volume is larger than the bone's. Labels keep their ids;
every voxel below `--threshold-hu` becomes 0. The anatomy reference's volumes are bone voxels, so compare them with this
output, not with the mask. Never refill the clipped voxels with the nearest label: the tibia refills with fibula. Refuses
`--hu` and `--labels` of different shapes.

Writes: <out>  the clipped labels (.npy, the shape of --labels), with its sidecar (the labels' grid, the threshold)
Prints: one JSON line {labels, volume_mm3: {label id: clipped volume}, removed_mm3: {label id: volume removed}}
Example: python clip_to_bone.py --hu hu.npy --labels labels.npy --out clipped.npy --threshold-hu 2500
Exits 2 with one sentence on bad input, before writing anything.
"""

import numpy as np
import sidecar

if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--hu', type=sidecar.existing, required=True, help='hu.npy of the scan')
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='label volume .npy on the scan grid, with its sidecar beside it')
    ap.add_argument('--out', required=True, help='clipped labels .npy to write')
    ap.add_argument('--threshold-hu', type=float, required=True, help='HU: voxels below this are cleared (the segmentation threshold of the workflow\'s anatomy reference)')
    a = ap.parse_args()
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels)
    if hu.shape != labels.shape:
        sidecar.fail(f'hu {hu.shape} and labels {labels.shape} are on different grids: map the labels to the scan first')
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    before = np.bincount(labels.ravel(), minlength=256)
    for z in range(hu.shape[0]):
        labels[z][np.asarray(hu[z]) < a.threshold_hu] = 0
    np.save(a.out, labels)
    vox_mm3 = float(np.prod(sp))
    sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.hu, a.labels],
                  params={'threshold_hu': a.threshold_hu})
    after = np.bincount(labels.ravel(), minlength=256)
    ids = [int(i) for i in np.nonzero(before[1:])[0] + 1]
    sidecar.emit(labels=a.out, volume_mm3={i: round(float(after[i]) * vox_mm3, 4) for i in ids},
                 removed_mm3={i: round(float(before[i] - after[i]) * vox_mm3, 4) for i in ids})
