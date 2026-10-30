"""Filled outline of a bone section, the same whether or not the label already contains the marrow.

A bone-only label has a cortex ring that can have pinhole gaps; filling holes alone leaves such a slice
unfilled. Closing first seals the gaps, so a bone-only label and one that was filled upstream give the same envelope.
"""

import numpy as np
from scipy import ndimage as ndi
from sidecar import fail

CLOSE_MM = 0.084  # the widest cortex gap seen in a real SAM tibia label (a mouse tibia at 10.5 um voxels) needed 84 um


def close_and_fill(plane, voxel_mm, close_mm=CLOSE_MM):
    """2D boolean section -> the section with gaps up to `close_mm` in its outline closed and the enclosed marrow filled."""
    iterations = round(close_mm / voxel_mm)
    if iterations < 1:
        fail(f'a voxel of {voxel_mm} mm is too coarse to close gaps of close_mm={close_mm} mm (it rounds to 0 voxels): '
             'give a larger close_mm, or a scan with finer voxels')
    return ndi.binary_fill_holes(ndi.binary_closing(plane, iterations=iterations) | plane)


def footprint(bone_zyx):
    """The filled (V,U) footprint of a bone mask on the aligned grid: where a height along W can lie on the bone."""
    return ndi.binary_fill_holes(np.asarray(bone_zyx, bool).any(axis=0))
