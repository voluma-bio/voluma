"""Snap hand-drawn boxes to the bone they contain, so a prompt box does not cut off bone edges.

  python snap_boxes.py --in oriented.npy --index 159 --threshold-hu <T> --boxes r0,c0,r1,c1 [r0,c0,r1,c1 ...] [--pad-mm 0.0315] [--out boxes.json]

Prints the snapped boxes, in the [row0, col0, row1, col1] inclusive form `segment_sam` takes, in the same order. Each box grows to the
bounding box of the bone components (pixels >= threshold, 8-connected) that lie mostly (>= 50% of their pixels) inside it,
plus `--pad-mm` (the pixel size comes from the sidecar beside `--in`). It never shrinks a box. Look at the result on the slice (`render_slices.py --boxes`) before using it.
"""
import argparse
import json
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
    sys.exit(f'{e}: this script expects <workflows>/core/skills/<skill>/resources/ with '
             '<workflows>/core/skills/microct-core/resources/sidecar.py beside it')



def snap_box(image, box, threshold, pad=3, min_px=50):
    lab, n = ndi.label(np.asarray(image) >= threshold, np.ones((3, 3)))
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    r0, c0, r1, c1 = box
    inside = np.bincount(lab[r0:r1 + 1, c0:c1 + 1].ravel(), minlength=n + 1)
    keep = [i for i in range(1, n + 1) if sizes[i] >= min_px and inside[i] >= 0.5 * sizes[i]]
    if not keep:
        return list(box)
    pts = np.argwhere(np.isin(lab, keep))
    (a0, b0), (a1, b1) = pts.min(0) - pad, pts.max(0) + pad
    h, w = lab.shape
    return [int(max(min(a0, r0), 0)), int(max(min(b0, c0), 0)), int(min(max(a1, r1), h - 1)), int(min(max(b1, c1), w - 1))]


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--in', dest='src', required=True, help='oriented stack (3D) or a 2D slice, .npy, with its sidecar .json beside it (for the pixel size)')
    ap.add_argument('--index', type=int, help='slice of the stack (axis 0)')
    ap.add_argument('--threshold-hu', type=float, required=True, help='bone threshold in the volume units')
    ap.add_argument('--boxes', nargs='+', required=True, help='r0,c0,r1,c1 (row/column pixels, ends inclusive)')
    ap.add_argument('--pad-mm', type=float, default=0.0315, help='margin added around the bone, in mm')
    ap.add_argument('--out')
    a = ap.parse_args()
    v = np.load(a.src, mmap_mode='r')
    if v.ndim == 3 and a.index is None:
        sidecar.fail('--index is required for a 3D stack')
    img = np.asarray(v[a.index] if v.ndim == 3 else v)
    boxes = [[int(x) for x in b.split(',')] for b in a.boxes]
    for b in boxes:
        if len(b) != 4 or b[0] > b[2] or b[1] > b[3]:
            sidecar.fail(f'box {b} is not r0,c0,r1,c1 with r0<=r1 and c0<=c1')
    side = sidecar.sidecar_path(a.src)
    if not side.exists():
        sidecar.fail(f'{side} not found: snap_boxes needs the sidecar beside --in for the pixel size; write one with sidecar.write(path, like=<the stack it came from>), or pass the 3D stack with --index')
    pixel_mm = sidecar.grid(side)['spacing_zyx_mm'][-1]
    pad = round(a.pad_mm / pixel_mm)
    snapped = [snap_box(img, b, a.threshold_hu, pad) for b in boxes]
    if a.out:
        Path(a.out).write_text(json.dumps(snapped) + '\n')
    sidecar.emit(snapped=snapped, grew=[s != b for s, b in zip(snapped, boxes)], index=a.index, out=a.out)
