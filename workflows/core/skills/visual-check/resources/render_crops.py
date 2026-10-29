"""Crop sheet of one small piece of bone: three cuts through its centre with the labels outlined, as one JPEG.

Answers "what is this small unlabelled thing?" and "is it on the right bone?". `--component-at` picks the 3D piece of bone
(labelled or not: voxels at or above `--bone-hu`) that contains the voxel; `--label` picks the largest piece of that label.
Give exactly one of them. The crop is a cube of the piece's bounding box plus `--pad-mm`, with the piece itself drawn in
white (dashed) and each label in the `visual-check` label colours with a legend.

Writes: <out>  the JPEG sheet (axis 0, 1, 2 cuts through the piece's centre; titles give the crop origin)
Prints: one JSON line {image, centre_zyx, bbox_zyx, voxels, volume_mm3, labels_under}; labels_under is the voxel count of each label under the piece
Example: python render_crops.py --hu hu.npy --labels labels.npy --component-at 410,220,130 --bone-hu 2500 --out crop.jpg
Exits 2 with one sentence on the input it checks; a missing file is a Python error.
"""

import numpy as np
import viewlib as vl
from scipy import ndimage as ndi

sl = vl.sidecar


def piece(mask, seed=None):
    lab, _n = ndi.label(mask, np.ones((3, 3, 3)))
    if seed is not None:
        k = lab[tuple(seed)]
        if k == 0:
            sl.fail(f'voxel {list(seed)} is not inside a bone component at this threshold: pick a voxel on the piece')
        return lab == k
    sizes = np.bincount(lab.ravel())[1:]
    if not len(sizes):
        sl.fail('the label has no voxels')
    return lab == (np.argmax(sizes) + 1)


if __name__ == '__main__':
    ap = sl.parser(__doc__)
    ap.add_argument('--hu', required=True, help='hu.npy of the scan')
    ap.add_argument('--labels', required=True, help='label volume .npy on the scan grid')
    ap.add_argument('--out', required=True, help='the image to write (.jpg)')
    ap.add_argument('--component-at', metavar='z,y,x', help='scan voxel indices inside the piece of bone to show; needs --bone-hu')
    ap.add_argument('--label', type=int, help='show the largest piece of this label id')
    ap.add_argument('--bone-hu', type=float, help='HU at or above which a voxel is bone, defining the piece for --component-at')
    ap.add_argument('--header', help='hu.json, for spacing (default: the labels sidecar)')
    ap.add_argument('--pad-mm', type=float, default=1.5, help='mm of margin around the piece')
    ap.add_argument('--window', metavar='lo,hi', help='display window in HU (default: automatic)')
    ap.add_argument('--names', help='label names, 1=femur,2=tibia or an anatomy.json')
    a = ap.parse_args()
    if a.component_at is not None and a.bone_hu is None:
        sl.fail('--component-at needs --bone-hu: the HU threshold that defines a piece of bone')
    if (a.component_at is None) == (a.label is None):
        sl.fail('give exactly one of --component-at or --label')
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels, mmap_mode='r')
    sp = sl.grid(a.header or str(sl.sidecar_path(a.labels)))['spacing_zyx_mm']
    if a.label is not None:
        m = piece(np.asarray(labels) == a.label)
    else:
        seed = [int(v) for v in a.component_at.split(',')]
        z, y, x = seed
        pad0 = [round(a.pad_mm * 6 / s) for s in sp]  # work in a window around the seed, not the whole scan
        lo = [max(0, c - p) for c, p in zip(seed, pad0)]
        hi = [min(n, c + p) for n, c, p in zip(hu.shape, seed, pad0)]
        sub = tuple(slice(l_, h_) for l_, h_ in zip(lo, hi))
        mm = np.zeros(hu.shape, bool)
        mm[sub] = piece(np.asarray(hu[sub]) >= a.bone_hu, [c - l_ for c, l_ in zip(seed, lo)])
        m = mm
    pts = np.argwhere(m)
    centre = [int(v) for v in pts.mean(0).round()]
    pad = [round(a.pad_mm / s) for s in sp]
    lo = [max(0, int(p) - q) for p, q in zip(pts.min(0), pad)]
    hi = [min(n, int(p) + q + 1) for n, p, q in zip(hu.shape, pts.max(0), pad)]
    sub = tuple(slice(l_, h_) for l_, h_ in zip(lo, hi))
    c = [ce - l_ for ce, l_ in zip(centre, lo)]
    img = np.asarray(hu[sub])
    lab = np.asarray(labels[sub]).astype(np.int32)
    mm = m[sub]
    window = vl.parse_window(a.window) if a.window else vl.auto_window(img)
    cut = [lambda v: v[c[0]], lambda v: v[:, c[1]], lambda v: v[:, :, c[2]]]
    fig = vl.fig_for(3 * 600, 600)
    for i, (f, nm) in enumerate(zip(cut, ('axis 0', 'axis 1', 'axis 2'))):
        ax = fig.add_axes([i / 3, 0, 1 / 3, 1])
        vl.show_slice(ax, f(img), window, grid=False, title=f'{nm} = {c[i]} (crop origin {lo})')
        vl.draw_labels(ax, f(lab))
        ax.contour(f(mm).astype(float), levels=[0.5], colors=['white'], linewidths=1.0, linestyles='dashed')
    vl.draw_legend(fig, [int(k) for k in np.unique(lab[lab > 0])], vl.parse_names(a.names), loc='upper left')
    sl.save_image(fig, a.out)
    sl.emit(image=a.out, centre_zyx=centre, bbox_zyx=[lo, hi], voxels=int(m.sum()),
            volume_mm3=round(float(m.sum()) * float(np.prod(sp)), 4),
            labels_under={int(k): int(v) for k, v in zip(*np.unique(lab[mm], return_counts=True))})
