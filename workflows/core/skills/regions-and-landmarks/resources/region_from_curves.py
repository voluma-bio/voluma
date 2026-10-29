"""Make a region mask from curves traced on slices: between two surfaces, or a polygon swept between slices.

Two modes (`between --help`, `polygon --help` give each one's schema and options). The region can then be clipped to a bone
mask (`--bone`, or `--labels` with `--ids`) and kept `--clearance-mm` inside the mask's outer surface: for a filled bone that is the
periosteum, so the cortex stays inside the region; a clearance from the inner cortex needs the cortex depth added, which is
the protocol's job. The grid's shape comes from `--hu`, `--bone` or `--labels` (one is required). Trace on slices you have
looked at with a pixel grid (`visual-check`); fewer than about five traced slices across a curved region gives a coarse
surface. An empty region, a bone mask of another shape and curves with too few points are refused.

Writes: <out>/region.npy  bool, the grid of --grid, with its sidecar
        <out>/region-check.jpg  four slices across the region: region cyan, bone orange (with --hu and a bone), traced curve red
Prints: one JSON line {region, check, voxels, volume_mm3, bbox_zyx}; bbox_zyx is [[min z, y, x], [max z, y, x + 1]]
Example: python region_from_curves.py between --surface-a A.json --surface-b B.json --grid hu.json --bone bone.npy --out DIR
         python region_from_curves.py polygon --polygons poly.json --grid hu.json --bone bone.npy --out DIR
Exits 2 with one sentence on bad input, before writing anything.
"""

import json
import sys
from pathlib import Path

import matplotlib
import numpy as np
from scipy import ndimage as ndi
from skimage.draw import polygon as draw_polygon

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/;
# only missing directories are added, so a script imported by another leaves the importer's order alone.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [d for d in (str(HERE), str(SKILLS / 'microct-core/resources')) if d not in sys.path]
try:
    import sidecar
except ModuleNotFoundError as e:
    print(f'{e}: a skill this script imports is missing; it expects <workflows>/core/skills/<skill>/resources/, or '
          '<workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it', file=sys.stderr)
    sys.exit(2)


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
    ap = sidecar.parser(__doc__)
    sub = ap.add_subparsers(dest='cmd', required=True)
    between_doc = """The voxels between two surfaces along one axis, over the traced slices.

Each surface is a curves JSON, or a 2D .npy height map (then give --axis and --height-axis). Curves JSON: one polyline per
traced slice, [row, col] points on that slice (rows are the lower-numbered of the two axes left after `axis`; `height`
says whether the surface height is the `row` or the `col`; default row):
  {"axis": 1, "height": "row", "slices": {"100": [[140, 80], [123, 95], [122, 120]], "190": [[138, 80], [103, 100]]}}
A polyline is read as height as a function of the other coordinate, joined linearly. Between traced slices the surface is
joined linearly; the region exists only between the first and last traced slices (or --slice-range) and only where the
polylines reach along the other axis. --offset-a-mm and --offset-b-mm move a surface along the height axis, which makes a
slab at a set distance from a surface. Both surfaces must use the same slice and height axes. This schema and
`surface_from_curves` are the only way surfaces are traced and interpolated."""
    polygon_doc = """A polygon traced on slices, swept between them.

--polygons is {"axis": 0, "slices": {"230": [[row, col], ...], "270": [[row, col], ...]}}: one closed outline (at least
three points) per traced slice, at least two slices. Slices between are interpolated by signed distance, so the outline
morphs smoothly; it is not an extrusion. Trace slices where the shape changes, and at the ends of the region."""
    b = sub.add_parser('between', help='the region between two traced surfaces', description=between_doc, formatter_class=sidecar.HelpFormatter)
    b.add_argument('--surface-a', required=True, help='curves JSON, or a 2D height map .npy (axis-length by other-axis-length)')
    b.add_argument('--surface-b', required=True, help='the second surface, same form and same axes as --surface-a')
    b.add_argument('--axis', type=int, help='slice axis (0-2), needed with a .npy height map')
    b.add_argument('--height-axis', type=int, help='axis (0-2) the surface heights are indices of, needed with a .npy map')
    b.add_argument(
        '--offset-a-mm', type=float, default=0, help='mm: move surface A along the height axis (+ = higher index)'
    )
    b.add_argument('--offset-b-mm', type=float, default=0, help='mm: move surface B along the height axis (+ = higher index)')
    b.add_argument('--slice-range', type=int, nargs=2, metavar=('FIRST', 'LAST'), help='limit the region to these slices (inclusive; default: the slices both surfaces were traced on)')
    p = sub.add_parser('polygon', help='a polygon traced on slices, swept between them', description=polygon_doc, formatter_class=sidecar.HelpFormatter)
    p.add_argument('--polygons', required=True, help='JSON file, described above')
    for q in (b, p):
        q.add_argument('--grid', required=True, help='hu.json or a sidecar of the grid the curves and masks are on')
        q.add_argument('--bone', help='bool .npy: keep only the region inside this mask')
        q.add_argument('--labels', help='label .npy, with --ids, instead of --bone')
        q.add_argument('--ids', type=int, nargs='+', help='label ids that make up the bone, with --labels')
        q.add_argument(
            '--clearance-mm', type=float, default=0, help='mm: also drop voxels closer than this to the outer surface of the bone mask you pass (periosteum for a filled bone, not the inner surface of the cortex)'
        )
        q.add_argument('--hu', help='hu.npy: background for the check image, and the grid shape')
        q.add_argument('--out', required=True, help='output directory (created)')
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
