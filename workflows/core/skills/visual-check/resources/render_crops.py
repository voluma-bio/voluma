"""Crop sheet for one small component: three orthogonal cuts through its centre, with the labels outlined. For "what is this small unlabelled thing?" and "is it on the right bone?".

  python render_crops.py --hu hu.npy --labels labels.npy --out crop.jpg (--component-at z,y,x --bone-hu T | --label 5)
        [--pad-mm 1.5] [--window lo,hi] [--header hu.json] [--names 1=femur,2=tibia | anatomy.json]

`--component-at` picks the 3D piece of bone (labelled or not: voxels at or above `--bone-hu`) that contains the voxel; `--label` picks the largest piece
of that label. The crop is a cube of the piece's bounding box plus `--pad-mm`, with the piece itself drawn in white.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [str(HERE), str(SKILLS / 'microct-core/resources')]
try:
    import viewlib as vl
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects core/skills/microct-core/resources/ in a directory above it '
             '(<workflows>/core/skills/<skill>/resources/, or <workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it)')

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
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--hu', required=True)
    ap.add_argument('--labels', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--component-at')
    ap.add_argument('--label', type=int)
    ap.add_argument('--bone-hu', type=float, help='threshold defining a piece of bone, required with --component-at')
    ap.add_argument('--header', help='hu.json, for spacing (default: from the labels sidecar)')
    ap.add_argument('--pad-mm', type=float, default=1.5)
    ap.add_argument('--window')
    ap.add_argument('--names', help='1=femur,2=tibia, or the anatomy.json path for every label name')
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
