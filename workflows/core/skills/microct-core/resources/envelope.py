"""Filled outline of a bone section, the same whether or not the label already contains the marrow.

A bone-only label has a cortex ring that can have pinhole gaps; filling holes alone leaves such a slice
unfilled. Closing first seals the gaps, so a bone-only label and one that was filled upstream give the same envelope.
"""

from scipy import ndimage as ndi

CLOSE_MM = 0.084  # the widest cortex gap seen in a real SAM tibia label (a mouse tibia at 10.5 um voxels) needed 84 um


def close_and_fill(plane, voxel_mm, close_mm=CLOSE_MM):
    """2D boolean section -> the section with gaps up to `close_mm` in its outline closed and the enclosed marrow filled."""
    return ndi.binary_fill_holes(ndi.binary_closing(plane, iterations=round(close_mm / voxel_mm)) | plane)
