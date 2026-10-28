"""Coarse frame for a joint between two long bones, from a bone threshold alone (no segmentation): shaft axes, the
plane they span, a stack of slices along that plane's normal, and the keyframe slice through the joint.

Run this BEFORE `segment_sam`: SAM tracks through a stack of slices, so each slice must show the bones it should
follow, and the scanner's own axes often do not do that.

  python orient_joint.py --in hu.npy --header hu.json --out <outdir> [--threshold-hu 2500]
        [--shaft-radius-mm 1.2] [--ref-radius-mm 3.15] [--min-object-mm3 0.0035] [--margin-mm 0.126]
      Writes <outdir>/frame.json (the frame), oriented.npy (float32 HU stack, axis 0 = slices) with its sidecar,
      and keyframe.jpg (the sheet to look at before going on). Prints the keyframe index and the bend angle.

  from orient_joint import joint_frame, reslice, to_scan     # frame = joint_frame(hu, spacing_mm)
      to_scan(labels_on_stack, frame, scan_shape)             # nearest neighbour, for labels made on the stack

Needs isotropic voxels (the stack is cut on the scan's voxel size), HU in, ZYX order. The three lengths are in mm and
convert to voxels with the scan's spacing; the defaults suit a mouse knee (a mouse femur shaft is under 1.2 mm in
radius; the reference object, the patella, sits within 3.15 mm of the joint). Rescale them for another animal or joint.

How it chooses (details in the comments of joint_frame):
 1. A threshold (Otsu unless given). The two bones are one 3D component because they touch at the joint.
 2. The two end portions of that component seed the two shaft axes; each axis is refit three times on its shaft
    only (35-95% of its length from the joint), so condyles and plateau do not pull it.
 3. The slicing plane is spanned by the two shaft axes (the bending plane); slices stack along its normal, and the
    keyframe is the slice through the joint. Bone A is the shaft passing nearer the reference object (at the knee,
    the femur: the patella sits on it).
Where it fails: a joint inside either 30% end portion (a very short stub); a nearly straight joint (< 10 deg bend:
falls back to the plane through bone A's axis and the reference object); two axes far apart out of plane (one slice
cannot cut both shafts: see `skew_vox`); a large non-bone object near the joint taken for the reference object
(raises when none is found). A fused neighbouring bone (the fibula) pulls bone B's axis slightly.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'microct-core/resources'))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'visual-check/resources'))
import render_slices
import sidecar

END_FRAC = 0.30
SHAFT_RANGE = (0.35, 0.95)
MIN_BEND_DEG = 10.0


def _otsu(v):
    h, e = np.histogram(v, 512)
    c = (e[:-1] + e[1:]) / 2
    w = np.cumsum(h)
    m = np.cumsum(h * c)
    wb, wf = w, w[-1] - w
    mb, mf = m / np.maximum(wb, 1), (m[-1] - m) / np.maximum(wf, 1)
    return float(c[np.argmax(wb * wf * (mb - mf) ** 2)])


def _line_fit(points, weights=None):
    w = np.ones(len(points)) if weights is None else weights
    mu = (points * w[:, None]).sum(0) / w.sum()
    d = points - mu
    _, _, vt = np.linalg.svd(d * np.sqrt(w)[:, None], full_matrices=False)
    return mu, vt[0]


def _slab_line(P, a, mu):
    """Weighted line through 4-voxel slab centroids of P along a (sign kept)."""
    t = (P - mu) @ a
    bins = np.floor((t - t.min()) / 4).astype(int)
    cents, wts = [], []
    for b in np.unique(bins):
        sel = P[bins == b]
        cents.append(sel.mean(0))
        wts.append(len(sel))
    mu_n, a_n = _line_fit(np.array(cents), np.array(wts, float))
    return mu_n, (a_n if a_n @ a > 0 else -a_n)


def _largest_piece(P):
    """Largest 26-connected piece of a point set on the 2x grid (coordinates in full-res voxels)."""
    g = np.round((P - 0.5) / 2).astype(int)
    g -= g.min(0)
    vol = np.zeros(g.max(0) + 1, bool)
    vol[tuple(g.T)] = True
    lab, n = ndi.label(vol, np.ones((3, 3, 3)))
    if n <= 1:
        return P
    big = np.argmax(np.bincount(lab[tuple(g.T)])[1:]) + 1
    return P[lab[tuple(g.T)] == big]


def _closest_points(p1, d1, p2, d2):
    w = p1 - p2
    b = d1 @ d2
    den = 1 - b * b
    s = (b * (d2 @ w) - (d1 @ w)) / den
    u = ((d2 @ w) - b * (d1 @ w)) / den
    return p1 + s * d1, p2 + u * d2


def joint_frame(hu, spacing_mm, threshold_hu=None, shaft_radius_mm=1.2, ref_radius_mm=3.15, min_object_mm3=0.0035,
                margin_mm=0.126):
    cyl_radius = shaft_radius_mm / spacing_mm
    ref_radius = ref_radius_mm / spacing_mm
    min_small_vox = min_object_mm3 / spacing_mm ** 3
    margin = round(margin_mm / spacing_mm)
    sub = np.asarray(hu[::2, ::2, ::2], dtype=np.float32)
    T = _otsu(sub[sub > -600]) if threshold_hu is None else float(threshold_hu)
    fg = sub > T
    closed = ndi.binary_closing(fg, ndi.generate_binary_structure(3, 1), iterations=1) | fg
    lab, n = ndi.label(closed)
    sizes = ndi.sum_labels(fg, lab, range(1, n + 1)) * 8
    order = np.argsort(-sizes)
    pair_id = order[0] + 1
    pair = lab == pair_id
    # shaft seeds from the two end portions of the leg
    P = np.argwhere(pair).astype(np.float64) * 2 + 0.5
    mu0, a0 = _line_fit(P)
    t = (P - mu0) @ a0
    lo, hi = t.min(), t.max()
    L = hi - lo
    ax = []
    for sel, sgn in ((t < lo + END_FRAC * L, -1), (t > hi - END_FRAC * L, 1)):
        Q = _largest_piece(P[sel])
        ax.append(_slab_line(Q, sgn * a0, Q.mean(0)))
    # refine: shaft voxels only, measured from the joint centre
    fits = []
    for _ in range(3):
        q0, q1 = _closest_points(ax[0][0], ax[0][1], ax[1][0], ax[1][1])
        joint = (q0 + q1) / 2
        new = []
        for mu, a in ax:
            s_ = (P - joint) @ a
            d = P - mu
            rad = np.linalg.norm(d - np.outer(d @ a, a), axis=1)
            inc = rad < cyl_radius
            smax = s_[inc].max()
            keep = inc & (s_ > SHAFT_RANGE[0] * smax) & (s_ < SHAFT_RANGE[1] * smax)
            Q = _largest_piece(P[keep])
            new.append(_slab_line(Q, a, Q.mean(0)) + (len(Q), float(smax)))
        fits.append([{'n': n_, 'extent_vox': e_} for *_, n_, e_ in new])
        ax = [(m, a_) for m, a_, *_ in new]
    q0, q1 = _closest_points(ax[0][0], ax[0][1], ax[1][0], ax[1][1])
    joint = (q0 + q1) / 2
    skew = float(np.linalg.norm(q0 - q1))
    ext = [f['extent_vox'] for f in fits[-1]]
    # reference object: the largest other component near the joint
    cand = []
    for i in order[1:]:
        if sizes[i] < min_small_vox:
            break
        c = np.argwhere(lab == i + 1).mean(0) * 2 + 0.5
        if np.linalg.norm(c - joint) < ref_radius:
            cand.append((i + 1, c))
    if not cand:
        sidecar.fail('No reference object near the joint: raise --ref-radius-mm or lower --min-object-mm3, or '
                     'check that --threshold-hu keeps the patella-like bone')
    ref_id, ref_c = cand[0]
    # bone A's shaft line passes nearer the reference object than bone B's
    dl = [np.linalg.norm((ref_c - m) - ((ref_c - m) @ a) * a) for m, a in ax]
    ia = int(np.argmin(dl))
    ib = 1 - ia
    a_a, a_b = ax[ia][1], ax[ib][1]  # each points away from the joint
    ang = float(np.degrees(np.arccos(np.clip(a_a @ a_b, -1, 1))))  # 180 = straight
    bend = 180.0 - ang
    if bend >= MIN_BEND_DEG:
        nrm = np.cross(a_a, a_b)
        plane_rule = 'span of the two shaft axes'
    else:  # straight: plane through bone A's axis and the reference object
        v = ref_c - joint
        nrm = np.cross(a_a, v - (v @ a_a) * a_a)
        plane_rule = 'fallback: bone A axis + reference object'
    nrm /= np.linalg.norm(nrm)
    r = a_b - a_a
    r -= (r @ nrm) * nrm
    r /= np.linalg.norm(r)
    c = np.cross(nrm, r)
    if (ref_c - joint) @ c > 0:
        c, nrm = -c, -nrm
    # grid over the pair + reference object
    P = np.vstack([P, np.argwhere(lab == ref_id).astype(np.float64) * 2 + 0.5])
    R = np.stack([nrm, r, c])
    proj = P @ R.T
    pmin, pmax = proj.min(0) - margin, proj.max(0) + margin
    shape = np.ceil(pmax - pmin).astype(int) + 1
    shape[1:] += shape[1:] % 2
    origin = pmin @ R
    key = round(joint @ nrm - pmin[0])
    Pr = np.argwhere(lab == ref_id).astype(np.float64) * 2 + 0.5
    pf = np.round(Pr @ nrm - pmin[0]).astype(int)
    return {'threshold_hu': T, 'n_components': int(n), 'pair_vox_est': int(sizes[pair_id - 1]), 'refine_fits': fits,
                'ref_object_line_dist_vox': [float(x) for x in dl], 'bone_a_axis_zyx': a_a.tolist(),
                'bone_a_axis_point_zyx': ax[ia][0].tolist(), 'bone_b_axis_zyx': a_b.tolist(),
                'bone_b_axis_point_zyx': ax[ib][0].tolist(), 'bone_a_extent_from_joint_vox': ext[ia],
                'bone_b_extent_from_joint_vox': ext[ib], 'axis_angle_deg': ang, 'bend_deg': bend, 'skew_vox': skew,
                'joint_centre_zyx': joint.tolist(), 'ref_object_centroid_zyx': ref_c.tolist(),
                'ref_object_vox_est': int(sizes[ref_id - 1]), 'ref_object_candidates': len(cand), 'plane_rule': plane_rule,
                'ref_object_frames': [int(pf.min()), int(pf.max())], 'ref_object_largest_frame': int(np.bincount(pf).argmax()),
                'R': R.tolist(), 'normal_zyx': nrm.tolist(), 'origin_zyx': origin.tolist(), 'shape_srs': shape.tolist(),
                'keyframe': key, 'background_hu': float(np.median(sub[~closed]))}


def _grid(frame, s):
    R = np.array(frame['R'])
    o = np.array(frame['origin_zyx'])
    _, H, W = frame['shape_srs']
    r, c = np.mgrid[0:H, 0:W].astype(np.float32)
    return o[:, None, None] + s * R[0][:, None, None] + r * R[1][:, None, None] + c * R[2][:, None, None]


def reslice(hu, frame, order=1, cval=None):
    S, H, W = frame['shape_srs']
    out = np.empty((S, H, W), np.float32)
    for s in range(S):
        out[s] = ndi.map_coordinates(hu, _grid(frame, s), order=order, mode='constant',
                                     cval=frame['background_hu'] if cval is None else cval)
    return out


def to_scan(stack, frame, scan_shape):
    """Nearest-neighbour map of an oriented label stack (S, H, W) back to the scan grid (Z, Y, X)."""
    R = np.array(frame['R'])
    o = np.array(frame['origin_zyx'])
    S, H, W = stack.shape
    out = np.zeros(scan_shape, stack.dtype)
    yy, xx = np.mgrid[0:scan_shape[1], 0:scan_shape[2]].astype(np.float64)
    for z in range(scan_shape[0]):
        d = np.stack([np.full_like(yy, z), yy, xx]) - o[:, None, None]
        idx = [np.rint(np.tensordot(R[i], d, 1)).astype(np.int64) for i in range(3)]
        ok = (idx[0] >= 0) & (idx[0] < S) & (idx[1] >= 0) & (idx[1] < H) & (idx[2] >= 0) & (idx[2] < W)
        out[z][ok] = stack[idx[0][ok], idx[1][ok], idx[2][ok]]
    return out


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--in', dest='src', required=True, help='hu.npy')
    ap.add_argument('--header', required=True, help='hu.json from scan-intake')
    ap.add_argument('--out', required=True, help='output directory')
    ap.add_argument('--threshold-hu', type=float, help='bone threshold; default Otsu on the volume')
    ap.add_argument('--shaft-radius-mm', type=float, default=1.2)
    ap.add_argument('--ref-radius-mm', type=float, default=3.15)
    ap.add_argument('--min-object-mm3', type=float, default=0.0035)
    ap.add_argument('--margin-mm', type=float, default=0.126)
    ap.add_argument('--window', help='lo,hi for the keyframe sheet, e.g. 1000,8000')
    a = ap.parse_args()
    g = sidecar.grid(a.header)
    sp = g['spacing_zyx_mm']
    if not np.allclose(sp, sp[0], rtol=1e-3):
        sidecar.fail(f'Voxels are not isotropic ({sp} mm): resample the volume before orienting')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    hu = np.load(a.src, mmap_mode='r')
    params = {'threshold_hu': a.threshold_hu, 'shaft_radius_mm': a.shaft_radius_mm, 'ref_radius_mm': a.ref_radius_mm,
                  'min_object_mm3': a.min_object_mm3, 'margin_mm': a.margin_mm}
    frame = joint_frame(hu, sp[0], **params)
    stack = reslice(hu, frame)
    np.save(out / 'oriented.npy', stack)
    frame['parent_grid_id'] = g['grid_id']
    frame['grid_id'] = sidecar.derived_grid_id(g['grid_id'], {k: frame[k] for k in ('R', 'origin_zyx', 'shape_srs')})
    (out / 'frame.json').write_text(json.dumps(frame, indent=1, default=float) + '\n')
    sidecar.write(out / 'oriented.npy', grid_id=frame['grid_id'], spacing_zyx_mm=sp, inputs=[a.src, a.header],
                  params=params)
    k = frame['keyframe']
    render_slices.render(stack[k], out / 'keyframe.jpg', render_slices.vl.parse_window(a.window) if a.window else None,
                         title=f'keyframe {k} of {len(stack)}')
    sidecar.emit(frame=str(out / 'frame.json'), oriented=str(out / 'oriented.npy'), keyframe_image=str(out / 'keyframe.jpg'),
                 keyframe=k, slices=len(stack), bend_deg=round(frame['bend_deg'], 1), skew_vox=round(frame['skew_vox'], 1),
                 threshold_hu=round(frame['threshold_hu'], 1), plane_rule=frame['plane_rule'],
                 ref_object_frames=frame['ref_object_frames'], oriented_shape=list(stack.shape))
