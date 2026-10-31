"""Orient a joint: find both bones' shaft axes from a bone threshold and stack slices along their plane.

Run this BEFORE `segment_sam`: SAM tracks through a stack of slices, so each slice must show the bones it should
follow, and the scanner's own axes often do not do that. Writes the frame, the oriented stack and the keyframe slice
through the joint (the sheet to look at before going on). No segmentation is needed.

Needs isotropic voxels (the stack is cut on the scan's voxel size), HU in, ZYX order. The threshold and the three sizes are required (sizes in mm),
converted to voxels with the scan's spacing: they say how big this animal's bones are, so the workflow's anatomy
reference gives them (the shaft radius is the widest a shaft gets, the reference radius how near the joint the reference
object sits, the minimum object volume the smallest piece worth considering).

How it chooses (details in the comments of joint_frame):
 1. The --threshold-hu bone threshold and 3D pieces. The bones are the largest piece plus, if there is one, the largest
    other piece within --ref-radius-mm of it that is at least --second-bone-frac of its size: femur and tibia are one
    touching piece, or two pieces across the joint space. Smaller pieces (the patella) are reference object candidates.
 2. The two end portions of the bones along their main axis seed the two shaft axes; each axis is refit three times
    on its shaft only (35-95% of its length from the joint), so condyles and plateau do not pull it. The joint is
    where the axes pass closest. Each shaft in the field must be at least 3 shaft radii long.
 3. With no shaft in the field, and two separate pieces: the leg axis is the line through the two centroids, the joint
    half way across the gap, `bend_deg` and `skew_vox` are null (a bend cannot be measured from bone ends). With no
    shaft and one piece the script stops.
 4. The slicing plane is spanned by the two shaft axes (the bending plane); slices stack along its normal, and the
    keyframe is the slice through the joint. When the joint is straight (< 10 deg) or there is no shaft, the plane holds
    the leg axis and the reference object, or, with none, the widest spread of the bones. Bone A is the shaft passing
    nearer the reference object (at the knee, the femur: the patella sits on it); with no shaft or no reference object
    it is the bigger bone, and the side of the slice the reference sits on is then arbitrary.
 5. It counts each bone's voxels in the keyframe (`keyframe_bone_vox`) and stops if one has under 5% of the other's.
Where it fails: a joint inside either 30% end portion (a very short stub); two axes far apart out of plane (one slice
cannot cut both shafts: see `skew_vox`); no shaft and no second piece of at least --second-bone-frac (stops); a non-bone
piece taken for the second bone or the reference object when size cannot tell (a large patella, a fragment). The keyframe
check splits voxels by side of the joint, so with one touching piece it cannot tell two bones from one bone's shaft and
condyles; the 3-radius shaft check covers that case.
A fused neighbouring bone (the fibula) pulls bone B's axis slightly.

Writes: <out>/frame.json  the frame (`microct-core/resources/frame.py` has its schema and the maps to and from the scan, plus this script's diagnostics and `keyframe`)
        <out>/oriented.npy  float32 HU stack, axis 0 = slices, with its sidecar (its own grid)
        <out>/keyframe.jpg  the keyframe slice
Prints: one JSON line {frame, oriented, keyframe_image, keyframe, slices, bend_deg, skew_vox, shafts_found, keyframe_bone_vox, threshold_hu, plane_rule, ref_object_frames, oriented_shape}
Example: python orient_joint.py --in hu.npy --header hu.json --out orient --threshold-hu 2500 --shaft-radius-mm 0.9 --ref-radius-mm 3 --min-object-mm3 0.5
Exits 2 with one sentence on bad input, before writing anything.
"""
from pathlib import Path

import frame as fr
import numpy as np
import render_slices
import sidecar
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

END_FRAC = 0.30
SHAFT_RANGE = (0.35, 0.95)
MIN_BEND_DEG = 10.0
MIN_ELONGATION = 2.0  # spread along the main axis over spread across it; a blob is about 1
MIN_SHAFT_RADII = 3.0  # a shaft in the field is at least this many shaft radii long
MIN_CUT_FRAC = 0.05  # each bone must have this fraction of the other's voxels in the keyframe


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


def _elongation(P):
    """Spread along the main axis over the spread across it: about 1 for a blob, above 2 for a shaft."""
    w = np.linalg.eigvalsh(np.cov(P.T))
    return float(np.sqrt(w[2] / w[1]))


def _fit_shafts(P, cyl_radius):
    """Two shaft axes from the end portions of P, refit on the shaft voxels. Returns (axes, fits, joint, skew), or None
    when a refit finds no shaft voxels."""
    mu0, a0 = _line_fit(P)
    t = (P - mu0) @ a0
    lo, hi = t.min(), t.max()
    ax = []
    for sel, sgn in ((t < lo + END_FRAC * (hi - lo), -1), (t > hi - END_FRAC * (hi - lo), 1)):
        Q = _largest_piece(P[sel])
        ax.append(_slab_line(Q, sgn * a0, Q.mean(0)))
    fits = []
    for _ in range(3):
        q0, q1 = _closest_points(ax[0][0], ax[0][1], ax[1][0], ax[1][1])
        joint = (q0 + q1) / 2
        new = []
        for mu, a in ax:
            s_ = (P - joint) @ a
            d = P - mu
            inc = np.linalg.norm(d - np.outer(d @ a, a), axis=1) < cyl_radius
            if not inc.any():
                return None
            smax = s_[inc].max()
            keep = inc & (s_ > SHAFT_RANGE[0] * smax) & (s_ < SHAFT_RANGE[1] * smax)
            if not keep.any():
                return None
            Q = _largest_piece(P[keep])
            new.append(_slab_line(Q, a, Q.mean(0)) + (len(Q), float(smax)))
        fits.append([{'n': n_, 'extent_vox': e_} for *_, n_, e_ in new])
        ax = [(m, a_) for m, a_, *_ in new]
    q0, q1 = _closest_points(ax[0][0], ax[0][1], ax[1][0], ax[1][1])
    return ax, fits, (q0 + q1) / 2, float(np.linalg.norm(q0 - q1))


def _gap_axis(PA, PB):
    """Leg axis and joint for two separate bone pieces with no shaft in the field: the line through the two centroids, the
    joint half way across the gap between the pieces along it. Each axis points from the joint into its bone."""
    cA, cB = PA.mean(0), PB.mean(0)
    u = (cA - cB) / np.linalg.norm(cA - cB)
    joint = cB + u * (((PA - cB) @ u).min() + ((PB - cB) @ u).max()) / 2
    return [(joint, u), (joint, -u)], joint


def joint_frame(hu, spacing_mm, shaft_radius_mm, ref_radius_mm, min_object_mm3, threshold_hu,
                margin_mm=0.126, second_bone_frac=0.25):
    cyl_radius = shaft_radius_mm / spacing_mm
    ref_radius = ref_radius_mm / spacing_mm
    min_small_vox = min_object_mm3 / spacing_mm ** 3
    margin = round(margin_mm / spacing_mm)
    sub = np.asarray(hu[::2, ::2, ::2], dtype=np.float32)
    T = float(threshold_hu)
    fg = sub > T
    closed = ndi.binary_closing(fg, ndi.generate_binary_structure(3, 1), iterations=1) | fg
    lab, n = ndi.label(closed)
    if n == 0:
        sidecar.fail(f'No bone found above {T:.0f} HU: check the volume and --threshold-hu')
    sizes = ndi.sum_labels(fg, lab, range(1, n + 1)) * 8
    order = np.argsort(-sizes)
    cents = np.array(ndi.center_of_mass(fg, lab, range(1, n + 1))) * 2 + 0.5
    # Bones: the largest piece, plus the largest other piece within reach of it and at least `second_bone_frac` of its
    # size. Position along the largest piece does not separate tibia from patella in a flexed or cropped knee, so size
    # alone decides, and the keyframe check catches a second bone the slice misses.
    P0 = np.argwhere(lab == order[0] + 1).astype(np.float64) * 2 + 0.5
    tree = cKDTree(P0[::4])
    second, small_near = None, False
    for i in order[1:]:
        if sizes[i] < min_small_vox:
            break
        Pi = np.argwhere(lab == i + 1).astype(np.float64) * 2 + 0.5
        if tree.query(Pi[::4])[0].min() > ref_radius:
            continue
        small_near = sizes[i] < second_bone_frac * sizes[order[0]]
        second = None if small_near else i
        break
    ids = [order[0]] + ([] if second is None else [second])
    P = np.vstack([P0] + ([] if second is None else [Pi]))
    fit = _fit_shafts(P, cyl_radius) if _elongation(P) >= MIN_ELONGATION else None
    if fit is not None and min(f['extent_vox'] for f in fit[1][-1]) < MIN_SHAFT_RADII * cyl_radius:
        fit = None
    if fit is None and second is None:
        why = ('the bones are not clearly longer than wide' if _elongation(P) < MIN_ELONGATION else
               f'a shaft reaches under {MIN_SHAFT_RADII:g} shaft radii from the joint')
        hint = (f'; a piece near it is under --second-bone-frac {second_bone_frac:g} of its size: if that is the other '
                'long bone (a short stub), lower --second-bone-frac and check that the keyframe holds it'
                if small_near else '; scan more of the leg')
        sidecar.fail(f'No shaft in the field: {why}, and there is no second bone piece, so no axis can be fitted{hint}')
    if fit is not None:
        ax, fits, joint, skew = fit
        ext = [f['extent_vox'] for f in fits[-1]]
    else:  # two separate pieces, no shaft in the field
        PA, PB = P0, Pi  # the largest piece is A
        ax, joint = _gap_axis(PA, PB)
        fits, skew = None, None
        ext = [float(((Q - joint) @ a).max()) for Q, (_, a) in zip((PA, PB), ax)]
    side_a = ((P - joint) @ (ax[0][1] - ax[1][1])) > 0  # which side of the bisecting plane at the joint
    # reference object: the largest other component near the joint
    cand = [(i + 1, cents[i]) for i in order if i not in ids and sizes[i] >= min_small_vox
            and np.linalg.norm(cents[i] - joint) < ref_radius]
    ref_id, ref_c = cand[0] if cand else (None, None)
    dl = None
    if fit is not None and ref_c is not None:
        # bone A's shaft line passes nearer the reference object than bone B's
        dl = [float(np.linalg.norm((ref_c - m) - ((ref_c - m) @ a) * a)) for m, a in ax]
        ia = int(np.argmin(dl))
    else:  # nothing to tell the bones apart by: the bigger bone is A
        ia = 0 if side_a.sum() >= (~side_a).sum() else 1
    ib = 1 - ia
    a_a, a_b = ax[ia][1], ax[ib][1]  # each points away from the joint
    ang = float(np.degrees(np.arccos(np.clip(a_a @ a_b, -1, 1)))) if fit is not None else None  # 180 = straight
    bend = None if ang is None else 180.0 - ang
    if bend is not None and bend >= MIN_BEND_DEG:
        nrm = np.cross(a_a, a_b)
        plane_rule = 'span of the two shaft axes'
    else:  # straight or no shaft: the plane holds the leg axis and one more direction
        if ref_c is not None:
            w = ref_c - joint
            plane_rule = 'leg axis + reference object'
        else:
            w = _line_fit(P[::20] - np.outer(P[::20] @ a_a, a_a))[1]
            plane_rule = 'leg axis + widest spread of the bones'
        nrm = np.cross(a_a, w - (w @ a_a) * a_a)
    nrm /= np.linalg.norm(nrm)
    r = a_b - a_a
    r -= (r @ nrm) * nrm
    r /= np.linalg.norm(r)
    c = np.cross(nrm, r)
    if ref_c is not None and (ref_c - joint) @ c > 0:
        c, nrm = -c, -nrm
    # grid over the bones + reference object
    if ref_c is not None:
        Pr = np.argwhere(lab == ref_id).astype(np.float64) * 2 + 0.5
        P = np.vstack([P, Pr])
    R = np.stack([nrm, r, c])
    proj = P @ R.T
    pmin, pmax = proj.min(0) - margin, proj.max(0) + margin
    shape = np.ceil(pmax - pmin).astype(int) + 1
    shape[1:] += shape[1:] % 2
    origin = pmin @ R
    key = round(joint @ nrm - pmin[0])
    pf = None if ref_c is None else np.round(Pr @ nrm - pmin[0]).astype(int)
    frame = {'threshold_hu': T, 'n_components': int(n), 'n_bone_pieces': len(ids), 'bone_vox_est': int(sizes[ids].sum()),
             'shafts_found': fit is not None, 'refine_fits': fits, 'ref_object_line_dist_vox': dl,
             'bone_a_axis_zyx': a_a.tolist(), 'bone_a_axis_point_zyx': ax[ia][0].tolist(), 'bone_b_axis_zyx': a_b.tolist(),
             'bone_b_axis_point_zyx': ax[ib][0].tolist(), 'bone_a_extent_from_joint_vox': ext[ia],
             'bone_b_extent_from_joint_vox': ext[ib], 'axis_angle_deg': ang, 'bend_deg': bend, 'skew_vox': skew,
             'joint_centre_zyx': joint.tolist(), 'plane_rule': plane_rule, 'ref_object_candidates': len(cand),
             'ref_object_centroid_zyx': None if pf is None else ref_c.tolist(),
             'ref_object_vox_est': None if pf is None else int(sizes[ref_id - 1]),
             'ref_object_frames': None if pf is None else [int(pf.min()), int(pf.max())],
             'ref_object_largest_frame': None if pf is None else int(np.bincount(pf).argmax()),
             'R_zyx': R, 'normal_zyx': nrm.tolist(), 'origin_zyx': origin, 'shape': shape,
             'keyframe': key, 'background_hu': float(np.median(sub[~closed]))}
    # The keyframe must cut both bones: count each bone's voxels in it (a bone is the side of the joint it lies on)
    g = np.moveaxis(fr.slice_points(frame, 0, key), -1, 0)
    idx = np.round((g - 0.5) / 2).astype(int)
    ok = np.all((idx >= 0) & (idx < np.array(lab.shape)[:, None, None]), axis=0)
    ok[ok] = np.isin(lab[tuple(idx[:, ok])], np.array(ids) + 1)
    side = ((g[:, ok].T - joint) @ (a_a - a_b)) > 0
    cut = [int(side.sum()), int((~side).sum())]
    frame['keyframe_bone_vox'] = {'bone_a': cut[0], 'bone_b': cut[1]}
    if min(cut) < MIN_CUT_FRAC * max(cut):
        sidecar.fail(f'The keyframe cuts one bone and barely the other (bone voxels in it: A {cut[0]}, B {cut[1]}), so '
                     'the frame is wrong. Scan more of the leg or adjust --threshold-hu; a field that holds only the ends '
                     'of the bones, or a second bone cut by the edge of the field, gives this')
    return frame


if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--in', type=sidecar.existing, dest='src', required=True, help='hu.npy of the scan')
    ap.add_argument('--header', type=sidecar.existing, required=True, help='hu.json from scan-intake')
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--threshold-hu', type=float, required=True, help='bone threshold in HU (the workflow\'s anatomy reference gives it)')
    ap.add_argument('--shaft-radius-mm', type=float, required=True, help='mm: the widest a shaft gets')
    ap.add_argument('--ref-radius-mm', type=float, required=True, help='mm: how near the joint the reference object sits')
    ap.add_argument('--min-object-mm3', type=float, required=True, help='mm3: the smallest 3D piece worth considering')
    ap.add_argument('--second-bone-frac', type=float, default=0.25, help='smallest second bone piece, as a fraction '
                    'of the largest; smaller pieces are reference object candidates')
    ap.add_argument('--margin-mm', type=float, default=0.126, help='mm of margin around the bones in the oriented stack')
    ap.add_argument('--window', type=render_slices.vl.window_arg, metavar='lo,hi', help='display window in HU for the keyframe sheet (default: automatic)')
    a = ap.parse_args()
    g = sidecar.grid(a.header)
    sp = g['spacing_zyx_mm']
    if not np.allclose(sp, sp[0], rtol=1e-3):
        sidecar.fail(f'Voxels are not isotropic ({sp} mm): resample the volume before orienting')
    hu = np.load(a.src, mmap_mode='r')
    params = {'threshold_hu': a.threshold_hu, 'shaft_radius_mm': a.shaft_radius_mm, 'ref_radius_mm': a.ref_radius_mm,
                  'min_object_mm3': a.min_object_mm3, 'margin_mm': a.margin_mm,
                  'second_bone_frac': a.second_bone_frac}
    frame = fr.make(g['grid_id'], sp, parent_affine_xyz=g['affine_xyz_to_world_mm'], **joint_frame(hu, sp[0], **params))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stack = fr.resample(hu, frame, cval=frame['background_hu'])
    np.save(out / 'oriented.npy', stack)
    fr.save(frame, out / 'frame.json')
    sidecar.write(out / 'oriented.npy', grid_id=frame['grid_id'], spacing_zyx_mm=sp, inputs=[a.src, a.header],
                  params=params)
    k = frame['keyframe']
    render_slices.render(stack[k], out / 'keyframe.jpg', a.window,
                         title=f'keyframe {k} of {len(stack)}')
    sidecar.emit(frame=str(out / 'frame.json'), oriented=str(out / 'oriented.npy'), keyframe_image=str(out / 'keyframe.jpg'),
                 keyframe=k, slices=len(stack), bend_deg=None if frame['bend_deg'] is None else round(frame['bend_deg'], 1),
                 skew_vox=None if frame['skew_vox'] is None else round(frame['skew_vox'], 1), shafts_found=frame['shafts_found'],
                 keyframe_bone_vox=frame['keyframe_bone_vox'],
                 threshold_hu=round(frame['threshold_hu'], 1), plane_rule=frame['plane_rule'],
                 ref_object_frames=frame['ref_object_frames'], oriented_shape=list(stack.shape))
