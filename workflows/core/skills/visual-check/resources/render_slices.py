"""Render one slice with a pixel grid, and optional boxes and points drawn on it: the keyframe sheet and the check
that a box or pick is where you meant.

  python render_slices.py --in oriented.npy --index 159 --out /outputs/orient/keyframe.jpg [--grid]
        [--window 1000,8000] [--boxes r0,c0,r1,c1[:name] ...] [--points r,c[:name] ...]

`--in` is a 3D stack (slice `--index` along axis 0) or a 2D image. x is the column (top labels), y the row (left labels).
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
    sys.exit(f'{e}: this script expects <workflows>/core/skills/<skill>/resources/ with '
             '<workflows>/core/skills/microct-core/resources/sidecar.py beside it')

sl = vl.sidecar


def parse_items(items, n):
    out = []
    for it in items or []:
        body, _, name = it.partition(':')
        out.append(([int(v) for v in body.split(',')], name or None))
        if len(out[-1][0]) != n:
            sl.fail(f'"{it}": expected {n} comma-separated integers')
    return out


def render(img, out, window=None, grid=True, boxes=(), points=(), title=None):
    h, w = img.shape
    fig = vl.fig_for(w, h)
    ax = fig.add_axes([0, 0, 1, 1])
    vl.show_slice(ax, img, window or vl.auto_window(img), grid=grid, title=title)
    for box, name in boxes:
        vl.draw_box(ax, box, name)
    for pt, name in points:
        vl.draw_point(ax, pt, name)
    sl.save_image(fig, out)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--index', type=int, help='slice along axis 0 of a 3D stack')
    ap.add_argument('--out', required=True)
    ap.add_argument('--window', help='lo,hi in the volume units (HU); default: from the data')
    ap.add_argument('--grid', action='store_true', help='draw a 100 px grid with coordinates')
    ap.add_argument('--boxes', nargs='*', help='r0,c0,r1,c1[:name]')
    ap.add_argument('--points', nargs='*', help='r,c[:name]')
    a = ap.parse_args()
    v = np.load(a.src, mmap_mode='r')
    if v.ndim == 3:
        if a.index is None:
            sl.fail('--index is required for a 3D stack')
        if not 0 <= a.index < v.shape[0]:
            sl.fail(f'--index {a.index} is outside 0..{v.shape[0] - 1}')
        img = np.asarray(v[a.index])
    else:
        img = np.asarray(v)
    render(img, a.out, vl.parse_window(a.window) if a.window else None, a.grid,
           parse_items(a.boxes, 4), parse_items(a.points, 2), title=f'{Path(a.src).name} slice {a.index}')
    sl.emit(image=a.out, shape_rc=list(img.shape), index=a.index, boxes=len(a.boxes or []), points=len(a.points or []))
