"""Shared drawing helpers for the visual-check renderers: label colours, windowing, pixel-grid figures, plane sampling and cuts through a frame.

Coordinates on every image the agent reads: x is the column (labelled along the top), y is the row (labelled down the
left side), both in pixels of the slice. A box is [row0, col0, row1, col1] = [y0, x0, y1, x1], ends inclusive.
"""
import hashlib
import json
import math
import os
import sys
from pathlib import Path

import matplotlib
import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [str(HERE), str(SKILLS / 'microct-core/resources')]
try:
    import frame as fr
    import sidecar
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects core/skills/microct-core/resources/ in a directory above it '
             '(<workflows>/core/skills/<skill>/resources/, or <workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it)')

matplotlib.use('Agg')
import matplotlib.pyplot as plt

# One palette for every render. 16 hues that stay apart on black and in a mesh shading; label N takes entry N-1, so the
# same structure has the same colour in the overlay, the 3D sheet and the disagreement panels.
PALETTE = ['#ff3b30', '#34c759', '#4f8dff', '#ffd60a', '#ff9f0a', '#bf5af2', '#40e0f0', '#ff4fd8',
           '#b6f23c', '#ffb3c7', '#1fa89a', '#d9c2ff', '#c8864b', '#fff3b0', '#8dffc2', '#a0a0a0']
GRID_COLOR = '#00e5ff'


def colour(label):
    return PALETTE[(int(label) - 1) % len(PALETTE)]


def parse_window(s):
    lo, hi = (float(x) for x in s.split(','))
    return lo, hi


def auto_window(img):
    """Bone-oriented window when the caller gave none: 1st percentile of the bright half to the 99.9th of all."""
    v = np.asarray(img).ravel()[::97]
    return float(np.percentile(v, 50)), float(np.percentile(v, 99.9))


def parse_names(s):
    """'1=femur,2=tibia' -> {1: 'femur', 2: 'tibia'}; a path to the anatomy reference's anatomy.json gives every label's name."""
    if not s:
        return {}
    if s.endswith('.json'):
        return {int(e['id']): e['name'] for e in json.loads(Path(s).read_text())['labels']}
    return {int(k): v for k, v in (p.split('=', 1) for p in s.split(','))}


def draw_legend(fig, ids, names, loc='upper left'):
    """A swatch and a name for every label in `ids`, in that label's colour; `label N` where no name was given."""
    if not ids:
        return
    handles = [matplotlib.patches.Patch(fc=colour(i), ec='none', label=f'{i} {names.get(i, "(unnamed)")}') for i in ids]
    fig.legend(handles=handles, loc=loc, ncol=min(len(handles), 6), fontsize=8, labelcolor='w', facecolor='k', edgecolor='none',
               framealpha=0.7, handlelength=1, columnspacing=1.2, borderpad=0.4)


def fig_for(w_px, h_px, max_px=sidecar.MAX_IMAGE_PX, dpi=100):
    """A figure whose pixel size is the slice's, scaled down to fit max_px on its longer side."""
    scale = min(1.0, max_px / max(w_px, h_px))
    return plt.figure(figsize=(w_px * scale / dpi, h_px * scale / dpi), dpi=dpi, facecolor='black')


def show_slice(ax, img, window, grid=True, step=100, title=None):
    h, w = img.shape
    ax.imshow(img, cmap='gray', vmin=window[0], vmax=window[1], interpolation='nearest')
    if grid:
        for v in range(0, w, step):
            ax.axvline(v, color=GRID_COLOR, lw=0.4, alpha=0.6)
            ax.text(v + 2, 12, str(v), color=GRID_COLOR, fontsize=8)
        for v in range(0, h, step):
            ax.axhline(v, color=GRID_COLOR, lw=0.4, alpha=0.6)
            ax.text(2, v - 3, str(v), color=GRID_COLOR, fontsize=8)
    if title:
        ax.text(w / 2, h - 10, title, color='w', ha='center', fontsize=9)
    ax.set_axis_off()


def draw_mask(ax, m, c, alpha=0.18):
    """Tint plus outline of the boolean 2D array `m`, in colour `c`."""
    ax.contour(m.astype(float), levels=[0.5], colors=[c], linewidths=1.2)
    ax.imshow(np.ma.masked_where(~m, m), cmap=matplotlib.colors.ListedColormap([c]), alpha=alpha, interpolation='nearest')


def draw_labels(ax, lab, alpha=0.18):
    """Tint plus outline for every label present in the 2D array `lab`."""
    for lv in np.unique(lab[lab > 0]):
        draw_mask(ax, lab == lv, colour(lv), alpha)


def draw_box(ax, box, name=None, color='#ff9f0a'):
    r0, c0, r1, c1 = box
    ax.add_patch(plt.Rectangle((c0, r0), c1 - c0, r1 - r0, fill=False, ec=color, lw=1.5))
    if name:
        ax.text(c0 + 3, r0 + 14, name, color=color, fontsize=9)


def draw_point(ax, rc, name=None, color='#ff9f0a'):
    ax.plot([rc[1]], [rc[0]], marker='+', color=color, ms=14, mew=2)
    if name:
        ax.text(rc[1] + 8, rc[0] - 6, name, color=color, fontsize=9)


def sample_plane(vol, to_index, centre_zyx, u, v, px, size, order=1, cval=0):
    """A plane of pixels cut from `vol` with `map_coordinates` on the array itself (a memmap is not copied).

    Pixel (i, j) of a `size` = (H, W) image is at centre + (i - (H-1)/2) px u + (j - (W-1)/2) px v: rows run along `u`, columns
    along `v`, both unit vectors (z, y, x). Positions are in whatever unit `to_index` takes, which maps an array of points
    (..., 3) to `vol`'s index space: mm with `p / spacing` for views of a scan-grid volume; scan voxels with `lambda p: p`. Orders 0 (labels) and 1 (HU); outside `vol`: `cval`.
    """
    pts = fr.plane_points(centre_zyx, u, v, px, size)
    return ndi.map_coordinates(vol, np.moveaxis(to_index(pts), -1, 0), order=order, mode='constant', cval=cval)


def frame_cut(vol, frame, axis, index, order=1, cval=0):
    """One plane of frame `frame`'s grid, sampled straight from the scan-grid volume `vol` (Z,Y,X).

    axis 0 = slice `index` (rows x columns), axis 1 = row `index` (slices x columns), axis 2 = column `index`
    (slices x rows). order 0 for labels, 1 for HU. The pixels are the frame's voxels.
    """
    pts = fr.slice_points(frame, axis, index)
    return ndi.map_coordinates(vol, np.moveaxis(pts, -1, 0), order=order, mode='constant', cval=cval)


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n else v


class View:
    """A pinhole camera on a rendered image (a 3D pane of `quad_view`). `camera` holds position, focal_point and view_up as
    zyx voxel indices (`camera_zyx`) and view_angle, the vertical field of view in degrees. Maths is done in mm, in xyz order
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


def camera_zyx(cam, spacing):
    """Camera vectors from mesh coordinates (mm, x,y,z) to scan voxel indices z,y,x. view_up is a direction, so it is
    scaled the same way (`View` rescales it by the spacing again)."""
    sp = np.array(spacing)
    return {k: (np.array(v)[::-1] / sp).tolist() if k != 'view_angle' else v for k, v in cam.items()}


MESH_TARGET = 200  # voxels along the longest axis of a surface's grid: a 3D pane has 800 px, and 2M triangles take 5 s to draw
MIN_VOXELS = 50  # smaller pieces are not drawn in 3D


class Meshes:
    """Display surfaces in mm (x, y, z), cut from an array downsampled by a step and cached as .vtp files in `cache_dir`.

    A cache file is named by a hash of the array's path and mtime, the step and what was cut, and written to a temporary name
    and renamed, so a reader never sees half a file. The downsampled array is read once per Meshes, however many labels
    are cut from it."""

    def __init__(self, cache_dir):
        self.dir = Path(cache_dir)
        self._small = {}

    def step_for(self, vol, step=None):
        return step or max(1, round(max(vol.shape) / MESH_TARGET))

    def small(self, path, vol, step):
        if (str(path), step) not in self._small:
            self._small[str(path), step] = np.asarray(vol[::step, ::step, ::step])
        return self._small[str(path), step]

    def label_ids(self, path, vol, step=None):
        return [int(v) for v in np.unique(self.small(path, vol, self.step_for(vol, step))) if v]

    def cached(self, key, build):
        import pyvista as pv
        f = self.dir / (hashlib.sha1(json.dumps(key, default=str).encode()).hexdigest()[:20] + '.vtp')
        if f.exists():
            return pv.read(f)
        mesh = build()
        if mesh.n_points:
            mesh = mesh.compute_normals(split_vertices=False)  # drawing computes them otherwise, on every call
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f'{f.stem}.{os.getpid()}.tmp.vtp')
        mesh.save(tmp)
        os.replace(tmp, f)
        return mesh

    def surface(self, path, vol, select, kind, spacing, to_scan=lambda p: p, step=None, grid_id=None):
        """Surface of `select(volume at step)` for the array at `path`; `to_scan` maps its voxel indices to scan voxel indices."""
        step = self.step_for(vol, step)
        key = (str(path), Path(path).stat().st_mtime_ns, step, kind, grid_id, list(spacing))

        def build():
            import pyvista as pv
            from skimage.measure import marching_cubes
            small = select(self.small(path, vol, step))
            if small.sum() < MIN_VOXELS:
                return pv.PolyData()
            v, f, _, _ = marching_cubes(np.pad(small, 1).astype(np.float32), 0.5)
            mm = to_scan((v - 1) * step) * np.asarray(spacing)
            faces = np.hstack([np.full((len(f), 1), 3), f]).astype(np.int64).ravel()
            return pv.PolyData(mm[:, ::-1].copy(), faces).smooth(n_iter=20)
        return self.cached(key, build)
