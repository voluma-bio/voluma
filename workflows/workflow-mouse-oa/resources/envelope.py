"""Filled outline of a bone section, the same whether or not the label already contains the marrow.

A bone-only label has a cortex ring that can have pinhole gaps; filling holes alone leaves such a slice
unfilled. Closing first seals the gaps, so `iioc.py`, `metaphysis_roi.py` and `tibia_frame.py` all
see the same envelope from a bone-only label and from one that was filled upstream.
"""

from scipy import ndimage as ndi

CLOSE_ITERATIONS = 8  # 84 um at 10.5 um voxels: the widest cortex gap seen in a real SAM tibia label needed 8


def close_and_fill(plane, iterations=CLOSE_ITERATIONS):
    """2D boolean section -> the section with gaps in its outline closed and the enclosed marrow filled."""
    return ndi.binary_fill_holes(ndi.binary_closing(plane, iterations=iterations) | plane)
