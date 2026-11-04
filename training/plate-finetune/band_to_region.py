"""Turn predicted band masks into cut lines and IIOC regions, so a band model is voted and scored like a region model.

  python band_to_region.py --pred preds/band-s0 --out preds/band-s0-region

Per section: the band mask's connected pieces, each piece's skeleton reduced to its longest geodesic path, its ends continued
along their last stretch to the cortex (at most EXT_MAX voxels); pieces that do not overlap in U, longest first, joined left to
right into one polyline (the skeleton line). With --cut midline (the default) each point of that line then moves to the midpoint
of the band's two faces in its column, where the faces exist and the midpoint is within MID_MAX voxels; the faces are the band's
vertical run nearest the skeleton line in each column (band_faces). The region is labels.label_section on the line, the rule that
built the region labels. A perfect band (the traced one) scores the label floor, ~11 µm, through the skeleton line. Writes
<out>/<scan>.npz (V, mask: the region) and <out>/<scan>-lines.json ({V: [[w, u], ...]}, the line the region was cut on); a
section with no line has an empty region.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import distance_transform_edt, label
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from skimage.morphology import skeletonize

import cutline
import labels
import scans

MIN_PIECE = 12     # voxels of path: shorter pieces are noise
EXT_MAX = 10       # voxels an end is continued along its direction to reach the cortex
MID_MAX = 4        # voxels: a line point moves to the faces' midpoint only when it is this close


def skeleton_path(comp):
    """Longest geodesic path along the skeleton of a bool mask, (n, 2) [w, u] left to right, or None."""
    sk = skeletonize(comp)
    ys, xs = np.nonzero(sk)
    n = len(ys)
    if n < 2:
        return None
    idx = -np.ones(comp.shape, int)
    idx[ys, xs] = np.arange(n)
    r, c, w = [], [], []
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        y2, x2 = ys + dy, xs + dx
        ok = (y2 >= 0) & (x2 >= 0) & (x2 < comp.shape[1]) & (y2 < comp.shape[0])
        j = np.full(n, -1)
        j[ok] = idx[y2[ok], x2[ok]]
        m = j >= 0
        r += list(np.arange(n)[m])
        c += list(j[m])
        w += [np.hypot(dy, dx)] * int(m.sum())
    g = coo_matrix((w, (r, c)), shape=(n, n))
    d = dijkstra(g, directed=False, indices=0)
    a = int(np.argmax(np.where(np.isfinite(d), d, -1)))
    d, pred = dijkstra(g, directed=False, indices=a, return_predecessors=True)
    b = int(np.argmax(np.where(np.isfinite(d), d, -1)))
    path = [b]
    while path[-1] != a:
        path.append(pred[path[-1]])
    p = np.stack([ys[path], xs[path]], 1).astype(float)
    return p if p[0, 1] <= p[-1, 1] else p[::-1]


def at(depth, p):
    return depth[min(max(int(round(p[0])), 0), depth.shape[0] - 1), min(max(int(round(p[1])), 0), depth.shape[1] - 1)]


def extend(p, depth):
    """Continue both ends of path p along their last stretch until they reach the envelope's outside (at most EXT_MAX voxels)."""
    for first in (True, False):
        seq = p[::-1] if first else p
        if at(depth, seq[-1]) <= 1:
            continue
        back = np.flatnonzero(np.hypot(*(seq - seq[-1]).T) >= 4)
        if not len(back):
            continue
        d = seq[-1] - seq[back[-1]]
        d = d / np.hypot(*d)
        ext = []
        for k in range(1, EXT_MAX + 1):
            q = seq[-1] + d * k
            ext.append(q)
            if at(depth, q) <= 1:
                break
        p = np.vstack([ext[::-1], p]) if first else np.vstack([p, ext])
    return p


def arc(p):
    return float(np.hypot(*np.diff(p, axis=0).T).sum()) if len(p) > 1 else 0.0


def line_of(band, env):
    """Band mask (W, U) -> cut line (n, 2) [w, u] left to right, or None when no piece is long enough."""
    comp, n = label(band, structure=np.ones((3, 3)))
    depth = distance_transform_edt(np.pad(env, 1))[1:-1, 1:-1]
    pieces = []
    for i in range(1, n + 1):
        if (comp == i).sum() < MIN_PIECE:
            continue
        p = skeleton_path(comp == i)
        if p is None or arc(p) < MIN_PIECE:
            continue
        pieces.append(extend(p, depth))
    keep = []
    for p in sorted(pieces, key=arc, reverse=True):
        lo, hi = p[:, 1].min(), p[:, 1].max()
        if all(min(hi, b) - max(lo, a) <= 0.2 * (hi - lo) for a, b in ((q[:, 1].min(), q[:, 1].max()) for q in keep)):
            keep.append(p)
    keep.sort(key=lambda p: p[:, 1].mean())
    return np.vstack(keep) if keep else None


def line_rows(p, n_u):
    """Polyline (n, 2) [w, u] -> W per U column, NaN off the line; the median W where the path crosses a column more than once."""
    w = np.full(n_u, np.nan)
    d = np.concatenate([np.linspace(a, b, max(int(np.ceil(np.abs(b - a).max())), 1), endpoint=False) for a, b in zip(p[:-1], p[1:])])
    u = np.clip(np.round(d[:, 1]).astype(int), 0, n_u - 1)
    for c in np.unique(u):
        w[c] = np.median(d[u == c, 0])
    return w


def band_faces(band, line):
    """Per U column the line crosses, the band's vertical run nearest the line: its top (proximal) and bottom (distal) W, NaN elsewhere."""
    lw = line_rows(line, band.shape[1])
    top, bot = np.full(band.shape[1], np.nan), np.full(band.shape[1], np.nan)
    for u in np.flatnonzero(~np.isnan(lw)):
        rows = np.flatnonzero(band[:, u])
        if not len(rows):
            continue
        runs = np.split(rows, np.flatnonzero(np.diff(rows) > 1) + 1)
        r = min(runs, key=lambda r: abs((r[0] + r[-1]) / 2 - lw[u]))
        top[u], bot[u] = r[0], r[-1]
    return top, bot


def midline(line, top, bot):
    """The line with each point's W replaced by the faces' midpoint in its column, where that is within MID_MAX voxels of it."""
    p = line.copy()
    for k, (w, u) in enumerate(line):
        c = int(round(u))
        if 0 <= c < len(top) and not np.isnan(top[c]) and abs((top[c] + bot[c]) / 2 - w) <= MID_MAX:
            p[k, 0] = (top[c] + bot[c]) / 2
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", required=True, type=Path, help="predict.py output of a band model")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--cut", choices=("midline", "skeleton"), default="midline", help="cut on the faces' midline or on the skeleton line")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    for f in sorted(a.pred.glob("*.npz")):
        scan = f.stem
        z = np.load(f)
        tibia, pieces, nv = scans.load_tibia_mask(scan), scans.load_pieces(scan), labels.not_visible_ranges(scan)
        region = np.zeros_like(z["mask"])
        lines = {}
        for i, v in enumerate(int(v) for v in z["V"]):
            p = line_of(z["mask"][i], cutline.envelope(tibia[:, v, :])) if z["mask"][i].any() else None
            if p is not None and len(p) > 1:
                if a.cut == "midline":
                    p = midline(p, *band_faces(z["mask"][i], p))
                region[i] = labels.label_section(v, p, [], nv.get(v, ()), tibia, pieces).region
                lines[v] = p.tolist()
        np.savez_compressed(a.out / f"{scan}.npz", V=z["V"], mask=region)
        (a.out / f"{scan}-lines.json").write_text(json.dumps(lines))
        print(scan, len(lines), "lines of", len(z["V"]), "sections", flush=True)


if __name__ == "__main__":
    main()
