"""Snap a pick made on a rendered view or a slice to the bone, as voxel indices on the scan grid, and draw it.

  surface   a pixel on a 3D render: cast the view's ray into the mask, snap to the first surface voxel it meets
            (or, if the ray misses, the surface voxel nearest the ray)
  slice     a pixel on an axis-aligned slice: snap by `center`, `nearest`, `edge_min`, `edge_max` or `exact`

Writes points.json (zyx voxel indices on the grid of --grid, snap distance in mm) and pick-check.jpg: the pick (red x)
and where it snapped (green circle) drawn on the view. Look at pick-check.jpg before you keep the points.
Input schema: ../SKILL.md.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import matplotlib
import numpy as np
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'microct-core/resources'))
import sidecar

matplotlib.use('Agg')
import matplotlib.pyplot as plt


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n else v


class View:
    """A pinhole camera on a rendered image. Vectors are zyx voxel indices; maths is done in mm, in xyz order
    (a zyx cross product has the opposite handedness to the renderer's)."""

    def __init__(self, camera, size, spacing_zyx_mm):
        self.sp = np.asarray(spacing_zyx_mm, float)
        self.w, self.h = size
        pos = np.asarray(camera['position'], float) * self.sp
        focal = np.asarray(camera['focal_point'], float) * self.sp
        up = np.asarray(camera['view_up'], float) * self.sp
        self.pos = pos[::-1]
        self.dir = unit(focal[::-1] - self.pos)
        self.right = unit(np.cross(self.dir, up[::-1]))
        self.up = np.cross(self.right, self.dir)
        self.tan = math.tan(math.radians(float(camera['view_angle']) / 2))
        self.aspect = self.w / self.h

    def ray(self, col, row):
        nx = (2 * col / self.w - 1) * self.tan * self.aspect
        ny = (1 - 2 * row / self.h) * self.tan
        return unit(self.dir + nx * self.right + ny * self.up)

    def project(self, zyx_idx):
        """Pixel (col, row) of a voxel index, or None if it is behind the camera."""
        v = np.asarray(zyx_idx, float)[::-1] * self.sp[::-1] - self.pos
        depth = v @ self.dir
        if depth <= 0:
            return None
        nx = (v @ self.right) / depth / (self.tan * self.aspect)
        ny = (v @ self.up) / depth / self.tan
        return (nx + 1) / 2 * self.w, (1 - ny) / 2 * self.h


def surface_voxels(mask):
    return mask & ~ndi.binary_erosion(mask)


def snap_to_surface(view, mask, tree, surf_idx, col, row):
    sp = view.sp
    d = view.ray(col, row)
    step = float(sp.min()) * 0.5
    far = float(np.linalg.norm(np.array(mask.shape) * sp)) * 2
    t = np.arange(0, far, step)
    pts_zyx = ((view.pos[None, :] + t[:, None] * d[None, :])[:, ::-1]) / sp
    idx = np.rint(pts_zyx).astype(int)
    inside = np.all((idx >= 0) & (idx < np.array(mask.shape)), axis=1)
    hit = np.zeros(len(t), bool)
    hit[inside] = mask[tuple(idx[inside].T)]
    if hit.any():
        first = int(np.argmax(hit))
        dist, j = tree.query(pts_zyx[first] * sp)
        return surf_idx[j], float(dist), 'ray_hit'
    # Ray misses: the surface voxel closest to the ray, in front of the camera.
    p_xyz = surf_idx[:, ::-1] * sp[::-1] - view.pos
    along = p_xyz @ d
    off = np.linalg.norm(p_xyz - along[:, None] * d[None, :], axis=1)
    off[along <= 0] = np.inf
    j = int(np.argmin(off))
    if not np.isfinite(off[j]):
        sidecar.fail('the mask is behind the camera: check the camera position and focal_point')
    return surf_idx[j], float(off[j]), 'nearest_to_ray'


def snap_to_slice(mask, axis, index, col, row, mode):
    if not 0 <= index < mask.shape[axis]:
        sidecar.fail(f'slice index {index} is outside axis {axis} (0..{mask.shape[axis] - 1})')
    plane = np.take(mask, index, axis=axis)
    rest = [i for i in range(3) if i != axis]
    on = np.argwhere(plane)

    def to3(r, c):
        z = [0, 0, 0]
        z[axis], z[rest[0]], z[rest[1]] = index, r, c
        return z

    if mode == 'exact' or len(on) == 0:
        note = 'exact' if mode == 'exact' else f'no mask on slice {index}: raw pick kept'
        r, c = row, col
    elif mode == 'center':
        r, c = on.mean(axis=0)
        note = f'centroid of the mask on slice {index}'
    elif mode == 'nearest':
        k = int(np.argmin(((on - [row, col]) ** 2).sum(axis=1)))
        r, c = on[k]
        note = 'nearest mask pixel'
    elif mode in ('edge_min', 'edge_max'):
        c = on[:, 1].min() if mode == 'edge_min' else on[:, 1].max()
        r = np.median(on[on[:, 1] == c][:, 0])
        note = f'{mode[5:]} of the in-plane column axis on slice {index}'
    else:
        sidecar.fail(f'unknown snap mode {mode!r}: use exact, center, nearest, edge_min or edge_max')
    z = to3(float(r), float(c))
    on_mask = (
        bool(plane[round(r), round(c)])
        if 0 <= round(r) < plane.shape[0] and 0 <= round(c) < plane.shape[1]
        else False
    )
    return z, note, on_mask, rest


def load_mask(a):
    if a.mask:
        m = np.load(a.mask, mmap_mode='r')
        if m.dtype != bool:
            sidecar.fail(f'{a.mask} is {m.dtype}, not bool: pass --labels with --ids for a label volume')
        return np.asarray(m), [a.mask]
    if not a.labels or not a.ids:
        sidecar.fail('pass --mask bone.npy (bool), or --labels labels.npy with --ids 1 2 ...')
    return np.isin(np.load(a.labels, mmap_mode='r'), a.ids), [a.labels]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--picks', required=True, help='JSON of the picks and the view; schema in SKILL.md')
    ap.add_argument('--mask', help='bool .npy of the structure to snap to')
    ap.add_argument('--labels', help='label .npy, with --ids')
    ap.add_argument('--ids', type=int, nargs='+')
    ap.add_argument('--grid', required=True, help='hu.json or a sidecar of the grid the mask is on')
    ap.add_argument('--hu', help='hu.npy: background for the slice picture (slice mode)')
    ap.add_argument('--out', required=True, help='output directory')
    a = ap.parse_args()
    spec = json.loads(Path(a.picks).read_text())
    g = sidecar.grid(a.grid)
    sp = np.asarray(g['spacing_zyx_mm'], float)
    mask, inputs = load_mask(a)
    if not mask.any():
        sidecar.fail('the mask is empty: nothing to snap to')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    mode = spec.get('mode')
    results = []
    fig_path = out / 'pick-check.jpg'
    if mode == 'surface':
        from PIL import Image

        img = Image.open(spec['image']).convert('RGB')
        inputs.append(spec['image'])
        view = View(spec['camera'], img.size, sp)
        box = tuple(slice(max(b.start - 1, 0), b.stop + 1) for b in ndi.find_objects(mask.astype(np.uint8))[0])
        surf = np.argwhere(surface_voxels(mask[box])) + [b.start for b in box]
        tree = cKDTree(surf * sp)
        fig = plt.figure(figsize=(img.size[0] / 100, img.size[1] / 100))
        ax = fig.add_axes((0.04, 0.04, 0.95, 0.95))
        ax.imshow(img)
        for p in spec['picks']:
            col, row = p['pixel']
            zyx, dist, how = snap_to_surface(view, mask, tree, surf, col, row)
            results.append(
                {
                    'name': p['name'], 'zyx': [int(v) for v in zyx], 'snap_distance_mm': dist, 'method': how, 'pick_pixel': [col, row]
                }
            )
            draw(ax, p['name'], (col, row), view.project(zyx))
    elif mode == 'slice':
        axis = spec['axis']
        fig = plt.subplots(figsize=(9, 9))[0]
        ax = fig.axes[0]
        shown = {}
        for p in spec['picks']:
            col, row = p['pixel']
            zyx, note, on_mask, rest = snap_to_slice(mask, axis, p['index'], col, row, p.get('snap', 'nearest'))
            d_mm = float(
                np.linalg.norm(
                    (np.array(zyx) - [p['index'] if i == axis else (row if i == rest[0] else col) for i in range(3)])
                    * sp
                )
            )
            results.append(
                {
                    'name': p['name'],
                    'zyx': [round(v, 2) for v in zyx],
                    'snap_distance_mm': d_mm,
                    'method': note,
                    'on_mask': on_mask,
                    'pick_pixel': [col, row],
                    'slice_axis': axis,
                    'slice_index': p['index'],
                }
            )
            shown.setdefault(p['index'], []).append((p['name'], (col, row), (zyx[rest[1]], zyx[rest[0]])))
        fig.clf()
        n = len(shown)
        hu = np.load(a.hu, mmap_mode='r') if a.hu else None
        if hu is not None:
            inputs.append(a.hu)
        fig.set_size_inches(min(7 * n, 20), 7)
        for k, (index, items) in enumerate(sorted(shown.items())):
            ax = fig.add_subplot(1, n, k + 1)
            bg = np.asarray(np.take(hu, index, axis=axis)) if hu is not None else None
            if bg is not None:
                ax.imshow(bg, cmap='gray')
            m = np.take(mask, index, axis=axis)
            ax.contour(m, levels=[0.5], colors='cyan', linewidths=0.8)
            if bg is None:
                ax.imshow(~m, cmap='gray', vmin=-1, vmax=1.2, alpha=0.5)
            for name, pick, snapped in items:
                draw(ax, name, pick, snapped)
            ax.set_title(f'axis {axis} index {index}: columns run along axis {[i for i in range(3) if i != axis][1]}')
        fig.tight_layout()
    else:
        sidecar.fail('the picks JSON needs "mode": "surface" or "slice"')
    sidecar.save_image(fig, fig_path)
    plt.close(fig)
    (out / 'points.json').write_text(
        json.dumps(
            {
                'points': results,
                'grid_id': g['grid_id'],
                'spacing_zyx_mm': g['spacing_zyx_mm'],
                'mode': mode,
                'inputs': {str(p): sidecar.sha256_file(p) for p in inputs + [a.picks, a.grid]},
            },
            indent=1,
        )
        + '\n'
    )
    sidecar.emit(
        points=str(out / 'points.json'),
        check=str(fig_path),
        snapped=[{'name': r['name'], 'zyx': r['zyx'], 'snap_distance_mm': round(r['snap_distance_mm'], 4)} for r in results],
    )


def draw(ax, name, pick, snapped):
    ax.plot(*pick, 'x', color='red', ms=12, mew=2)
    if snapped is not None:
        ax.plot(*snapped, 'o', mfc='none', mec='lime', ms=14, mew=2)
    ax.annotate(name, pick, color='yellow', fontsize=12, xytext=(8, -8), textcoords='offset points')


if __name__ == '__main__':
    main()
