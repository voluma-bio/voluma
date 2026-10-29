"""`pick.py` turns a pixel of a quad view into a voxel with the pane's origin and steps from `view.json`. If that map and the
pixels `quad_view` draws disagree by even half a pixel, every pick lands off the structure and nothing fails. So this renders a
small anisotropic scan with one bright blob off the crosshair, finds the blob in the JPEG inside each pane's rectangle, maps
it back through `view.json`, and compares it with where the blob was put: on an axis pane and on an oblique one."""

import json
import types

import numpy as np
import pytest
import quad_view as qv
from PIL import Image

SP = np.array([0.02, 0.01, 0.01])
SHAPE = (31, 41, 51)
BLOB_HU = 100.0


def build_view(tmp_path, offsets):
    """State of a scan with a bone block and a blob, and the zyx voxel the blob is at. `offsets` = (pane, row px, col px): the
    blob is that many pixels from the crosshair in that pane's plane. Pane 1 is oblique, 0 and 2 are scan axes."""
    scene = types.SimpleNamespace(sp=SP, shape=list(SHAPE))
    hu = tmp_path / 'hu.npy'
    (tmp_path / 'hu.json').write_text(json.dumps({'grid_id': 'g', 'spacing_zyx_mm': SP.tolist(), 'shape': list(SHAPE)}))
    np.save(hu, np.zeros(SHAPE, np.float32))
    s = qv.new_state(types.SimpleNamespace(hu=str(hu)))
    s.update(pane_px=200, window=[0, BLOB_HU], bone_hu=20.0)
    s['panes'][1] = qv.make_pane([1, 1, 0], [0, 0, 1])
    pane, row, col = offsets
    g = qv.pane_geometry(s, scene, pane)
    mid = (s['pane_px'] - 1) / 2
    blob = np.array(g['origin_zyx']) + (mid + row) * np.array(g['d_row_zyx']) + (mid + col) * np.array(g['d_col_zyx'])
    zz, yy, xx = np.meshgrid(*[np.arange(n) for n in SHAPE], indexing='ij')
    vol = BLOB_HU * np.exp(-((zz - blob[0]) ** 2 + (yy - blob[1]) ** 2 + (xx - blob[2]) ** 2) / (2 * 1.5**2))
    vol[2:8, 2:8, 2:8] = 30  # enough bone for a 3D surface
    np.save(hu, vol.astype(np.float32))
    return s, blob


@pytest.mark.parametrize('offsets', [(0, 12, -20), (1, -10, 25)])
def test_blob_in_the_jpeg_is_where_view_json_says(tmp_path, offsets):
    s, blob = build_view(tmp_path, offsets)
    view = qv.render(s, tmp_path / 'v.jpg')
    rgb = np.asarray(Image.open(tmp_path / 'v.jpg').convert('RGB'), float)
    pane = view['panes'][offsets[0]]
    x0, y0, x1, y1 = pane['rect']
    crop = rgb[y0:y1, x0:x1]
    ys, xs = np.nonzero(crop.min(axis=2) > 140)  # the blob is white; the crosshair lines and outlines are coloured
    assert len(ys) > 10
    row, col = ys.mean(), xs.mean()
    zyx = np.array(pane['origin_zyx']) + row * np.array(pane['d_row_zyx']) + col * np.array(pane['d_col_zyx'])
    assert np.abs(zyx - blob).max() < 0.5
