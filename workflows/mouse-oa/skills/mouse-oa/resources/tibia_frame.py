"""Make a shaft-aligned frame and a cropped HU stack and mask for one long bone (the tibia for IIOC).

Puts the shaft's long axis on W, 0 degrees off in both the coronal (W-U) and the sagittal (W-V) plane, takes the epiphyseal
long cross-axis as U (+U medial and +V anterior come from a sign rule on scan y and `--joint-end` that assumes one knee and one
scan orientation: confirm it on the QC montage before naming a side), and resamples the HU volume and the bone mask onto that
frame, cropped around the joint end. The growth plate is not levelled: its roll stays as the anatomy has it. The axis is fitted
on the shaft between `--axis-mm` from the joint end: a first guess from scan-z slices (`--shaft-frac`), then, up to five
times, the scan's mask is sampled on the provisional grid's W sections over that range (sampled from the scan, so the range
does not depend on how far the output crop reaches), each section is filled and its largest piece kept (so the fibula and
specks do not pull it), lines u(w), v(w) are fitted through the centroids, and W is turned onto them until both are under
0.1 degrees. If five turns do not get there, the record says `converged: false` and the last turn stands: look at both QC
sheets, and if the centroids sit on the flare or the fibula, rerun with an `--axis-mm` range on the shaft. `--tilt-deg` then
turns W further, to cancel a lean seen on the QC. Everything the protocol annotates (growth-plate curves,
heights, plate patches) is indexed on this aligned grid: array axes (W, V, U), W running from the joint end toward the shaft.
The frame.json (schema and maps in `microct-core/resources/frame.py`) maps aligned indices back to the scan grid, which
`iioc.py` uses to measure on the scan. This script only fits the axes and the crop; it stays here, not in `orient-joint`,
because its sign rule (+U medial, +V anterior) and its crop defaults are the mouse tibia protocol's. Refused: anisotropic
voxels, HU and labels of different shapes, an empty label, no bone in the epiphysis range, fewer than ten sections with bone
in the `--axis-mm` range, a `--joint-end` on the side away from the femur, and a `--label` whose joint end has the femur's
notch where `--femur-label`'s is solid (the two labels swapped): the joint-end caps' solidities, in the result record, tell the two bones apart.

Writes: <out>/<name>-hu.npy  float32 HU on the aligned grid (linear interpolation, -1000 outside the scan), with its sidecar
        <out>/<name>-mask.npy  bool bone mask on the aligned grid (nearest), with its sidecar
        <out>/<name>-frame.json  the frame, mapping aligned indices back to the scan grid
        <out>/<name>-frame-qc.jpg  six coronal (W-U) sections with the mask outlined and W (magenta, vertical); on the two
            sections nearest the axis, the fitted axis (yellow, over the `--axis-mm` range) and every 10th section's centroid (dots)
        <out>/<name>-frame-qc-sagittal.jpg  the same for six sagittal (W-V) sections
        <out>/<name>.json  the result record: `objects` holds the aligned grid as `tibia-grid` (a volume on the frame's affine)
Prints: one JSON line {out, values, objects, hu, mask, frame, qc, qc_sagittal, grid_id, shape_wvu, mask_volume_mm3,
        axis_residual_deg {coronal, sagittal}, axis_mm, axis_w, tilt_deg, iterations, converged, shaft_z, epiphysis_z, tibia_check, ...}
        axis_residual_deg: the axis's angle to W on the final grid, at full resolution; positive coronal = the shaft's lower
        end (toward +W) at larger U than its top, positive sagittal the same with V. axis_w: the --axis-mm range as W indices
        of the output grid; its end may lie past the grid's last W index (the fit samples the scan, not the crop).
Example: python tibia_frame.py --window scan-settings.json --hu hu.npy --hu-json hu.json --labels labels.npy --label 2 --out tibia/ --joint-end low
Exits 2 with one sentence on bad input, before writing anything.
"""

from pathlib import Path

import frame as fr
import numpy as np
import objects
import sidecar
import viewlib as vl
from envelope import close_and_fill
from scipy import ndimage as ndi

SUBSAMPLE = 2  # epiphysis points for the PCA are taken every 2nd voxel
CAP_MM = 0.63  # how far from its joint end a bone's cap reaches, for the femur/tibia check
CAP_GAP = 0.05  # cap solidities closer than this cannot tell the two bones apart
FIT_STEP = 2  # the axis refit samples the mask every 2nd aligned voxel; the reported residual is at full resolution
MAX_ITER = 5
CONVERGED_DEG = 0.1
MIN_SECTIONS = 10


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
    """Area over convex-hull area of the cap of mask `m` within `cap_vox` slices of its low or high end, projected along z.
    The femur's cap holds the intercondylar notch, open toward the joint, so its footprint is U-shaped; the tibial plateau's is a solid blob. On ten lab scans the femur's cap gave 0.51 to 0.80 and the
    tibia's 0.83 to 0.95, the smallest gap 0.12."""
    from skimage.morphology import convex_hull_image

    zs = np.flatnonzero(m.any(axis=(1, 2)))
    z0, z1 = zs[0], zs[-1]
    lo, hi = (z0, z0 + cap_vox) if low_end else (max(z1 - cap_vox + 1, z0), z1 + 1)
    foot = m[lo:hi].any(axis=0)
    return float(foot.sum() / max(convex_hull_image(foot).sum(), 1))


def extent(m):
    """`m`'s scan z range, as text."""
    zs = np.flatnonzero(m.any(axis=(1, 2)))
    return f'{zs[0]} to {zs[-1]}'


def inside(m):
    """A voxel of `m` (scan z,y,x text) near its centroid, for relabel.py --at."""
    p = np.argwhere(m[::4, ::4, ::4]) * 4
    return ','.join(str(int(i)) for i in p[np.argmin(((p - p.mean(axis=0)) ** 2).sum(axis=1))])


def check_bone(labels, mask, label, other, joint_end, vox):
    """Refuse a `label` that is not the tibia across the joint from `other` (the femur), then a --joint-end on the wrong
    side. Returns the diagnostics for the result record."""
    if label == other:
        sidecar.fail(f'--label and --femur-label are both {label}: pass the tibia\'s label as --label (2 in outputs.yaml)')
    oth = labels == other
    if not oth.any():
        return {'tibia_check': f'not made: label {other} (the femur) is empty, so nothing to compare against; check the QC'}
    mask, oth = largest_piece(mask), largest_piece(oth)
    zc, zo = (float(np.flatnonzero(m.any(axis=(1, 2))).mean()) for m in (mask, oth))
    facing_low = zo < zc  # the end of this bone that faces the femur
    cap = round(CAP_MM / vox)
    s, so = cap_solidity(mask, facing_low, cap), cap_solidity(oth, not facing_low, cap)
    if s < so - CAP_GAP:
        at, ato = (inside(m) for m in (mask, oth))
        sidecar.fail(f'label {label} has the notched joint end of a femur and label {other} the solid one of a tibia (cap '
                     f'solidity {s:.3f} against {so:.3f}). First suspect: the two labels are swapped (on a staging run the 3D sheet '
                     f'was read three times as right while they were swapped). Compare each label with the scan: label {label} '
                     f'spans scan z {extent(mask)}, label {other} z {extent(oth)}. If label {label} is the femur, swap them: '
                     f'relabel.py --at {at} --to 99, then --at {ato} --to {label}, then --at {at} --to {other} (segmentation-check; '
                     'each moves one connected piece, so check the fragments after), and report the corrected bone-labels. Only if '
                     f'label {label} really is the tibia, look for a femur piece merged into its joint end. Tell main either way, with '
                     'the 3D sheet, before any tibial step')
    if (joint_end == 'low') != facing_low:
        sidecar.fail(f'--joint-end {joint_end} is the end away from label {other}: the joint is at the {"low" if facing_low else "high"} '
                     f'end of scan z for label {label} on this scan, so pass --joint-end {"low" if facing_low else "high"}')
    verdict = 'tibia' if s > so + CAP_GAP else 'unclear: the caps are too alike to tell the bones apart; check the QC montage for the plateau'
    return {'tibia_check': verdict, 'cap_solidity': {'tibia_label': round(s, 3), 'femur_label': round(so, 3)}}


def zrange(frac, lo, hi, joint_end):
    """Scan z range for a fraction pair measured from the joint end of the bone's z extent [lo, hi]."""
    n = hi - lo
    a, b = frac
    if joint_end == 'high':
        return round(hi - b * n), round(hi - a * n)
    return round(lo + a * n), round(lo + b * n)


def fit_frame(mask, shaft_z, epi_z, joint_end, vox):
    centers = []
    for z in range(shaft_z[0], shaft_z[1], 10):
        yy, xx = np.where(close_and_fill(mask[z], vox))
        if len(yy) == 0:
            sidecar.fail(f'label has no voxels at slice {z}: widen --shaft-frac or check --label and --joint-end')
        centers.append([xx.mean(), yy.mean(), z])
    centers = np.array(centers)
    w = np.array([np.polyfit(centers[:, 2], centers[:, 0], 1)[0], np.polyfit(centers[:, 2], centers[:, 1], 1)[0], 1.0])
    w /= np.linalg.norm(w)
    if joint_end == 'high':
        w = -w  # +W points from the joint toward the shaft
    z, y, x = np.where(mask[epi_z[0] : epi_z[1] : SUBSAMPLE, ::SUBSAMPLE, ::SUBSAMPLE])
    p = np.column_stack([SUBSAMPLE * x, SUBSAMPLE * y, SUBSAMPLE * z + epi_z[0]])
    if len(p) == 0:
        sidecar.fail('no bone voxels in the epiphysis range: widen --epiphysis-frac')
    centered = p - p.mean(axis=0)
    projected = centered - np.outer(centered @ w, w)
    _, vecs = np.linalg.eigh(projected.T @ projected)
    u = vecs[:, -1]
    if u[1] < 0:
        u = -u
    v = np.cross(w, u)
    v /= np.linalg.norm(v)
    u = np.cross(v, w)
    return np.column_stack([u, v, w]), p.mean(axis=0)


def joint_part(mask, joint_end, depth_vox):
    """Scan xyz of the bone voxels within depth_vox slices of the joint end: what the crop must cover."""
    zs = np.flatnonzero(mask.any(axis=(1, 2)))
    lo, hi = (zs[-depth_vox:][0], zs[-1]) if joint_end == 'high' else (zs[0], zs[0] + depth_vox)
    z, y, x = np.nonzero(mask[lo : hi + 1])
    return np.column_stack([x, y, z + lo])


def crop_for(points, basis, origin, pad):
    """Lower corner and shape (xyz order, in aligned voxels) covering `points` (`joint_part`), and the joint end's W in the
    same unframed coordinates (the corner's W is it minus `pad`)."""
    local = (points - origin) @ basis
    low = np.floor(local.min(axis=0)).astype(int) - pad
    high = np.ceil(local.max(axis=0)).astype(int) + pad + 1
    return low, high - low, float(local[:, 2].min())


def tilted(basis, su, sv):
    """`basis` (columns U, V, W in scan xyz) with W turned onto W + su U + sv V; U keeps its side, re-orthogonalised."""
    u, v, w = basis.T
    w = w + su * u + sv * v
    w /= np.linalg.norm(w)
    u = u - (u @ w) * w
    u /= np.linalg.norm(u)
    return np.column_stack([u, np.cross(w, u), w])


def sections(slices, ws, vox, step=1):
    """Centroids (w, u, v) of the filled largest piece of each (V, U) section in `slices` (W indices `ws`), in aligned
    voxels of a grid sampled every `step`; slices with no bone are skipped. The largest piece, so the fibula and specks
    do not pull the axis. Also the (u0, u1, v0, v1) box the pieces span."""
    rows, box = [], [np.inf, -np.inf, np.inf, -np.inf]
    for w, sec in zip(ws, slices, strict=True):
        pieces, n = ndi.label(close_and_fill(sec, vox * step))
        if not n:
            continue
        vv, uu = np.nonzero(pieces == 1 + int(np.argmax(np.bincount(pieces.ravel())[1:])))
        rows.append((w, uu.mean() * step, vv.mean() * step))
        box = [min(box[0], uu.min() * step), max(box[1], uu.max() * step), min(box[2], vv.min() * step), max(box[3], vv.max() * step)]
    return np.array(rows).reshape(-1, 3), box


def axis_fit(cen):
    """Lines u(w), v(w) through the section centroids: (slope_u, slope_v) and the two polyfit coefficient pairs."""
    if len(cen) < MIN_SECTIONS:
        sidecar.fail(f'only {len(cen)} sections in the --axis-mm range hold bone (need {MIN_SECTIONS}): the bone ends before '
                     'the range does; give an --axis-mm range nearer the joint, on the shaft')
    pu, pv = np.polyfit(cen[:, 0], cen[:, 1], 1), np.polyfit(cen[:, 0], cen[:, 2], 1)
    return pu[0], pv[0], pu, pv


def scan_sections(mask, basis, origin, low, shape, w_range, vox, step):
    """`sections` of the scan mask sampled every `step` voxels on the aligned grid at corner `low`, over the grid's (U, V)
    extent and W indices `w_range`. Sampled from the scan, so `w_range` may run past the grid's W end."""
    corner = origin + basis @ low
    uu, vv = np.meshgrid(np.arange(0, shape[0], step), np.arange(0, shape[1], step))
    ws = range(w_range[0], w_range[1], step)
    slices = (ndi.map_coordinates(mask.view(np.uint8), np.moveaxis((corner + np.stack([uu, vv, np.full_like(uu, w)], -1) @ basis.T)[..., ::-1], -1, 0),
                                  order=0, mode='constant', cval=0).astype(bool) for w in ws)
    return sections(slices, ws, vox, step)


def degrees(slope):
    return round(float(np.degrees(np.arctan(slope))), 3)


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--hu', type=sidecar.existing, required=True, help='hu.npy of the scan (float32, Z,Y,X)')
    ap.add_argument('--hu-json', type=sidecar.existing, required=True, help='hu.json that scan-intake wrote: grid id and spacing')
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='labels.npy on the scan grid')
    ap.add_argument('--label', type=int, required=True, help='label id of the bone (tibia = 2)')
    ap.add_argument('--femur-label', type=int, default=1, help='label id of the femur across the joint (1): the script refuses a --label whose joint end looks like the femur\'s, and a --joint-end on the wrong side')
    ap.add_argument('--window', type=vl.window_arg, metavar='lo,hi', required=True, help="QC display window in HU, or the scan's scan-settings.json")
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--name', default='tibia', help='prefix of the output files')
    ap.add_argument(
        '--joint-end',
        choices=['low', 'high'],
        default='low',
        help='which end of scan z the knee joint is at (low = small slice index)',
    )
    ap.add_argument(
        '--shaft-frac',
        type=float,
        nargs=2,
        metavar=('FROM', 'TO'),
        default=[0.5, 0.95],
        help='shaft part of the bone, as fractions of its z extent from the joint end: only the first guess at the axis, which '
        'the fit on --axis-mm then turns',
    )
    ap.add_argument('--epiphysis-frac', type=float, nargs=2, metavar=('FROM', 'TO'), default=[0.0, 0.2], help='epiphysis part, same fractions')
    ap.add_argument('--shaft-z', type=int, nargs=2, metavar=('FIRST', 'LAST'), help='explicit shaft slice range in scan z for the first guess (overrides --shaft-frac)')
    ap.add_argument('--epiphysis-z', type=int, nargs=2, metavar=('FIRST', 'LAST'), help='explicit epiphysis slice range in scan z (overrides --epiphysis-frac)')
    ap.add_argument('--crop-lower-uvw', type=int, nargs=3, metavar=('U', 'V', 'W'), help='explicit crop corner in aligned voxels (needs --crop-shape-uvw); the axis is still fitted, and the fit samples the crop\'s U, V extent, so the same crop flags need not give the same grid_id')
    ap.add_argument('--crop-shape-uvw', type=int, nargs=3, metavar=('U', 'V', 'W'), help='explicit crop size in aligned voxels (needs --crop-lower-uvw)')
    ap.add_argument('--depth-mm', type=float, default=3.15, help='mm: how far from the joint end the crop reaches')
    ap.add_argument('--pad-mm', type=float, default=0.105, help='mm: margin around the bone in the crop')
    ap.add_argument('--axis-mm', type=float, nargs=2, metavar=('FROM', 'TO'), default=[2.0, 3.9],
                    help='mm along W from the joint end: the shaft sections whose centroids define the axis (below the metaphyseal flare); '
                    'sampled from the scan, so the range may reach past the crop (axis_w then ends past the grid\'s last W index)')
    ap.add_argument('--tilt-deg', type=float, nargs=2, metavar=('CORONAL', 'SAGITTAL'), default=[0.0, 0.0],
                    help='degrees, turned after the fit to cancel a lean you see on the QC: positive CORONAL when the shaft\'s lower end '
                    'sits at larger U than its top on the coronal sheet, positive SAGITTAL the same with V on the sagittal sheet; the '
                    'reported residual then reads about minus the tilt')
    a = ap.parse_args()
    if bool(a.crop_lower_uvw) != bool(a.crop_shape_uvw):
        sidecar.fail('--crop-lower-uvw and --crop-shape-uvw go together: give both or neither')
    if not 0 <= a.axis_mm[0] < a.axis_mm[1]:
        sidecar.fail(f'--axis-mm {a.axis_mm[0]} {a.axis_mm[1]} is not a range from the joint end: give FROM < TO, both >= 0')
    g = sidecar.grid(a.hu_json)
    sp = g['spacing_zyx_mm']
    if not np.allclose(sp, sp[0], rtol=1e-3):
        sidecar.fail(f'spacing {sp} is not isotropic: the protocol needs isotropic voxels; resample first')
    hu = np.load(a.hu)
    labels = np.load(a.labels, mmap_mode='r')
    if hu.shape != labels.shape:
        sidecar.fail(
            f'hu {hu.shape} and labels {labels.shape} are on different grids: pass the labels made on this scan'
        )
    labels = np.asarray(labels)
    mask = labels == a.label
    if not mask.any():
        sidecar.fail(f'label {a.label} is empty in {a.labels}')
    check = check_bone(labels, mask, a.label, a.femur_label, a.joint_end, sp[0])
    zs = np.flatnonzero(mask.any(axis=(1, 2)))
    shaft_z = a.shaft_z or zrange(a.shaft_frac, zs[0], zs[-1], a.joint_end)
    epi_z = a.epiphysis_z or zrange(a.epiphysis_frac, zs[0], zs[-1], a.joint_end)
    basis, origin = fit_frame(mask, shaft_z, epi_z, a.joint_end, sp[0])
    joint = joint_part(mask, a.joint_end, round(a.depth_mm / sp[0]))

    def crop(basis):
        low, shape_xyz, w_joint = crop_for(joint, basis, origin, round(a.pad_mm / sp[0]))
        if a.crop_lower_uvw:
            low, shape_xyz = np.array(a.crop_lower_uvw), np.array(a.crop_shape_uvw)
        w0 = float(w_joint - low[2])  # the joint end's W index in the crop
        return low, shape_xyz, (round(w0 + a.axis_mm[0] / sp[0]), round(w0 + a.axis_mm[1] / sp[0]))

    converged = False
    for iterations in range(1, MAX_ITER + 1):
        low, shape_xyz, w_range = crop(basis)
        su, sv, _, _ = axis_fit(scan_sections(mask, basis, origin, low, shape_xyz, w_range, sp[0], FIT_STEP)[0])
        if max(abs(degrees(su)), abs(degrees(sv))) < CONVERGED_DEG:
            converged = True
            break
        basis = tilted(basis, su, sv)
    if any(a.tilt_deg):
        basis = tilted(basis, *np.tan(np.radians(a.tilt_deg)))
    low, shape_xyz, w_range = crop(basis)
    shape_zyx = tuple(int(i) for i in shape_xyz[::-1])
    frame = fr.make(
        g['grid_id'],
        sp,
        parent_affine_xyz=g['affine_xyz_to_world_mm'],
        R_zyx=basis[::-1, ::-1].T,  # frame axis i (W, V, U) as a scan (z, y, x) vector: the basis columns, reversed
        origin_zyx=(origin + basis @ low)[::-1],
        shape=shape_zyx,
        axes='aligned array axes (W, V, U): +U roughly medial, +V anterior, +W from the joint toward the shaft; '
        'check on the QC montage before annotating',
    )
    aligned = fr.resample(hu, frame, order=1, cval=-1000)
    amask = fr.resample(mask.astype(np.uint8), frame, order=0, cval=0, dtype=np.uint8).astype(bool)
    cen, (u0, u1, v0, v1) = scan_sections(mask, basis, origin, low, shape_xyz, w_range, sp[0], 1)
    su, sv, pu, pv = axis_fit(cen)
    residual = {'coronal': degrees(su), 'sagittal': degrees(sv)}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    params = {
        'label': a.label,
        'joint_end': a.joint_end,
        'shaft_z': list(shaft_z),
        'epiphysis_z': list(epi_z),
        'depth_mm': a.depth_mm,
        'pad_mm': a.pad_mm,
        'crop_lower_uvw': low.tolist(),
        'crop_shape_uvw': shape_xyz.tolist(),
        'axis_mm': a.axis_mm,
        'tilt_deg': a.tilt_deg,
    }
    for name, arr in ((f'{a.name}-hu.npy', aligned), (f'{a.name}-mask.npy', amask)):
        np.save(out / name, arr)
        sidecar.write(
            out / name,
            like=frame,
            inputs=[a.hu, a.labels],
            params=params,
            script='tibia_frame.py',
        )
    fr.save(frame, out / f'{a.name}-frame.json')
    qcs = {}
    ws = np.array([max(w_range[0], 0), min(w_range[1], shape_zyx[0]) - 1])  # the axis range, drawn where the grid has it
    on_grid = cen[(cen[:, 0] >= ws[0]) & (cen[:, 0] <= ws[1])][::10]  # every 10th section, so each dot reads on its own
    mid = np.mean(w_range)
    for axis, plane, lo, hi, p, k, letter, across in ((1, 'coronal', v0, v1, pu, 1, 'V', pv), (2, 'sagittal', u0, u1, pv, 2, 'U', pu)):
        idx = [int(i) for i in np.linspace(lo + 0.1 * (hi - lo), hi - 0.1 * (hi - lo), 6)]  # across the shaft in the axis range
        # the axis is drawn only on the two sections nearest it: one further off cuts the shaft obliquely, so its middle lies elsewhere
        central = set(sorted(idx, key=lambda i: abs(i - np.polyval(across, mid)))[:2])
        top = np.polyval(p, w_range[0])
        w_line = ([top, top], [0, shape_zyx[0] - 1], 'magenta', '--')
        curves = [[(np.polyval(p, ws), ws, 'yellow'), w_line, (on_grid[:, k], on_grid[:, 0], 'yellow', '.')] if i in central else [w_line] for i in idx]
        qcs[plane] = vl.slice_sheet(
            out / f'{a.name}-frame-qc{"" if plane == "coronal" else "-sagittal"}.jpg', aligned, [(amask, 'cyan')], axis, idx, a.window,
            curves=curves, axis_names=('W index (joint at top)', 'V index', 'U index'), voxel_mm=sp[0],
            titles=[f'{plane} {letter}={i}: axis {residual[plane]:+.2f} deg off W (yellow, dots = centroids; magenta = W)' if i in central
                    else f'{plane} {letter}={i}: off the axis, no axis drawn (magenta = W)' for i in idx])
    sidecar.emit_values(
        out / f'{a.name}.json',
        {},
        objects={'tibia-grid': objects.volume(out / f'{a.name}-hu.npy', out / f'{a.name}-frame.json', kind='image', unit='HU')},
        hu=str(out / f'{a.name}-hu.npy'),
        mask=str(out / f'{a.name}-mask.npy'),
        frame=str(out / f'{a.name}-frame.json'),
        qc=qcs['coronal'],
        qc_sagittal=qcs['sagittal'],
        grid_id=frame['grid_id'],
        shape_wvu=list(shape_zyx),
        mask_volume_mm3=round(float(amask.sum()) * sp[0] ** 3, 4),
        axis_residual_deg=residual,
        axis_mm=a.axis_mm,
        axis_w=list(w_range),
        tilt_deg=a.tilt_deg,
        iterations=iterations,
        converged=converged,
        shaft_z=list(shaft_z),
        epiphysis_z=list(epi_z),
        **check,
    )


if __name__ == '__main__':
    main()
