"""Frame maps: a transposed R or a swapped axis here gives a plausible, misplaced image and no error, so the round trip,
the resample and the map back are pinned."""

import frame as fr
import numpy as np
import pytest

SCAN_AFFINE = np.array([[0, -0.01, 0, 3.0], [0, 0, 0.01, -2.0], [-0.01, 0, 0, 7.5], [0, 0, 0, 1]])  # oblique scan: axes permuted, flipped, offset


def rotated_frame():
    th = np.radians(25)
    c, s = np.cos(th), np.sin(th)
    R = np.array([[1, 0, 0], [0, c, s], [0, -s, c]])[[2, 0, 1]]  # turned 25 degrees, axes permuted: no two axes agree
    return fr.make('scan', [0.01] * 3, parent_affine_xyz=SCAN_AFFINE, R_zyx=R, origin_zyx=[12.0, 15.5, 25.0], shape=[6, 9, 11])


def test_points_round_trip_scan_frame_scan():
    f = rotated_frame()
    pts = np.array([[4.0, 20.5, 7.25], [0, 0, 0], [10, 30, 40]])
    np.testing.assert_allclose(fr.to_scan_points(fr.from_scan_points(pts, f), f), pts, atol=1e-9)
    np.testing.assert_allclose(fr.from_scan_points(fr.to_scan_points(pts, f), f), pts, atol=1e-9)


def test_resample_reads_the_scan_at_the_frame_index_to_scan_points_names():
    f = rotated_frame()
    z, y, x = np.meshgrid(*(np.arange(n, dtype=np.float64) for n in (40, 50, 60)), indexing='ij')
    vol = (1.0 * z + 10.0 * y + 100.0 * x).astype(np.float32)  # linear, so order-1 interpolation is exact
    out = fr.resample(vol, f, order=1, cval=-1e6, dtype=np.float64)
    s, r, c = np.meshgrid(*(np.arange(n) for n in f['shape']), indexing='ij')
    zyx = fr.to_scan_points(np.stack([s, r, c], -1), f)
    np.testing.assert_allclose(out, zyx @ [1.0, 10.0, 100.0], rtol=1e-6)


def test_to_scan_inverts_resample_for_labels():
    R = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]], float)  # frame voxels are scan voxels, so the round trip is exact
    f = fr.make('scan', [1, 1, 1], parent_affine_xyz=np.eye(4), R_zyx=R, origin_zyx=[0, 0, 0], shape=[5, 6, 7])
    lab = np.zeros((7, 5, 6), np.uint8)
    lab[2:5, 1:4, 0:3] = 3
    stack = fr.resample(lab, f, order=0, dtype=np.uint8)
    np.testing.assert_array_equal(fr.to_scan(stack, f, lab.shape), lab)


def test_grid_id_comes_from_the_numbers_only():
    f = rotated_frame()
    kw = {'R_zyx': f['R_zyx'], 'origin_zyx': f['origin_zyx'], 'shape': f['shape']}
    assert fr.make('scan', [0.01] * 3, parent_affine_xyz=SCAN_AFFINE, axes='reworded', **kw)['grid_id'] == f['grid_id']
    assert fr.make('scan', [0.01] * 3, parent_affine_xyz=SCAN_AFFINE, **{**kw, 'origin_zyx': [12.0, 15.5, 26.0]})['grid_id'] != f['grid_id']


def test_load_refuses_a_file_without_the_schema(tmp_path):
    (tmp_path / 'frame.json').write_text('{"R": [[1, 0, 0]]}')
    with pytest.raises(SystemExit):
        fr.load(tmp_path / 'frame.json')


def test_frame_affine_places_a_voxel_where_the_scan_affine_does():
    f = rotated_frame()
    q_xyz = np.array([[0, 0, 0], [3, 7, 2], [10, 8, 5]], float)  # frame (x, y, z) indices
    world = np.c_[q_xyz, np.ones(3)] @ np.array(f['affine_xyz_to_world_mm']).T
    scan_zyx = fr.to_scan_points(q_xyz[:, ::-1], f)
    expected = np.c_[scan_zyx[:, ::-1], np.ones(3)] @ SCAN_AFFINE.T
    np.testing.assert_allclose(world[:, :3], expected[:, :3], atol=1e-9)
    A = np.array(f['affine_xyz_to_world_mm'])
    np.testing.assert_allclose(A[3], [0, 0, 0, 1])
    np.testing.assert_allclose(A[:3, :3].T @ A[:3, :3], np.eye(3) * 0.01**2, atol=1e-12)


def test_a_sheared_parent_affine_is_refused():
    shear = SCAN_AFFINE.copy()
    shear[0, 2] = 0.005
    with pytest.raises(SystemExit):
        fr.make('scan', [0.01] * 3, parent_affine_xyz=shear, R_zyx=np.eye(3), origin_zyx=[0, 0, 0], shape=[2, 2, 2])
