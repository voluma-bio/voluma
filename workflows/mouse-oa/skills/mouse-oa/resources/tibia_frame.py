"""Make a shaft-aligned frame and a cropped HU stack and mask for one long bone (the tibia for IIOC).

Puts the shaft's long axis on W, 0 degrees off in both the coronal (W-U) and the sagittal (W-V) plane, takes the epiphyseal
long cross-axis as U, turned so that `--fibula-label` (lateral) lies at -U: +U medial and, the grid being right-handed,
+V anterior on a right knee (on a left knee +V is posterior; `anterior_side` checks V against `--patella-label`). Without a
fibula label, or with the fibula within 0.3 mm of the tibia's centre along U, the first guess's sign rule on scan y
stands and `medial_side` says `unknown`. The frame's `axes` note repeats both sides. It then resamples the HU volume and the bone mask onto that
frame, cropped around the joint end. The growth plate is not levelled: its roll stays as the anatomy has it. The axis is fitted
on the shaft between `--axis-mm` from the joint end: a first guess from scan-z slices (`--shaft-frac`), then, up to five
times, the scan's mask is sampled on the provisional grid's W sections over that range (sampled from the scan, so the range
does not depend on how far the output crop reaches), each section is filled and its largest piece kept (so the fibula and
specks do not pull it), lines u(w), v(w) are fitted through the centroids, and W is turned onto them until both are under
0.1 degrees. If five turns do not get there, the record says `converged: false` and the last turn stands (warned on below): look at both QC sheets, and if the centroids sit on the flare or the fibula, rerun with an `--axis-mm` range on the shaft. `--tilt-deg` then
turns W further, to cancel a lean seen on the QC. Everything the protocol annotates (growth-plate curves,
heights, plate patches) is indexed on this aligned grid: array axes (W, V, U), W running from the joint end toward the shaft.
The frame.json (schema and maps in `microct-core/resources/frame.py`) maps aligned indices back to the scan grid, which
`iioc.py` uses to measure on the scan. This script only fits the axes and the crop; it stays here, not in `orient-joint`,
because its sign rule and its crop defaults are the mouse tibia protocol's. Refused: anisotropic
voxels, HU and labels of different shapes, an empty tibia or femur label (the joint end is the tibia's end facing the
femur, so the femur must be labelled), no bone in the epiphysis range, and fewer than ten sections with
bone in the `--axis-mm` range. Warned, with the grid still written: a `--label` whose joint end has the femur's notch where
`--femur-label`'s is solid (the two labels look swapped; the joint-end caps' solidities are in the result record), and a final axis more than 0.5 degrees
off W in either plane (not checked with `--tilt-deg`).

Writes: <out>/<name>-hu.npy  float32 HU on the aligned grid (linear interpolation, -1000 outside the scan), with its sidecar
        <out>/<name>-mask.npy  bool bone mask on the aligned grid (nearest), with its sidecar
        <out>/<name>-frame.json  the frame, mapping aligned indices back to the scan grid
        <out>/<name>-frame-qc.jpg  six coronal (W-U) sections with the mask outlined and W (magenta, vertical); on the two
            sections nearest the axis, the fitted axis (yellow, over the `--axis-mm` range) and every 10th section's centroid (dots)
        <out>/<name>-frame-qc-sagittal.jpg  the same for six sagittal (W-V) sections
        <out>/<name>.json  the result record: `objects` holds the aligned grid as `tibia-grid` (a volume on the frame's affine)
Prints: one JSON line {out, values, objects, hu, mask, frame, qc, qc_sagittal, grid_id, shape_wvu, mask_volume_mm3,
        axis_residual_deg {coronal, sagittal}, axis_mm, axis_w, tilt_deg, iterations, converged, shaft_z, epiphysis_z, tibia_check,
        medial_side, fibula_u_mm, anterior_side, patella_v_mm, ...}
        medial_side: "+U" when the grid was turned to put the fibula at -U; "unknown" without a fibula label or with the
        fibula within 0.3 mm of the tibia's centre along U: then find the fibula on the QC yourself. anterior_side: "+V" or
        "-V" from where the patella lies along V (anterior), "unknown" without a patella label or with it within 0.3 mm. Both offsets are measured on the final grid.
        axis_residual_deg: the axis's angle to W on the final grid, at full resolution; positive coronal = the shaft's lower
        end (toward +W) at larger U than its top, positive sagittal the same with V. axis_w: the --axis-mm range as W indices
        of the output grid; its end may lie past the grid's last W index (the fit samples the scan, not the crop).
Example: python tibia_frame.py --window scan-settings.json --hu hu.npy --hu-json hu.json --labels labels.npy --label 2 --out tibia/
Exits 2 with one sentence on bad input, before writing anything.
"""

from pathlib import Path

import frame as fr
import joint_cap as jc
import numpy as np
import objects
import sidecar
import viewlib as vl
from envelope import close_and_fill
from scipy import ndimage as ndi

SUBSAMPLE = 2  # epiphysis points for the PCA are taken every 2nd voxel
FIT_STEP = 2  # the axis refit samples the mask every 2nd aligned voxel; the reported residual is at full resolution
MAX_ITER = 5
CONVERGED_DEG = 0.1
# The final axis this far off W, in either plane, is warned on. On threshold-split labels of 52 scans (OA6-8, KW, RZ),
# converged fits end within 0.15 degrees; 13 that did not converge ended 0.5 to 50 degrees off, most where little shaft
# is in the field (under 2 mm of tibia) or the centroids sit on the flare.
MAX_RESIDUAL_DEG = 0.5
MIN_SECTIONS = 10


def extent(m):
    """`m`'s scan z range, as text."""
    zs = np.flatnonzero(m.any(axis=(1, 2)))
    return f'{zs[0]} to {zs[-1]}'


def check_bone(labels, mask, label, other, vox):
    """Check that `label` is the tibia across the joint from `other` (the femur). Returns the joint end (the end of scan z
    that faces the femur) and the diagnostics for the record."""
    if label == other:
        sidecar.fail(f'--label and --femur-label are both {label}: pass the tibia\'s label as --label (2 in outputs.yaml)')
    oth = labels == other
    if not oth.any():
        sidecar.fail(f'label {other} (--femur-label, the femur) is empty: the joint end is found from where the femur lies, '
                     'so pass the femur\'s label')
    mask, oth = jc.largest_piece(mask), jc.largest_piece(oth)
    s, so, facing_low = jc.caps(mask, oth, vox)  # facing_low: the end of this bone that faces the femur
    if s < so - jc.CAP_GAP:
        verdict = 'femur: the labels look swapped'
        sidecar.warn(f'label {label} has the notched joint end of a femur and label {other} the solid one of a tibia (cap '
                     f'solidity {s:.3f} against {so:.3f}), so this grid may be built on the femur. First suspect: the two labels '
                     f'are swapped (a staging run read its 3D sheet three times as right while they were swapped). Compare each '
                     f'label with the scan: label {label} spans scan z {extent(mask)}, label {other} z {extent(oth)}. If label '
                     f'{label} is the femur, swap them with segmentation-check\'s relabel.py --swap {label},{other}, report the '
                     f'corrected bone-labels and run this again. If label {label} really is the tibia, look for a femur piece '
                     'merged into its joint end; if there is none, keep this grid and raise a To check item naming both caps')
    elif s > so + jc.CAP_GAP:
        verdict = 'tibia'
    else:
        verdict = 'unclear: the caps are too alike to tell the bones apart; check the QC montage for the plateau'
    found = 'low' if facing_low else 'high'
    return found, {'tibia_check': verdict, 'cap_solidity': {'tibia_label': round(s, 3), 'femur_label': round(so, 3)}}


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
            sidecar.fail(f'label has no voxels at slice {z}: widen --shaft-frac or check --label')
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


SIDE_MIN_MM = 0.3  # a side marker's centroid this far off the tibia's centre, or the side is not called


def offset_mm(labels, label, axis, origin, vox):
    """How far label `label`'s centroid lies along `axis` (scan xyz unit vector) from `origin`, in mm; None if absent."""
    if not label:
        return None
    pts = np.argwhere(labels[::4, ::4, ::4] == label) * 4
    return round(float((pts[:, ::-1].mean(axis=0) - origin) @ axis) * vox, 3) if len(pts) else None


def side(off, axis):
    """'+axis' when the marker at `off` mm says the positive direction is the named side, '-axis' the other, 'unknown' if unclear."""
    return 'unknown' if off is None or abs(off) < SIDE_MIN_MM else (f'+{axis}' if off > 0 else f'-{axis}')


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
    ap.add_argument('--femur-label', type=int, default=1, help='label id of the femur across the joint (1): the joint end is the tibia\'s end facing it, and the script warns on a --label whose joint end looks like the femur\'s')
    ap.add_argument('--fibula-label', type=int, default=4, help='label id of the fibula (4), which is lateral: the grid is turned to put it at -U (0: none)')
    ap.add_argument('--patella-label', type=int, default=3, help='label id of the patella (3), which is anterior: reported as anterior_side, a check on +V (0: none)')
    ap.add_argument('--window', type=vl.window_arg, metavar='lo,hi', required=True, help="QC display window in HU, or the scan's scan-settings.json")
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--name', default='tibia', help='prefix of the output files')
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
    a.joint_end, check = check_bone(labels, mask, a.label, a.femur_label, sp[0])
    zs = np.flatnonzero(mask.any(axis=(1, 2)))
    shaft_z = a.shaft_z or zrange(a.shaft_frac, zs[0], zs[-1], a.joint_end)
    epi_z = a.epiphysis_z or zrange(a.epiphysis_frac, zs[0], zs[-1], a.joint_end)
    basis, origin = fit_frame(mask, shaft_z, epi_z, a.joint_end, sp[0])
    fibula_u_mm = offset_mm(labels, a.fibula_label, basis[:, 0], origin, sp[0])
    if fibula_u_mm is not None and fibula_u_mm >= SIDE_MIN_MM:
        basis[:, :2] *= -1  # half a turn about W: the fibula (lateral) to -U, still right-handed
        fibula_u_mm = -fibula_u_mm
    medial = side(None if fibula_u_mm is None else -fibula_u_mm, 'U')
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
    fibula_u_mm = offset_mm(labels, a.fibula_label, basis[:, 0], origin, sp[0])  # on the final grid, for the record
    patella_v_mm = offset_mm(labels, a.patella_label, basis[:, 1], origin, sp[0])
    anterior = side(patella_v_mm, 'V')
    sides = (f'{medial} medial (the fibula lies {fibula_u_mm:+.2f} mm along U)' if medial != 'unknown' else
             'medial side unknown (no fibula label, or the fibula is within 0.3 mm of the tibia\'s centre along U): find the fibula on the QC')
    sides += (f', {anterior} anterior (the patella lies {patella_v_mm:+.2f} mm along V)' if anterior != 'unknown' else
              ', anterior side unknown (no patella label, or the patella is within 0.3 mm of the tibia\'s centre along V)')
    frame = fr.make(
        g['grid_id'],
        sp,
        parent_affine_xyz=g['affine_xyz_to_world_mm'],
        R_zyx=basis[::-1, ::-1].T,  # frame axis i (W, V, U) as a scan (z, y, x) vector: the basis columns, reversed
        origin_zyx=(origin + basis @ low)[::-1],
        shape=shape_zyx,
        axes=f'aligned array axes (W, V, U): {sides}, +W from the joint toward the shaft; '
        'check on the QC montage before annotating',
    )
    aligned = fr.resample(hu, frame, order=1, cval=-1000)
    amask = fr.resample(mask.astype(np.uint8), frame, order=0, cval=0, dtype=np.uint8).astype(bool)
    cen, (u0, u1, v0, v1) = scan_sections(mask, basis, origin, low, shape_xyz, w_range, sp[0], 1)
    su, sv, pu, pv = axis_fit(cen)
    residual = {'coronal': degrees(su), 'sagittal': degrees(sv)}
    off = max(abs(residual['coronal']), abs(residual['sagittal']))
    if off > MAX_RESIDUAL_DEG and not any(a.tilt_deg):
        sidecar.warn(f'the shaft axis ends {residual["coronal"]:+.2f} degrees coronal and {residual["sagittal"]:+.2f} sagittal off W '
                     f'(the fit {"converged" if converged else f"did not converge in {MAX_ITER} turns"}), so the grid is not aligned '
                     'to the shaft. Look at both QC sheets: if the centroids sit on the metaphyseal flare or the fibula, or the '
                     f'tibia runs out before {a.axis_mm[1]} mm, rerun with an --axis-mm range on the shaft that is in the field. If '
                     'no range fits, keep this grid and raise a To check item quoting this')
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
        medial_side=medial,
        fibula_u_mm=fibula_u_mm,
        anterior_side=anterior,
        patella_v_mm=patella_v_mm,
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
