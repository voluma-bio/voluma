"""The frame: a rigid, resampled copy of the scan grid with its own `grid_id`. Every oriented stack, aligned bone grid and
(later) view plane is one, so there is one schema and one mapping between a frame and the scan.

`frame.json` (written by `orient_joint.py` and `tibia_frame.py`; fits may add keys of their own, nothing here reads them):
  parent_grid_id   the scan grid the frame was cut from
  grid_id          hash of the parent id, `R_zyx`, `origin_zyx` and `shape` (numbers only)
  R_zyx            3x3, orthonormal; row i is frame axis i as a unit vector in scan (z, y, x) voxel indices
  origin_zyx       scan voxel index of frame index (0, 0, 0)
  shape            frame array shape (its axis 0, 1, 2)
  spacing_zyx_mm   voxel size of the scan, which the frame shares (frames need isotropic voxels, so lengths agree)
A frame index p and a scan voxel index x are related by  x = p @ R_zyx + origin_zyx  and  p = (x - origin_zyx) @ R_zyx.T,
both fractional. Voxel centres are at integer indices.

  import frame as fr
  f = fr.make(parent_grid_id, spacing, R_zyx=R, origin_zyx=o, shape=shape, **extra)   # a new frame; fr.save / fr.load
  fr.resample(scan_vol, f, order=1, cval=0)       # the scan cut onto the frame (order 0 for labels)
  fr.to_scan(stack, f, scan_shape)                 # nearest-neighbour map of a frame-grid stack back onto the scan
  fr.from_scan_points(zyx, f), fr.to_scan_points(p, f)   # points, either way, shape (..., 3)
  fr.plane_points(centre, u, v, px, size)         # the points a plane of pixels samples (viewlib.sample_plane uses this)
"""
import json
from pathlib import Path

import numpy as np
import sidecar
from scipy import ndimage as ndi

KEYS = ('parent_grid_id', 'grid_id', 'R_zyx', 'origin_zyx', 'shape', 'spacing_zyx_mm')


def make(parent_grid_id, spacing_zyx_mm, *, R_zyx, origin_zyx, shape, **extra):
    """A frame dict. `grid_id` is derived from the numbers, so rewording an `extra` key never changes it."""
    core = {'R_zyx': np.asarray(R_zyx, float).tolist(), 'origin_zyx': np.asarray(origin_zyx, float).tolist(),
            'shape': [int(n) for n in shape]}
    return {'parent_grid_id': parent_grid_id, 'grid_id': sidecar.derived_grid_id(parent_grid_id, core), **core,
            'spacing_zyx_mm': [float(s) for s in spacing_zyx_mm], **extra}


def save(frame, path):
    Path(path).write_text(json.dumps(frame, indent=1, default=float) + '\n')


def load(path):
    f = json.loads(Path(path).read_text())
    missing = [k for k in KEYS if k not in f]
    if missing:
        sidecar.fail(f'{path} is not a frame.json (missing {", ".join(missing)}): make it again with orient_joint.py or tibia_frame.py')
    return f


def from_scan_points(points_zyx, frame):
    """Frame indices of scan voxel indices (z, y, x); fractional, shape (..., 3)."""
    return (np.asarray(points_zyx, float) - np.array(frame['origin_zyx'])) @ np.array(frame['R_zyx']).T


def to_scan_points(points, frame):
    """Scan voxel indices (z, y, x) of frame indices; the inverse of `from_scan_points`."""
    return np.asarray(points, float) @ np.array(frame['R_zyx']) + np.array(frame['origin_zyx'])


def plane_points(centre, u, v, px, size):
    """(H, W, 3) positions of the pixels of a plane: pixel (i, j) is at centre + (i - (H-1)/2) px u + (j - (W-1)/2) px v.
    `centre`, `u`, `v` and `px` share one unit (u and v are unit vectors); positions come out in that unit."""
    h, w = size
    i = (np.arange(h) - (h - 1) / 2) * px
    j = (np.arange(w) - (w - 1) / 2) * px
    return (np.asarray(centre, float) + i[:, None, None] * np.asarray(u, float)
            + j[None, :, None] * np.asarray(v, float))


def resample(vol, frame, order=1, cval=0, dtype=np.float32):
    """The scan-grid volume `vol` (Z, Y, X; a memmap is fine) cut onto the frame, one slice at a time. Outside the scan: `cval`."""
    S, H, W = frame['shape']
    R = np.array(frame['R_zyx'])
    out = np.empty((S, H, W), dtype)
    for s in range(S):
        centre = to_scan_points([s, (H - 1) / 2, (W - 1) / 2], frame)
        pts = np.moveaxis(plane_points(centre, R[1], R[2], 1.0, (H, W)), -1, 0)
        ndi.map_coordinates(vol, pts, output=out[s], order=order, mode='constant', cval=cval)
    return out


def to_scan(stack, frame, scan_shape):
    """Nearest-neighbour map of a frame-grid stack (S, H, W) back onto the scan grid (Z, Y, X); voxels outside it are 0."""
    R = np.array(frame['R_zyx'])
    o = np.array(frame['origin_zyx'])
    S, H, W = stack.shape
    out = np.zeros(scan_shape, stack.dtype)
    yy, xx = np.mgrid[0:scan_shape[1], 0:scan_shape[2]].astype(np.float64)
    for z in range(scan_shape[0]):
        d = np.stack([np.full_like(yy, z), yy, xx]) - o[:, None, None]
        idx = [np.rint(np.tensordot(R[i], d, 1)).astype(np.int64) for i in range(3)]
        ok = (idx[0] >= 0) & (idx[0] < S) & (idx[1] >= 0) & (idx[1] < H) & (idx[2] >= 0) & (idx[2] < W)
        out[z][ok] = stack[idx[0][ok], idx[1][ok], idx[2][ok]]
    return out
