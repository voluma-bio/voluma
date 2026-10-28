"""Label tint plus outline over the CT on the keyframe and two orthogonal cuts: is each label on the right bone, is any
bone unlabelled? The 2D check; it catches gross errors and can miss a small fragment, so pair it with the 3D sheet.

  python render_overlay.py --hu hu.npy --labels labels.npy --frame frame.json --out overlay.jpg
        [--center s,r,c] [--window 1000,8000] [--names 1=femur,2=tibia | anatomy.json] [--grid]
  python render_overlay.py --hu oriented.npy --labels labels_oriented.npy --out overlay.jpg     (arrays already on one grid)

With `--frame`, `hu` and `labels` are on the scan grid and the cuts are taken in the oriented frame (slice, row, column
of the oriented stack): the keyframe, a cut at row `r` and a cut at column `c`. Without it, the three cuts are axes 0, 1, 2
of the given arrays through `--center`. The default centre is the keyframe and the middle of the labelled pixels on it.
"""
import argparse
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path, so every directory a script imports from is added here.
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'microct-core/resources')]
try:
    import viewlib as vl
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects <workflows>/microct-analysis/skills/<skill>/resources/ with '
             '<workflows>/microct-analysis/skills/microct-core/resources/sidecar.py beside it')

sl = vl.sidecar


def planes(hu, labels, frame, center):
    if frame:
        s, r, c = center
        cuts = [(0, s), (1, r), (2, c)]
        return [(vl.frame_cut(hu, frame, ax, i), vl.frame_cut(labels, frame, ax, i, order=0).astype(np.int32))
                for ax, i in cuts], cuts
    cuts = list(enumerate(center))
    pick = [lambda v, i: v[i], lambda v, i: v[:, i], lambda v, i: v[:, :, i]]
    return [(np.asarray(pick[ax](hu, i)), np.asarray(pick[ax](labels, i)).astype(np.int32)) for ax, i in cuts], cuts


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--hu', required=True)
    ap.add_argument('--labels', required=True)
    ap.add_argument('--frame')
    ap.add_argument('--out', required=True)
    ap.add_argument('--center', help='s,r,c (with --frame) or z,y,x (without)')
    ap.add_argument('--window')
    ap.add_argument('--names', help='1=femur,2=tibia, or the anatomy.json path for every label name')
    ap.add_argument('--grid', action='store_true')
    a = ap.parse_args()
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels, mmap_mode='r')
    if hu.shape != labels.shape:
        sl.fail(f'hu {hu.shape} and labels {labels.shape} are on different grids: pass arrays on the same grid')
    frame = vl.load_frame(a.frame) if a.frame else None
    if a.center:
        center = [int(v) for v in a.center.split(',')]
    elif frame:
        k = frame['keyframe']
        key_lab = vl.frame_cut(labels, frame, 0, k, order=0)
        rr, cc = np.nonzero(key_lab)
        center = [k, int(rr.mean()) if len(rr) else frame['shape_srs'][1] // 2,
                  int(cc.mean()) if len(cc) else frame['shape_srs'][2] // 2]
    else:
        center = [n // 2 for n in hu.shape]
    cuts, idx = planes(hu, labels, frame, center)
    window = vl.parse_window(a.window) if a.window else vl.auto_window(cuts[0][0])
    names = vl.parse_names(a.names)
    widths = [c[0].shape[1] for c in cuts]
    height = max(c[0].shape[0] for c in cuts)
    fig = vl.fig_for(sum(widths), height)
    x = 0.0
    for (img, lab), (axis, i), w in zip(cuts, idx, widths):
        ax = fig.add_axes([x / sum(widths), 1 - img.shape[0] / height, w / sum(widths), img.shape[0] / height])
        vl.show_slice(ax, img, window, grid=a.grid, title=f'axis {axis} = {i}')
        vl.draw_labels(ax, lab)
        x += w
    present = sorted({int(v) for _, lab in cuts for v in np.unique(lab[lab > 0])})
    vl.draw_legend(fig, present, names)
    sl.save_image(fig, a.out)
    sl.emit(image=a.out, center=center, labels_in_view=present)
