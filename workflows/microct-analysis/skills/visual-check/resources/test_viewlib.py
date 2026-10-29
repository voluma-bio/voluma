"""sample_plane is the one place a plane's axes and units are decided: an axis-aligned cut must be the numpy slice and an
oblique one must land on the voxel the geometry says, or every view built on it is silently wrong."""

import numpy as np
import pytest
import viewlib as vl


def asymmetric_volume():
    rng = np.random.default_rng(0)
    return rng.random((20, 30, 40)).astype(np.float32)  # no two voxels equal, no symmetry


@pytest.mark.parametrize('axis,index', [(0, 7), (1, 11), (2, 25)])
def test_axis_aligned_plane_equals_the_numpy_slice(axis, index):
    vol = asymmetric_volume()
    a, b = (i for i in range(3) if i != axis)
    unit = np.eye(3)
    centre = np.zeros(3)
    centre[axis], centre[a], centre[b] = index, (vol.shape[a] - 1) / 2, (vol.shape[b] - 1) / 2
    got = vl.sample_plane(vol, lambda p: p, centre, unit[a], unit[b], 1.0, (vol.shape[a], vol.shape[b]))
    np.testing.assert_allclose(got, np.take(vol, index, axis=axis), atol=1e-6)


def test_oblique_plane_lands_on_the_expected_voxel():
    vol = asymmetric_volume()
    # rows run along (0, 1, 1)/sqrt2 and columns along (0, 1, -1)/sqrt2, steps of sqrt2: pixel (i, j) is voxel
    # (z0, y0 + (i - 4) + (j - 3), x0 + (i - 4) - (j - 3)), a whole voxel for every pixel
    u = np.array([0, 1, 1]) / np.sqrt(2)
    v = np.array([0, 1, -1]) / np.sqrt(2)
    centre = np.array([10.0, 12.0, 20.0])
    got = vl.sample_plane(vol, lambda p: p, centre, u, v, np.sqrt(2), (9, 7), order=1)
    for i, j in [(4, 3), (0, 0), (8, 6), (2, 5), (7, 1)]:
        assert got[i, j] == pytest.approx(vol[10, 12 + (i - 4) + (j - 3), 20 + (i - 4) - (j - 3)], abs=1e-5)


def test_frame_cut_is_the_frames_own_slice():
    import frame as fr

    vol = asymmetric_volume()
    R = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]], float)  # slice axis 0 is scan x; rows run along z, columns along y
    f = fr.make('scan', [1, 1, 1], parent_affine_xyz=np.eye(4), R_zyx=R, origin_zyx=[0, 0, 0], shape=[40, 20, 30])
    np.testing.assert_allclose(vl.frame_cut(vol, f, 0, 13), vol[:, :, 13], atol=1e-6)
