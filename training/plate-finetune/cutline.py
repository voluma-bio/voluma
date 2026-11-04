"""The IIOC cut line of one coronal section: the label rule the exporter, the band-to-region step and the scorer share.

Copied from the tracing tools that drew the labels; a change here changes every label, so re-export and compare.

The label is one line per section (axes W rows, U columns): through the centre of the growth plate, across the
tibia's full width, out through the cortex at both sides. Where the plate is closed or eroded the tracers kept both
faces on the dense bone left in its place, so the centre of the two faces is that dense bone line. The line splits the
IIOC (epiphysis, low W) from the metaphysis.

The line is a polyline, not a function of U: at its ends it bends down steeply, following the plate round the condyle.
derive(): the centre of the proximal and distal faces per U (where both are defined), plus the end points a tracer
adds in trace/ends.json (`{"<V>": {"left": [[w, u], ...], "right": [[w, u], ...]}}`, each list continuing the centre
line outward through the cortex, starting on the centre line at its last point or, where the plate turns down earlier,
at the branch column, beyond which the centre line is dropped). Nothing is extrapolated: an end with no entry stops at the traced range. Faces
further apart than MAX_GAP voxels in U are a gap (no line there). A reviewer's fixed cut is one polyline, no gaps.

Ignore columns of a section: the gaps, a reviewer's not-visible ranges, and every column outside the line's U extent
on a side whose end is untraced. A side is open (traced through the cortex) when the line's end point lies within
OPEN_DIST voxels of the envelope's outside; the line then walls the IIOC off from the metaphysis all the way out, so
nothing is clipped or ignored on that side. region_of(): the tibia's envelope (clipped to the line's extent on closed
sides), cut by the line as a wall; the component on the joint side is the IIOC region.

Label clean-up (region_of): pockets the region encloses with the cut line are filled (the envelope leaves big marrow cavities open);
with `bone` given, separate bone pieces not joined to the epiphysis body by bone (an ossicle, a patella or femur fragment, a bar
above the joint) are ignore, not region (loose_pieces).

The tibia mask holds bone voxels only (marrow and the gaps of trabecular bone are 0), so "the tibia" is envelope():
the mask closed by ENV_RADIUS voxels, holes filled.

numpy and scipy; no scans layout knowledge beyond the arrays passed in.
"""
import numpy as np
from scipy.ndimage import binary_closing, binary_dilation, binary_fill_holes, binary_opening, distance_transform_edt, label
from skimage.morphology import convex_hull_image, disk

MAX_GAP = 15      # voxels in U; consecutive face points more than this apart are a gap (no plate traced there)
OPEN_DIST = 3     # voxels: a line end this close to the envelope's outside has exited the cortex
SAT_RADIUS = 8    # voxels: a region piece that survives no opening by this disk is joined to the body only by a thin bridge
SAT_MIN = 400     # voxels: smaller pieces (thin tails of the end bending down a condyle) are left in the region
SAT_FRAC = 0.35   # a piece at least this fraction of the body is a condyle block (deep intercondylar notch), not a satellite
PIECE_CLOSE = 2   # voxels: bone pieces of the region closer than this (closing radius) are one piece (a thin neck of bone joins them)
PIECE_MIN = 200   # bone voxels: smaller pieces (trabecular fragments next to the plate) stay in the region
PIECE_FRAC = 0.2  # a bone piece smaller than this fraction of the largest, and not joined to it by bone, is not epiphysis (ossicle, patella or femur fragment, a bar above the joint)
FILL_CLOSE = 3    # voxels: a pocket of the region enclosed by region and cut line, with an opening up to this wide, is filled
ENV_RADIUS = 6    # voxels (63 um): closes the pores of trabecular bone, not the gap between tibia and fibula head


def face_rows(poly, n_cols, max_gap=MAX_GAP):
    """Polyline [[w, u], ...] -> W per U column: interpolated between consecutive points at most max_gap apart in U,
    NaN elsewhere (outside the polyline's U extent, or where the tracer left the plate out)."""
    poly = np.asarray(poly, float)
    poly = poly[np.argsort(poly[:, 1], kind="stable")]
    w = np.full(n_cols, np.nan)
    for (w0, u0), (w1, u1) in zip(poly[:-1], poly[1:]):
        if u1 - u0 <= max_gap:
            c = np.arange(max(int(np.ceil(u0)), 0), min(int(np.floor(u1)), n_cols - 1) + 1)
            w[c] = np.interp(c, [u0, u1], [w0, w1])
    return w


def derive(prox, dist, n_u, ends=None, max_gap=MAX_GAP):
    """Agent trace -> cut line of one section, as runs: a list of (n, 2) arrays of [w, u] points left to right, one per
    stretch the tracer covered (consecutive runs are separated by a gap). ends: this V's entry of ends.json or None."""
    w = (face_rows(prox, n_u, max_gap) + face_rows(dist, n_u, max_gap)) / 2
    u = np.flatnonzero(~np.isnan(w))
    if not len(u):
        return []
    runs = [np.stack([w[r], r.astype(float)], 1) for r in np.split(u, np.flatnonzero(np.diff(u) > 1) + 1)]
    ends = ends or {}
    # An end may branch off before the centre line's last point (the plate turns down before the traced faces stop):
    # its first point's U is the branch column, and the centre line beyond it on that side is dropped.
    if ends.get("left"):
        e = np.asarray(ends["left"], float)
        r = runs[0][runs[0][:, 1] > e[0, 1]]
        runs[0] = np.vstack([e[::-1], r])
    if ends.get("right"):
        e = np.asarray(ends["right"], float)
        r = runs[-1][runs[-1][:, 1] < e[0, 1]]
        runs[-1] = np.vstack([r, e])
    return runs


def flatten(runs):
    """Runs -> (points (n, 2), gaps [[u0, u1], ...]): the whole polyline (a gap is bridged by a straight segment) and
    the U columns between runs."""
    gaps = [[int(a[-1, 1]) + 1, int(np.ceil(b[0, 1])) - 1] for a, b in zip(runs[:-1], runs[1:])]
    return np.vstack(runs), [g for g in gaps if g[0] <= g[1]]


def envelope(tibia_mask_section):
    """Solid outline of the tibia in one section: bool (W, U)."""
    m = np.pad(np.asarray(tibia_mask_section, bool), ENV_RADIUS)
    m = binary_fill_holes(binary_closing(m, disk(ENV_RADIUS)))
    return m[ENV_RADIUS:-ENV_RADIUS, ENV_RADIUS:-ENV_RADIUS]


def wall(pts, shape):
    """Rasterise the polyline [[w, u], ...] into a 4-connected line, bool (W, U): an 8-connected fill cannot cross it."""
    out = np.zeros(shape, bool)
    pts = np.asarray(pts, float)
    prev = None
    for a, b in zip(pts[:-1], pts[1:]):
        n = int(np.ceil(np.abs(b - a).max() * 2)) + 1
        for t in np.linspace(0, 1, n):
            r, c = (int(round(x)) for x in a + (b - a) * t)
            if prev is not None and prev[0] != r and prev[1] != c and 0 <= prev[0] < shape[0] and 0 <= c < shape[1]:
                out[prev[0], c] = True     # corner pixel: a diagonal step becomes two 4-connected ones
            if 0 <= r < shape[0] and 0 <= c < shape[1]:
                out[r, c] = True
            prev = (r, c)
    return out


def _exit_ends(pts, at, left, right):
    """The polyline with each open end (within OPEN_DIST of the envelope's outside) continued 2 * OPEN_DIST voxels outward
    along its last stretch: an end that stops inside the envelope's last voxels would otherwise let the fill walk round it."""
    out = pts
    for end, first in ((left, True), (right, False)):
        if at(end) > OPEN_DIST:
            continue
        seq = pts if not first else pts[::-1]
        # direction from the point at least 4 voxels back along the line (an end's last steps can be jagged)
        back = np.flatnonzero(np.hypot(*(seq - seq[-1]).T) >= 4)
        if not len(back):
            continue
        d = seq[-1] - seq[back[-1]]
        ext = seq[-1] + d / np.hypot(*d) * 2 * OPEN_DIST
        out = np.vstack([out, ext]) if not first else np.vstack([ext, out])
    return out


def satellites(region):
    """Pieces of the region that are probably not epiphysis: bool (W, U). Opening by SAT_RADIUS leaves the body (its
    biggest piece); region voxels farther than SAT_RADIUS from it, in pieces of SAT_MIN voxels or more and under
    SAT_FRAC of the body, are satellites (a lump hanging off the condyle's side, a bar above the joint).
    A bright piece on the joint's rim joined by a thick bridge (OA6-14LK3 V109) is not separable by shape and stays."""
    r = SAT_RADIUS
    c, n = label(binary_opening(np.pad(region, r), disk(r))[r:-r, r:-r], structure=np.ones((3, 3)))
    if not n:
        return np.zeros_like(region)
    size = np.bincount(c.ravel())[1:]
    far = region & ~binary_dilation(c == size.argmax() + 1, disk(r))
    pieces, m = label(far, structure=np.ones((3, 3)))
    out = np.zeros_like(region)
    for i in range(1, m + 1):
        k = (pieces == i).sum()
        if SAT_MIN <= k < SAT_FRAC * size.max():
            out |= pieces == i
    return out


def loose_pieces(region, bone):
    """Region voxels belonging to a separate bone piece, bool (W, U). bone: the tibia mask's bone voxels of this section.
    The region's bone, closed by PIECE_CLOSE, falls into pieces; a piece of PIECE_MIN voxels or more, under PIECE_FRAC of the
    largest, and mostly outside the largest one's hull (its convex hull: an island of trabecula inside the
    body is no ossicle) is loose, and so are the region voxels outside that hull nearer to it than to any other piece (the
    envelope closes the gap round it, so the region holds its whole outline). Pieces joined to the body by bone are never loose."""
    r = PIECE_CLOSE
    b = region & bone
    comp, n = label(binary_closing(np.pad(b, r), disk(r))[r:-r, r:-r] | b, structure=np.ones((3, 3)))
    if n < 2:
        return np.zeros_like(region)
    size = np.bincount(comp[b], minlength=n + 1)
    main = size.argmax()
    hull = convex_hull_image(comp == main)
    loose = [i for i in range(1, n + 1) if size[i] >= PIECE_MIN and size[i] < PIECE_FRAC * size.max() and (hull & b & (comp == i)).sum() < size[i] / 2]
    if not loose:
        return np.zeros_like(region)
    nearest = comp[tuple(distance_transform_edt(comp == 0, return_distances=False, return_indices=True))]
    return region & ~hull & np.isin(nearest, loose)


def fill_pockets(region, wall_mask):
    """The region plus the pockets it encloses together with the cut line (marrow cavities the tibia envelope leaves open: the
    envelope's closing only bridges 2 * ENV_RADIUS voxels), bool (W, U)."""
    r = FILL_CLOSE
    seal = np.pad(region | wall_mask, r)
    return (binary_fill_holes(binary_closing(seal, disk(r)))[r:-r, r:-r] & ~wall_mask) | region


def region_of(pts, gaps, env, not_visible=(), bone=None):
    """(region, ignore, ignore_cols) for one section, bool (W, U), (W, U), (U,).
    pts/gaps: the cut line as flatten() returns it; env: envelope(); not_visible: [[u0, u1], ...] a reviewer marked.
    satellites() pieces, and with `bone` (the tibia mask's section) the loose_pieces() the bone connectivity finds, are ignore, not region;
    pockets the region encloses with the cut line are filled (fill_pockets). ignore_cols: gaps, not-visible ranges and the columns outside the line's U extent on a closed side; ignore = the tibia's voxels in
    them (neither IIOC nor background). region = envelope (inside the extent on closed sides) minus the wall; of the pieces that
    leaves, the joint-side one: of those at least a quarter the size of the largest, the one with the lowest centroid W."""
    n_w, n_u = env.shape
    pts = np.asarray(pts, float)
    depth = distance_transform_edt(np.pad(env, 1))[1:-1, 1:-1]     # voxels to the envelope's outside (0 outside it)
    at = lambda p: depth[min(max(int(round(p[0])), 0), n_w - 1), min(max(int(round(p[1])), 0), n_u - 1)]
    left, right = pts[np.argmin(pts[:, 1])], pts[np.argmax(pts[:, 1])]
    inside = np.zeros(n_u, bool)
    inside[0 if at(left) <= OPEN_DIST else max(int(np.floor(left[1])), 0):
           n_u if at(right) <= OPEN_DIST else int(np.ceil(right[1])) + 1] = True
    ign_cols = ~inside
    for u0, u1 in [*gaps, *not_visible]:
        ign_cols[max(int(u0), 0):int(u1) + 1] = True
    free = env & ~wall(_exit_ends(pts, at, left, right), env.shape) & inside[None]
    comp, n = label(free, structure=np.ones((3, 3)))
    region = np.zeros_like(free)
    if n:
        size = np.bincount(comp.ravel(), minlength=n + 1)[1:]
        rows = np.bincount(comp.ravel(), weights=np.broadcast_to(np.arange(n_w)[:, None], comp.shape).ravel(), minlength=n + 1)[1:]
        mean_w = rows / np.maximum(size, 1)
        big = np.flatnonzero(size >= size.max() / 4)
        region = comp == big[np.argmin(mean_w[big])] + 1
    region = fill_pockets(region, wall(pts, env.shape) & ~region)
    sat = satellites(region)
    if bone is not None:
        sat |= loose_pieces(region & ~sat, np.asarray(bone, bool))
    return region & ~sat, (env & ign_cols[None]) | sat, ign_cols


def cut_boundary(region, env):
    """The region's side of its cut: region voxels 4-adjacent to envelope voxels outside the region (the articular
    surface and the cortex are envelope edges, not cut). Steep line ends stay one boundary, unlike a distal edge per U."""
    other = env & ~region
    near = np.zeros_like(other)
    near[1:] |= other[:-1]; near[:-1] |= other[1:]; near[:, 1:] |= other[:, :-1]; near[:, :-1] |= other[:, 1:]
    return region & near


def region_edge(region):
    """Per U column: W of the first row below the region (its distal edge); NaN where the column has no region."""
    has = region.any(0)
    return np.where(has, region.shape[0] - region[::-1].argmax(0), np.nan)
