"""`pick.py` turns a pixel of a quad view into a voxel with the pane's origin and steps from `view.json`. If that map and the
pixels `quad_view` draws (sampled by `sample_plane`) disagree by even half a pixel, every pick lands off the structure and
nothing fails, so the map is checked against the sampled plane, on an oblique pane of an anisotropic scan."""

import numpy as np
import pytest
import quad_view as qv
import viewlib as vl
from scipy import ndimage as ndi


@pytest.mark.parametrize('zoom', [1.0, 3.0])
def test_pane_map_matches_the_sampled_pixels(zoom):
    rng = np.random.default_rng(1)
    vol = rng.random((24, 30, 36)).astype(np.float32)
    sp = np.array([0.03, 0.02, 0.01])
    scene = type('Scene', (), {'sp': sp, 'shape': list(vol.shape)})
    P = 21
    state = {'pane_px': P, 'zoom': zoom, 'center_zyx': [11.3, 14.2, 17.6],
             'panes': [qv.make_pane([1, 2, 1], [0, 1, 0]), qv.make_pane([1, 0, 0], axis=0)]}
    for k in range(2):
        g = qv.pane_geometry(state, scene, k)
        plane = vl.sample_plane(vol, lambda p: p / sp, g['centre_mm'], g['u'], g['v'], g['px'], (P, P), order=1)
        for row, col in [(0, 0), (10, 10), (20, 3), (7, 19)]:
            zyx = np.array(g['origin_zyx']) + row * np.array(g['d_row_zyx']) + col * np.array(g['d_col_zyx'])
            expect = ndi.map_coordinates(vol, zyx[:, None], order=1, mode='constant')[0]
            assert plane[row, col] == pytest.approx(expect, abs=1e-5)
        mid = np.array(g['origin_zyx']) + 10 * (np.array(g['d_row_zyx']) + np.array(g['d_col_zyx']))
        np.testing.assert_allclose(mid, state['center_zyx'], atol=1e-9)  # the crosshair is the centre pixel of every pane
