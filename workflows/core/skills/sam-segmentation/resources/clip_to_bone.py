"""Clip each label to bone: keep only the voxels at or above the segmentation threshold, so volumes count bone and not
the soft tissue (or marrow) a SAM mask spans.

  python clip_to_bone.py --hu hu.npy --labels labels.npy --out clipped.npy --threshold-hu <T>

Labels keep their ids. A SAM mask spans whole bones, marrow and some soft tissue: on OA6-1RK the femur mask was 19.3 mm3 and
its bone 8.5 mm3 (reference 8.4), and the patella mask was 16 mm3 for 2.5 mm3 of bone. The anatomy reference's volumes are
bone voxels, so compare them with this output, not with the mask. Prints per label the clipped volume and the volume removed.
Clipping moved bone-voxel Dice by at most 0.002. Never refill the clipped voxels with the nearest label: the tibia
refills with fibula.
"""
import argparse
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [str(HERE), str(SKILLS / 'microct-core/resources')]
try:
    import sidecar
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects core/skills/microct-core/resources/ in a directory above it '
             '(<workflows>/core/skills/<skill>/resources/, or <workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it)')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--hu', required=True)
    ap.add_argument('--labels', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--threshold-hu', type=float, required=True)
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
