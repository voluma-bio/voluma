"""The label of one section: which cut line it uses, and the IIOC region and ignore voxels that line gives.

Cut line (label_sections): a reviewer's fixed cut, else the line derived from the agent's traced faces (cutline.derive with the
scan's ends.json entry); sections a reviewer marked bad are left out, unreviewed ones are kept.
Region (label_section): cutline.region_of on the tibia part of the mask. The tibia mask of some scans also holds the fibula, and
region_of works on the mask's envelope, so per section the bone (closed by CLOSE voxels, 8-connected) falls into components;
those reaching into the cut line's U extent (+MARGIN) are tibia, every other one is fibula or loose bone and goes to ignore.
A fibula head fused to the tibia part (beyond_line) and the reviewed plateau pieces (ossicles, fragments) go to ignore too.
"""
from types import SimpleNamespace

import numpy as np
from scipy import ndimage as ndi
from skimage.morphology import disk

import cutline
import scans

CLOSE, MARGIN = 2, 10
LINE_ON_MASK = 0.3   # a section whose line lies less than this fraction within 4 voxels of the mask is dropped (OA6-12RK's front: the mask misses the bone)
SAT_R, PIECE_MIN = 8, 400


def label_sections(scan):
    """-> ({V: (pts, gaps)}, counts): the cut as cutline.flatten gives it; counts say how many sections each rule kept or dropped."""
    trace = scans.load_curves(scan)
    ends = scans.load_ends(scan)
    reviews = scans.load_reviews(scan)
    n_u = scans.load_tibia_mask(scan).shape[2]
    derive = lambda v: cutline.flatten(cutline.derive(*trace[v], n_u, ends.get(v)))
    out, c = {}, {"traced": len(trace), "fixed": 0, "good": 0, "bad": 0, "unreviewed": 0}
    for v, r in reviews.items():
        if r["verdict"] == "fixed":
            out[v] = (np.array(r["cut"], float), [])
            c["fixed"] += 1
        elif r["verdict"] == "good" and v in trace:
            out[v] = derive(v)
            c["good"] += 1
        elif r["verdict"] == "bad":
            c["bad"] += 1
    for v in trace.keys() - reviews.keys():
        out[v] = derive(v)
        c["unreviewed"] += 1
    return out, c


def not_visible_ranges(scan):
    """{V: [(first_u, last_u), ...]}: the reviewer's not-visible ranges (integer U, inclusive); the region's voxels there are ignore."""
    return {v: [tuple(u) for u in r["not_visible"]] for v, r in scans.load_reviews(scan).items() if r.get("not_visible")}


def tibia_part(bone, pts):
    """bone (W, U) bool, pts the cut line -> the mask's voxels in the components that reach into the line's U extent widened by
    MARGIN: the line crosses the whole tibia, a component wholly outside it is fibula or loose bone."""
    closed = ndi.binary_closing(np.pad(bone, CLOSE), np.ones((2 * CLOSE + 1,) * 2))[CLOSE:-CLOSE, CLOSE:-CLOSE]
    lab, _ = ndi.label(closed | bone, np.ones((3, 3)))
    u0, u1 = int(pts[:, 1].min()) - MARGIN, int(pts[:, 1].max()) + MARGIN
    ids = np.unique(lab[:, max(u0, 0):u1 + 1])
    return bone & np.isin(lab, ids[ids > 0])


def beyond_line(region, pts):
    """Fibula head fused to the tibia part: a piece of the region that opening by SAT_R separates from the body and whose centre column
    lies outside the cut line's U extent. -> bool (W, U), the voxels of such pieces (each region voxel goes with its nearest piece)."""
    core = ndi.binary_opening(region, disk(SAT_R))
    lab, n = ndi.label(core, np.ones((3, 3)))
    if n < 2:
        return np.zeros_like(region)
    u0, u1 = pts[:, 1].min(), pts[:, 1].max()
    idx = ndi.distance_transform_edt(lab == 0, return_distances=False, return_indices=True)
    near = lab[idx[0], idx[1]] * region
    out = np.zeros_like(region)
    for i in range(1, n + 1):
        piece = near == i
        cu = np.flatnonzero(piece.any(0))
        if piece.sum() >= PIECE_MIN and (np.median(cu) < u0 or np.median(cu) > u1):
            out |= piece
    return out


def piece_outline(p, bone, r=6):
    """A plateau piece's outline in one section: its bone closed by r voxels (as cutline.envelope closes the tibia's), holes filled,
    less the other bone, so the marrow pockets inside an ossicle go with it and the tibia's bone beside the seam does not."""
    out = ndi.binary_fill_holes(ndi.binary_closing(np.pad(p, r), disk(r)))[r:-r, r:-r]
    return out & ~(np.asarray(bone, bool) & ~p)


def label_section(v, pts, gaps, nv, tibia, pieces):
    """-> namespace(region, ignore, cols, env): region/ignore (W, U) bool, cols the ignore columns (U,), env the whole mask's
    envelope (what the scorer uses). tibia: the scan's mask; pieces: scans.load_pieces (None: no pieces)."""
    full = np.asarray(tibia[:, v, :], bool)
    env_full = cutline.envelope(full)
    pts = np.asarray(pts, float)
    bone = tibia_part(full, pts)
    env = cutline.envelope(bone)
    m, ign, cols = cutline.region_of(pts, gaps, env, nv, bone=bone)
    far = beyond_line(m, pts)
    m, ign = m & ~far, ign | far | (env_full & ~env)
    if pieces is not None:
        p = np.asarray(pieces[:, v, :])
        if p.any():
            out = piece_outline(p, full)
            m, ign = m & ~out, ign | (m & out)
    return SimpleNamespace(region=m, ignore=ign, cols=cols, env=env_full)


def line_on_mask(bone, pts):
    """Fraction of the densified cut line within 4 voxels of the mask's bone."""
    pts = np.asarray(pts, float)
    seg = np.concatenate([np.linspace(a, b, max(int(np.ceil(np.abs(b - a).max())), 1), endpoint=False) for a, b in zip(pts[:-1], pts[1:])])
    near = ndi.binary_dilation(np.asarray(bone, bool), iterations=4)
    ij = np.clip(np.round(seg).astype(int), 0, np.array(near.shape) - 1)
    return float(near[ij[:, 0], ij[:, 1]].mean())
