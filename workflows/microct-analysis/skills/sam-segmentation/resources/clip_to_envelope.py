"""Clip each label to a filled bone envelope, so volumes count bone and not the soft tissue SAM masks include.

  python clip_to_envelope.py --hu hu.npy --labels labels.npy --out clipped.npy --threshold-hu <T> [--radius-mm 0.084]

The envelope is, per slice along axis 0 of the scan grid: pixels >= threshold, closed with a disk of `--radius-mm`, holes
filled. Labels keep their ids. Whole-mask SAM volumes ran 15-60% over the reference on small structures and 7-34% on big ones
because of soft tissue; clipping moved bone-voxel Dice by at most 0.002, so it changes what the numbers count, not how well
the bones agree. Never refill the clipped voxels with the nearest label: the tibia refills with fibula.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path, so every directory a script imports from is added here.
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'microct-core/resources')]
try:
    import sidecar
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects <workflows>/microct-analysis/skills/<skill>/resources/ with '
             '<workflows>/microct-analysis/skills/microct-core/resources/sidecar.py beside it')



def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


def envelope_slice(m, r):
    if not m.any():
        return m.copy()
    pad = r + 2
    c = np.pad(m, pad)
    c = ndi.binary_closing(c, disk(r)) | c
    return ndi.binary_fill_holes(c)[pad:-pad, pad:-pad]


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--hu', required=True)
    ap.add_argument('--labels', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--threshold-hu', type=float, required=True)
    ap.add_argument('--radius-mm', type=float, default=0.084)
    a = ap.parse_args()
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels)
    if hu.shape != labels.shape:
        sidecar.fail(f'hu {hu.shape} and labels {labels.shape} are on different grids: map the labels to the scan first')
    g = sidecar.grid(str(sidecar.sidecar_path(a.labels)))
    sp = g['spacing_zyx_mm']
    r = max(1, round(a.radius_mm / sp[1]))
    for z in range(hu.shape[0]):
        env = envelope_slice(np.asarray(hu[z]) >= a.threshold_hu, r)
        labels[z][~env] = 0
    np.save(a.out, labels)
    vox_mm3 = float(np.prod(sp))
    sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.hu, a.labels],
                  params={'threshold_hu': a.threshold_hu, 'radius_mm': a.radius_mm, 'radius_px': r})
    ids, counts = np.unique(labels[labels > 0], return_counts=True)
    sidecar.emit(labels=a.out, volume_mm3={int(i): round(float(c) * vox_mm3, 4) for i, c in zip(ids, counts)})
