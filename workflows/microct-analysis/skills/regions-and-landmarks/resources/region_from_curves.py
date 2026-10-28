"""A region mask from curves traced on slices: the space between two surfaces, or a polygon swept between slices.

  between   two surfaces, each traced as one polyline per slice (or given as a 2D height map), interpolated across
            slices; the region is every voxel between them along one axis, and only where the curves reach
  polygon   one closed outline per traced slice, interpolated between traced slices by signed distance

The region can then be clipped to a bone mask and kept a clearance (mm) inside the mask's outer surface.
Writes region.npy (bool, same grid as --grid) with its sidecar, and region-check.jpg. Schemas: ../SKILL.md.
"""

import argparse
import json
import sys
from pathlib import Path

import matplotlib
import numpy as np
from scipy import ndimage as ndi
from skimage.draw import polygon as draw_polygon

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path, so every directory a script imports from is added here.
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'microct-core/resources')]
try:
    import sidecar
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects <workflows>/microct-analysis/skills/<skill>/resources/ with '
             '<workflows>/microct-analysis/skills/microct-core/resources/sidecar.py beside it')


matplotlib.use('Agg')
import matplotlib.pyplot as plt


def other_axes(axis):
    return [i for i in range(3) if i != axis]


def surface_from_curves(spec, shape):
    """Height map H[slice, other] (voxel index along the height axis) from polylines [row, col], one per slice.

    Each polyline is read as height = f(position along the other in-plane axis), interpolated linearly, constant
    beyond its ends; between traced slices H is interpolated linearly, constant beyond the first and last.
    Also returns valid[slice, other]: True where the traced curves reach (their end points, interpolated across slices).
    """
    axis = spec['axis']
    rows_ax, cols_ax = other_axes(axis)
    height_is_row = spec.get('height', 'row') == 'row'
    h_ax, o_ax = (rows_ax, cols_ax) if height_is_row else (cols_ax, rows_ax)
    levels = sorted(int(k) for k in spec['slices'])
    if not levels:
        sidecar.fail('the curves JSON has no slices')
    per_slice, left, right = [], [], []
    for k in levels:
        pts = np.asarray(spec['slices'][str(k)], float)
        if pts.ndim != 2 or pts.shape[1] != 2 or len(pts) < 2:
            sidecar.fail(f'slice {k}: a curve is a list of at least two [row, col] points')
        h, o = (pts[:, 0], pts[:, 1]) if height_is_row else (pts[:, 1], pts[:, 0])
        order = np.argsort(o)
        left.append(o.min())
        right.append(o.max())
        per_slice.append(np.interp(np.arange(shape[o_ax]), o[order], h[order]))
    per_slice = np.array(per_slice)
    H = np.array([np.interp(np.arange(shape[axis]), levels, per_slice[:, j]) for j in range(shape[o_ax])]).T
    pos = np.arange(shape[o_ax])[None, :]
    lo = np.interp(np.arange(shape[axis]), levels, left)[:, None]
    hi = np.interp(np.arange(shape[axis]), levels, right)[:, None]
    return H, axis, h_ax, o_ax, (levels[0], levels[-1]), (pos >= lo) & (pos <= hi)


def surface_from_map(path, axis, height_axis, shape):
    H = np.load(path).astype(float)
    o_ax = next(i for i in range(3) if i not in (axis, height_axis))
    if H.shape != (shape[axis], shape[o_ax]):
        sidecar.fail(
            f'height map {path} is {H.shape}: it must be (axis {axis} length, axis {o_ax} length) = '
            f'{(shape[axis], shape[o_ax])}'
        )
    return H, axis, height_axis, o_ax, (0, shape[axis] - 1), np.ones(H.shape, bool)


def load_surface(arg, shape, hint):
    if arg.endswith('.npy'):
        if hint is None:
            sidecar.fail('a .npy height map needs --axis (the slice axis) and --height-axis')
        return surface_from_map(arg, hint[0], hint[1], shape)
    return surface_from_curves(json.loads(Path(arg).read_text()), shape)


def between(a, shape, grid):
    sp = np.asarray(grid['spacing_zyx_mm'], float)
    hint = (a.axis, a.height_axis) if a.axis is not None and a.height_axis is not None else None
    Ha, axis, h_ax, o_ax, ra, va = load_surface(a.surface_a, shape, hint)
    Hb, axis_b, h_ax_b, _, rb, vb = load_surface(a.surface_b, shape, hint)
    if (axis, h_ax) != (axis_b, h_ax_b):
        sidecar.fail('the two surfaces use different slice or height axes: trace both on the same slices and height')
    Ha = Ha + a.offset_a_mm / sp[h_ax]
    Hb = Hb + a.offset_b_mm / sp[h_ax]
    lo, hi = np.minimum(Ha, Hb), np.maximum(Ha, Hb)
    # canonical order (slice axis, other axis, height axis) for broadcasting, then back
    perm = [axis, o_ax, h_ax]
    hh = np.arange(shape[h_ax])[None, None, :]
    canon = (hh >= lo[:, :, None]) & (hh < hi[:, :, None]) & (va & vb)[:, :, None]
    region = np.transpose(canon, np.argsort(perm))
    if a.slice_range:
        s0, s1 = a.slice_range
    else:
        s0, s1 = max(ra[0], rb[0]), min(ra[1], rb[1])
    keep = np.zeros(shape[axis], bool)
    keep[s0 : s1 + 1] = True
    return region & keep.reshape([-1 if i == axis else 1 for i in range(3)]), axis, (s0, s1)


def polygon_sweep(a, shape):
    spec = json.loads(Path(a.polygons).read_text())
    axis = spec['axis']
    rows_ax, cols_ax = other_axes(axis)
    levels = sorted(int(k) for k in spec['slices'])
    if len(levels) < 2:
        sidecar.fail('trace the polygon on at least two slices: the region lies between the first and the last')
    plane = (shape[rows_ax], shape[cols_ax])
    sdf = []
    for k in levels:
        pts = np.asarray(spec['slices'][str(k)], float)
        if pts.ndim != 2 or pts.shape[1] != 2 or len(pts) < 3:
            sidecar.fail(f'slice {k}: a polygon is a list of at least three [row, col] points')
        m = np.zeros(plane, bool)
        m[draw_polygon(pts[:, 0], pts[:, 1], plane)] = True
        sdf.append(ndi.distance_transform_edt(m) - ndi.distance_transform_edt(~m))
    region = np.zeros(shape, bool)
    for i in range(len(levels) - 1):
        k0, k1 = levels[i], levels[i + 1]
        for k in range(k0, k1 + 1):
            t = (k - k0) / (k1 - k0)
            sl = [slice(None)] * 3
            sl[axis] = k
            region[tuple(sl)] = (1 - t) * sdf[i] + t * sdf[i + 1] > 0
    return region, axis, (levels[0], levels[-1]), spec


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    b = sub.add_parser('between', help='the region between two traced surfaces')
    b.add_argument('--surface-a', required=True, help='curves JSON, or a 2D height map .npy')
    b.add_argument('--surface-b', required=True)
    b.add_argument('--axis', type=int, help='slice axis, needed with a .npy height map')
    b.add_argument('--height-axis', type=int, help='axis the surface heights are indices of, needed with a .npy map')
    b.add_argument(
        '--offset-a-mm', type=float, default=0, help='move surface A along the height axis (+ = higher index)'
    )
    b.add_argument('--offset-b-mm', type=float, default=0)
    b.add_argument('--slice-range', type=int, nargs=2, help='limit the region to these slices (inclusive)')
    p = sub.add_parser('polygon', help='a polygon traced on slices, swept between them')
    p.add_argument('--polygons', required=True, help='JSON {"axis": n, "slices": {"index": [[row, col], ...]}}')
    for q in (b, p):
        q.add_argument('--grid', required=True)
        q.add_argument('--bone', help='bool .npy: keep only the region inside this mask')
        q.add_argument('--labels', help='label .npy, with --ids, instead of --bone')
        q.add_argument('--ids', type=int, nargs='+')
        q.add_argument(
            '--clearance-mm', type=float, default=0, help='also drop voxels closer than this to the outer surface of the bone mask you pass (periosteum for a filled bone, not the inner surface of the cortex)'
        )
        q.add_argument('--hu', help='hu.npy: background for the check image')
        q.add_argument('--out', required=True, help='output directory')
    a = ap.parse_args()

    g = sidecar.grid(a.grid)
    sp = np.asarray(g['spacing_zyx_mm'], float)
    inputs = [a.grid]
    if a.hu:
        hu = np.load(a.hu, mmap_mode='r')
        shape = hu.shape
        inputs.append(a.hu)
    elif a.bone or a.labels:
        shape = np.load(a.bone or a.labels, mmap_mode='r').shape
    else:
        sidecar.fail('pass --hu, --bone or --labels so the region has a grid shape')
    curves = []
    if a.cmd == 'between':
        region, axis, srange = between(a, shape, g)
        inputs += [x for x in (a.surface_a, a.surface_b)]
        for x in (a.surface_a, a.surface_b):
            if not x.endswith('.npy'):
                curves.append(json.loads(Path(x).read_text()))
    else:
        region, axis, srange, spec = polygon_sweep(a, shape)
        inputs.append(a.polygons)
        curves.append(spec)
    bone = None
    if a.bone or a.labels:
        if a.bone:
            bone = np.load(a.bone)
            inputs.append(a.bone)
        else:
            if not a.ids:
                sidecar.fail('--labels needs --ids')
            bone = np.isin(np.load(a.labels, mmap_mode='r'), a.ids)
            inputs.append(a.labels)
        if bone.shape != region.shape:
            sidecar.fail(f'bone mask shape {bone.shape} differs from the grid shape {region.shape}')
        region &= bone
        if a.clearance_mm > 0:
            region &= ndi.distance_transform_edt(np.pad(bone, 1), sampling=sp)[1:-1, 1:-1, 1:-1] > a.clearance_mm
    if not region.any():
        sidecar.fail('the region is empty: check the curves against the bone with the check image, and the axes')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / 'region.npy', region)
    sidecar.write(
        out / 'region.npy',
        like=a.grid,
        inputs=inputs,
        params=dict(
            mode=a.cmd,
            slice_axis=axis,
            slice_range=list(srange),
            clearance_mm=a.clearance_mm,
            **({'offset_a_mm': a.offset_a_mm, 'offset_b_mm': a.offset_b_mm} if a.cmd == 'between' else {}),
        ),
    )
    check = out / 'region-check.jpg'
    check_figure(check, region, bone, hu if a.hu else None, axis, srange, curves)
    nz = np.argwhere(region)
    sidecar.emit(
        region=str(out / 'region.npy'),
        check=str(check),
        voxels=int(region.sum()),
        volume_mm3=float(region.sum() * np.prod(sp)),
        bbox_zyx=[[int(v) for v in nz.min(0)], [int(v) for v in nz.max(0) + 1]],
    )


def check_figure(path, region, bone, hu, axis, srange, curves):
    nz = np.argwhere(region)
    lo, hi = nz[:, axis].min(), nz[:, axis].max()
    idx = sorted({round(v) for v in np.linspace(lo, hi, 4)})
    rows_ax, cols_ax = other_axes(axis)
    r0, c0 = nz[:, rows_ax].min(), nz[:, cols_ax].min()
    r1, c1 = nz[:, rows_ax].max() + 1, nz[:, cols_ax].max() + 1
    m = 20
    r0, c0, r1, c1 = max(r0 - m, 0), max(c0 - m, 0), r1 + m, c1 + m
    fig, axs = plt.subplots(1, len(idx), figsize=(min(6.5 * len(idx), 20), 6.5), squeeze=False)
    for ax, i in zip(axs[0], idx):
        t = [slice(None)] * 3
        t[axis] = i
        t = tuple(t)
        if hu is not None:
            ax.imshow(np.asarray(hu[t]), cmap='gray')
        elif bone is not None:
            ax.imshow(bone[t], cmap='gray')
        else:
            ax.imshow(np.zeros(region[t].shape), cmap='gray')
        if region[t].any():
            ax.contour(region[t], levels=[0.5], colors='cyan', linewidths=1)
        if bone is not None and hu is not None:
            ax.contour(bone[t], levels=[0.5], colors='orange', linewidths=0.5)
        for c in curves:
            if c.get('axis') == axis and str(i) in c['slices']:
                pts = np.array(c['slices'][str(i)])
                ax.plot(pts[:, 1], pts[:, 0], 'r-', lw=1)
        ax.set_xlim(c0, c1)
        ax.set_ylim(r1, r0)
        ax.set_title(
            f'axis {axis} index {i}: region cyan'
            + (', bone orange' if hu is not None and bone is not None else '')
            + (', traced curve red' if curves else ''),
            fontsize=9,
        )
    fig.tight_layout()
    sidecar.save_image(fig, path)
    plt.close(fig)


if __name__ == '__main__':
    main()
