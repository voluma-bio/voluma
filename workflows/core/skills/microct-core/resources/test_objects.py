"""A cropped mask that loads one voxel off would still draw plausibly, so check the crop's offset round trip."""
import json

import numpy as np
import objects


def test_cropped_mask_round_trips_to_its_place(tmp_path):
    (tmp_path / 'hu.json').write_text(json.dumps({'grid_id': 'g', 'spacing_zyx_mm': [1, 1, 1], 'shape': [20, 30, 40]}))
    m = np.zeros((20, 30, 40), bool)
    m[3:7, 11:19, 25] = True
    m[5, 12, 30] = True
    entry = objects.mask(tmp_path / 'm.npy', m, like=tmp_path / 'hu.json')['structure']
    assert entry['offsetZyx'] == [3, 11, 25] and entry['shapeZyx'] == [4, 8, 6] and entry['gridId'] == 'g'
    assert np.array_equal(objects.dense(objects.load({'kind': 'structure', 'structure': entry}), m.shape), m)
