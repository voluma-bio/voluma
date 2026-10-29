"""Label levels take the mode: a mean would invent label values that are in no voxel, silently, in the review's 3-D view."""

import numpy as np
import pytest

pytest.importorskip("zarr")
import review_assets as ra


def test_mode_keeps_only_present_labels():
    block = np.array([[[2, 2], [2, 2]], [[2, 2], [9, 9]]], np.uint8)  # mean would be 4
    assert ra.down_mode(block).item() == 2
    assert ra.down_mean(block).item() != 2


def test_mode_tie_goes_to_foreground():
    block = np.zeros((2, 2, 2), np.uint8)
    block[0] = 7
    assert ra.down_mode(block).item() == 7


def test_odd_axis_repeats_last_plane():
    assert ra.down_mode(np.full((3, 1, 1), 5, np.uint8)).shape == (2, 1, 1)
    assert ra.level_shapes([877, 520, 517])[-1] == [110, 65, 65]
