"""The joint-end cap check that tells a femur from a tibia across the knee.

segmentation-check's label_stats.py runs it at intake to catch swapped labels, and mouse-oa's tibia_frame.py runs it
before building the tibia's grid.

A bone's cap is its voxels within CAP_MM of the end facing the other bone, in scan-z slices, projected along z; its
solidity is area over convex-hull area. The femur's cap holds the intercondylar notch, open toward the joint, so its
footprint is U-shaped; the tibial plateau's is a solid blob. On ten lab scans the femur's cap gave 0.51 to 0.80 and the
tibia's 0.83 to 0.95, the smallest gap 0.12. A bent knee narrows the gap: taking the cap along each bone's own axis
instead gave the same verdicts on the staging scans but a smaller margin on OA6-1RK.
"""

import numpy as np
from scipy import ndimage as ndi

CAP_MM = 0.63  # how far from its joint end a bone's cap reaches
CAP_GAP = 0.05  # cap solidities closer than this cannot tell the two bones apart


def largest_piece(m):
    """The largest 6-connected piece of mask `m`: a fragment or stray voxel under the same label does not move the bone's ends."""
    zs, ys, xs = (np.flatnonzero(m.any(axis=ax)) for ax in ((1, 2), (0, 2), (0, 1)))
    box = np.s_[zs[0] : zs[-1] + 1, ys[0] : ys[-1] + 1, xs[0] : xs[-1] + 1]
    pieces, n = ndi.label(m[box])
    out = np.zeros_like(m)
    if n:
        out[box] = pieces == 1 + int(np.argmax(np.bincount(pieces.ravel())[1:]))
    return out


def cap_solidity(m, low_end, cap_vox):
    """Area over convex-hull area of the cap of mask `m` within `cap_vox` slices of its low or high end, projected along z."""
    from skimage.morphology import convex_hull_image

    zs = np.flatnonzero(m.any(axis=(1, 2)))
    z0, z1 = zs[0], zs[-1]
    lo, hi = (z0, z0 + cap_vox) if low_end else (max(z1 - cap_vox + 1, z0), z1 + 1)
    foot = m[lo:hi].any(axis=0)
    return float(foot.sum() / max(convex_hull_image(foot).sum(), 1))


def caps(a, b, vox):
    """Cap solidities of bones `a` and `b` (each a single piece, e.g. from largest_piece), each at its end facing the
    other, and whether `a`'s joint end is its low end in scan z. `vox` is the slice spacing in mm."""
    za, zb = (float(np.flatnonzero(m.any(axis=(1, 2))).mean()) for m in (a, b))
    a_low = zb < za
    cap = round(CAP_MM / vox)
    return cap_solidity(a, a_low, cap), cap_solidity(b, not a_low, cap), a_low
