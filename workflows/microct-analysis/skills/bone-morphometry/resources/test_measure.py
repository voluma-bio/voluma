"""Unit conversions in measure.py: a wrong mm or mm^3 here is silent, so these are pinned."""

import numpy as np
import pytest
from measure import distance_mm, ratio, volume_mm3

SP = [0.04, 0.02, 0.01]  # z, y, x in mm, anisotropic


def test_distance_uses_each_axis_spacing():
    assert distance_mm([[0, 0, 0], [1, 0, 0]], SP) == pytest.approx(0.04)
    assert distance_mm([[0, 0, 0], [0, 1, 0]], SP) == pytest.approx(0.02)
    assert distance_mm([[0, 0, 0], [0, 0, 1]], SP) == pytest.approx(0.01)
    assert distance_mm([[0, 0, 0], [3, 4, 0]], [1, 1, 1]) == pytest.approx(5.0)
    assert distance_mm([[1, 2, 3], [2, 4, 3]], SP) == pytest.approx(np.hypot(0.04, 0.04))


def test_volume_is_voxel_count_times_voxel_volume():
    lab = np.zeros((4, 4, 4), np.int32)
    lab[:2, :2, :2] = 3
    lab[3, 3, 3] = 5
    assert volume_mm3(lab, [3], SP) == pytest.approx(8 * 0.04 * 0.02 * 0.01)
    assert volume_mm3(lab, [3, 5], SP) == pytest.approx(9 * 0.04 * 0.02 * 0.01)


def test_ratio_units():
    a, b = {'value': 6.0, 'unit': 'mm'}, {'value': 3.0, 'unit': 'mm'}
    assert ratio(a, b) == (2.0, '1')
    assert ratio({'value': 1.0, 'unit': 'mm^3'}, b) == (1 / 3, 'mm^3/mm')
    with pytest.raises(ValueError):
        ratio(a, {'value': 0.0, 'unit': 'mm'})
