"""Render one slice of a stack or image as a JPEG, with an optional pixel grid, boxes and points drawn on it.

Used for the keyframe sheet and to check that a box or a pick is where you meant. `--in` is a 3D stack (slice `--index`
along axis 0) or a 2D image. x is the column (top labels), y the row (left labels); boxes and points are in pixels.

Writes: <out>  the JPEG, one pixel per array element (at most 2000 px, 1 MiB)
Prints: one JSON line {image, shape_rc, index, boxes, points}
Example: python render_slices.py --in oriented.npy --index 159 --out keyframe.jpg --grid --points 120,300:landmark
Exits 2 with one sentence on the input it checks; a missing file is a Python error.
"""
from pathlib import Path

import numpy as np
import viewlib as vl

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
    ap = sl.parser(__doc__)
    ap.add_argument('--in', dest='src', required=True, help='a 3D stack or a 2D image, .npy')
    ap.add_argument('--index', type=int, help='slice along axis 0 of a 3D stack (required for a 3D stack)')
    ap.add_argument('--out', required=True, help='the image to write (.jpg)')
    ap.add_argument('--window', metavar='lo,hi', help='display window in the volume\'s units, HU (default: from the data)')
    ap.add_argument('--grid', action='store_true', help='draw a 100 px grid with coordinates')
    ap.add_argument('--boxes', nargs='*', metavar='BOX', help='boxes as r0,c0,r1,c1[:name], in pixels, row then column')
    ap.add_argument('--points', nargs='*', metavar='POINT', help='points as r,c[:name], in pixels, row then column')
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
