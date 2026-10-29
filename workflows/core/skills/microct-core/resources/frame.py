"""The frame: a rigid, resampled copy of the scan grid with its own `grid_id`. Every oriented stack, aligned bone grid and
(later) view plane is one, so there is one schema and one mapping between a frame and the scan.

`frame.json` (written by `orient_joint.py` and `tibia_frame.py`; fits may add keys of their own, nothing here reads them):
  parent_grid_id   the scan grid the frame was cut from
  grid_id          hash of the parent id, `R_zyx`, `origin_zyx` and `shape` (numbers only)
  R_zyx            3x3, orthonormal; row i is frame axis i as a unit vector in scan (z, y, x) voxel indices
  origin_zyx       scan voxel index of frame index (0, 0, 0)
  shape            frame array shape (its axis 0, 1, 2)
  spacing_zyx_mm   voxel size of the scan, which the frame shares (frames need isotropic voxels, so lengths agree)
  affine_xyz_to_world_mm   the frame's own placement in world mm, same convention as `hu.json` and the review contract's
                   `Volume.affine`: 4x4 row-major, bottom row [0, 0, 0, 1], consumes voxel-centre indices (x, y, z) = (array axis 2,
                   1, 0), a rotation times the voxel size. Composed from the parent's affine by `make`, nowhere else.
A frame index p and a scan voxel index x are related by  x = p @ R_zyx + origin_zyx  and  p = (x - origin_zyx) @ R_zyx.T,
both fractional. Voxel centres are at integer indices.

  import frame as fr
  f = fr.make(parent_grid_id, spacing, parent_affine_xyz=hu['affine_xyz_to_world_mm'], R_zyx=R, origin_zyx=o, shape=shape, **extra)   # a new frame; fr.save / fr.load
  fr.resample(scan_vol, f, order=1, cval=0)       # the scan cut onto the frame (order 0 for labels)
  fr.to_scan(stack, f, scan_shape)                 # nearest-neighbour map of a frame-grid stack back onto the scan
  fr.from_scan_points(zyx, f), fr.to_scan_points(p, f)   # points, either way, shape (..., 3)
  fr.slice_points(f, axis, index)                 # (A, B, 3) scan indices of the voxels of one frame slice (axis 0: slice `index`)
  fr.plane_points(centre, u, v, px, size)         # the points a plane of pixels samples (viewlib.sample_plane uses this)
"""
import json
from pathlib import Path

import numpy as np
import sidecar
from scipy import ndimage as ndi

KEYS = ('parent_grid_id', 'grid_id', 'R_zyx', 'origin_zyx', 'shape', 'spacing_zyx_mm', 'affine_xyz_to_world_mm')


def world_affine(parent_affine_xyz, R_zyx, origin_zyx, spacing_zyx_mm):
    """The frame's `affine_xyz_to_world_mm`: the parent's affine after the frame-to-parent map. With P reversing (z, y, x) to
    (x, y, z), a frame index q = (x, y, z) is parent (z, y, x) index  R.T @ P q + o,  so the map in (x, y, z) is  P R.T P q + P o."""
    P = np.eye(3)[::-1]
    to_parent = np.eye(4)
    to_parent[:3, :3] = P @ np.asarray(R_zyx, float).T @ P
    to_parent[:3, 3] = P @ np.asarray(origin_zyx, float)
    affine = np.asarray(parent_affine_xyz, float) @ to_parent
    cols = affine[:3, :3]
    lengths = np.linalg.norm(cols, axis=0)
    unit = cols / lengths
    if not np.allclose(unit.T @ unit, np.eye(3), atol=1e-4) or not np.allclose(lengths, spacing_zyx_mm[::-1], rtol=1e-3):
        sidecar.fail(f'the parent affine and the frame do not give a rotation times the voxel size (column lengths {lengths.tolist()} '
                     f'mm against spacing {list(spacing_zyx_mm[::-1])} mm, or the columns are not orthogonal): the frame has shear or '
                     'the wrong spacing, so it cannot be placed in world space; check the affine in hu.json and the frame fit')
    affine[3] = [0, 0, 0, 1]
    return affine.tolist()


def make(parent_grid_id, spacing_zyx_mm, *, parent_affine_xyz, R_zyx, origin_zyx, shape, **extra):
    """A frame dict. `grid_id` is derived from the numbers, so rewording an `extra` key never changes it."""
    core = {'R_zyx': np.asarray(R_zyx, float).tolist(), 'origin_zyx': np.asarray(origin_zyx, float).tolist(),
            'shape': [int(n) for n in shape]}
    spacing = [float(s) for s in spacing_zyx_mm]
    return {'parent_grid_id': parent_grid_id, 'grid_id': sidecar.derived_grid_id(parent_grid_id, core), **core,
            'spacing_zyx_mm': spacing, 'affine_xyz_to_world_mm': world_affine(parent_affine_xyz, R_zyx, origin_zyx, spacing), **extra}


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


def slice_points(frame, axis, index):
    """(A, B, 3) scan voxel indices of the voxels of one slice of the frame: axis 0 = slice `index` (rows x columns), axis 1 = row
    `index` (slices x columns), axis 2 = column `index` (slices x rows). The one place a frame slice is centred and its axes ordered."""
    a, b = (i for i in range(3) if i != axis)
    n = frame['shape']
    c = np.zeros(3)
    c[axis], c[a], c[b] = index, (n[a] - 1) / 2, (n[b] - 1) / 2
    R = np.array(frame['R_zyx'])
    return plane_points(to_scan_points(c, frame), R[a], R[b], 1.0, (n[a], n[b]))


def resample(vol, frame, order=1, cval=0, dtype=np.float32):
    """The scan-grid volume `vol` (Z, Y, X; a memmap is fine) cut onto the frame, one slice at a time. Outside the scan: `cval`."""
    out = np.empty(frame['shape'], dtype)
    for s in range(len(out)):
        ndi.map_coordinates(vol, np.moveaxis(slice_points(frame, 0, s), -1, 0), output=out[s], order=order, mode='constant', cval=cval)
    return out


def to_scan(stack, frame, scan_shape):
    """Nearest-neighbour map of a frame-grid stack (S, H, W) back onto the scan grid (Z, Y, X); voxels outside it are 0.

    Only the box of the scan that the frame's corners map to (plus one voxel) is visited, so a small frame costs in proportion to its size."""
    R = np.array(frame['R_zyx'])
    o = np.array(frame['origin_zyx'])
    S, H, W = stack.shape
    out = np.zeros(scan_shape, stack.dtype)
    corners = np.array([[i, j, k] for i in (-0.5, S - 0.5) for j in (-0.5, H - 0.5) for k in (-0.5, W - 0.5)])
    sc = to_scan_points(corners, frame)
    lo = np.maximum(np.floor(sc.min(0)).astype(int) - 1, 0)
    hi = np.minimum(np.ceil(sc.max(0)).astype(int) + 2, scan_shape)
    if (hi <= lo).any():
        return out
    yy, xx = np.mgrid[lo[1]:hi[1], lo[2]:hi[2]].astype(np.float64)
    for z in range(lo[0], hi[0]):
        d = np.stack([np.full_like(yy, z), yy, xx]) - o[:, None, None]
        idx = [np.rint(np.tensordot(R[i], d, 1)).astype(np.int64) for i in range(3)]
        ok = (idx[0] >= 0) & (idx[0] < S) & (idx[1] >= 0) & (idx[1] < H) & (idx[2] >= 0) & (idx[2] < W)
        out[z, lo[1]:hi[1], lo[2]:hi[2]][ok] = stack[idx[0][ok], idx[1][ok], idx[2][ok]]
    return out
