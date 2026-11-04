"""Measure the distal femur from four landmarks (DFL, DFW, W/L), check them and build the landmark frame.

Landmarks (points files on the scan grid, as `pick.py` writes them, one per view or all four in one; each name once; zyx voxel indices, floats allowed;
see ../references/oa-protocol.md for how to place them). The spec (--spec, protocol.json) says which pair each distance joins (a-b and c-d) and gives the definitions and ruler ids:
  a  midpoint of the upper line of the intercondylar groove      c  midpoint of the ridge on the lateral condyle
  b  intercondylar notch                                         d  vertex of the medial condyle
DFL = |a - b|, DFW = |c - d|, W/L = DFW / DFL (deck #26-28), all straight 3D distances through physical spacing, computed by
`measure.py`'s code from the spec's entries. The script finds the femur's mediolateral (ML) axis from the label (the long
axis of the condyles' cross-section, perpendicular to the shaft) and compares it with the normal of the plane the femur
and tibia shafts bend in (`normal_zyx` in the `frame` output's frame.json, from orient_joint.py): when the two agree, the
axis is confirmed. It builds a frame (that ML, and SI from b to a made perpendicular to it) and checks the points against
the femur. A failed check on the points stops the script (exit 2, nothing written): re-place the points, do not explain
the check away. The checks: each landmark within 0.05 mm of femur bone; DFL at least 0.4 of DFW (an end-on view of the
joint face puts a and b across the notch and DFL comes out a third of its size); a-b in the sagittal plane (|cos| to ML at
most 0.5) and c-d across the condyles (|cos| to ML at least 0.7), so points placed with the sides and the front swapped
are refused on any knee, left or right; and SI (b to a) pointing toward the shaft. Also refused: a missing landmark,
coincident landmarks, a points file or frame on another grid.
A ruler that fails against the label's ML axis is refused one of three ways. A ruler fails against the bending-plane
normal and the two axes agree: re-place the points, with no way out (a render that seems to disagree has its image axes
mislabelled). Both rulers fit the normal: the label's axis may be wrong, so leave the points and raise a To check item. Otherwise
(the axes disagree, or the frame has no bending plane: a knee bent under 20 degrees or a shaft out of the field):
re-place the points, unless a render of the scan, its image axes named as scan axes, shows the condyles along another
direction; then leave them and raise a To check item. A femur label shorter than 4.5 mm along its shaft, whose axes
cannot be read (the labels or the field of view cut it off), is also raised as a To check item, not answered by moving
the points.

Writes: <out>/femoral.json  the result record of `microct-core/resources/sidecar.py` (ids distal-femoral-length-dfl,
        distal-femoral-width-dfw, width-length-ratio; mm, mm, 1), plus landmarks_zyx, frame (ml and si vectors, zyx), checks
        and frame_file; `objects` holds dfl-ruler (a to b) and dfw-ruler (c to d), lines on the scan grid
        <out>/femur-frame.json  the femur's frame (schema in `microct-core/resources/frame.py`), the `femur-frame` output:
        array axes (W, V, U) as in `tibia_frame.py`, W the label's shaft axis (toward the hip), U = ML, V = W x U, on a box
        covering the femur label. Only an orientation: no volume is resampled onto it
Prints: one JSON line {out, frame_file, values: {id: {value, unit, definition, kind}}, objects}
Example: python femoral_frame.py --spec protocol.json --landmarks points-ab.json points-cd.json --hu-json hu.json --labels labels.npy --frame orient/frame.json --out femoral/
Exits 2 with one sentence on bad input, before writing anything.
"""

from pathlib import Path

import frame as fr
import measure
import numpy as np
import sidecar
from scipy import ndimage as ndi

NAMES = ('a', 'b', 'c', 'd')
FRAME_PAD_MM = 0.1  # margin around the femur label in femur-frame.json's box
DFL_ID, DFW_ID, RATIO_ID = 'distal-femoral-length-dfl', 'distal-femoral-width-dfw', 'width-length-ratio'
MAX_OFF_BONE_MM = 0.05  # a landmark further than this from femur bone fails the check
MIN_LENGTH_OVER_WIDTH = 0.4  # DFL / DFW below this fails. One scan (n=1): OA6-1RK reference 0.71, the end-on pick that was wrong 0.27
EPIPHYSIS_MM = 1.5  # the distal end of the femur whose widest cross-axis is taken as mediolateral
# |cos| of a ruler's angle to the femur's mediolateral axis. a-b lies in the sagittal plane (0 ideally), c-d runs side to
# side (1 ideally). OA6-2RK run f45f630f, axes swapped: a-b 0.81, c-d 0.40; correct placements on OA6-1RK and OA6-2RK 0.02
# to 0.05 and 0.99.
MAX_LENGTH_ML = 0.5
MIN_WIDTH_ML = 0.7
# |cos| between the label's ML axis and the bending-plane normal at or above which the axis counts as confirmed (about 32
# degrees). On threshold-split labels of ten lab scans with a bending plane in the frame: OA7-1L 0.996, OA6-1RK 0.98, OA6-2RK
# 0.95, OA6-9RK 0.90, OA6-17LK9 0.86 confirm; OA7-3R 0.76, OA8-17L 0.58, OA8-19L 0.53 do not (OA6-14LK3 and OA7-4R had no
# bending plane). A ruler is refused with no way out only when it fails against both reads and they agree, so correct points
# within the checks' limits of either read are never sent back.
MIN_ML_AGREE = 0.85
BENDING_PLANE = 'span of the two shaft axes'  # orient_joint.py's plane_rule when the normal is the bending-plane normal
# The normal's error is about the shaft axes' error over sin(bend), so a knee bent less than this has no usable normal. Lab
# scans above: 25 to 68 degrees.
MIN_BEND_DEG = 20.0
MOSTLY = 0.85  # a direction with a component at least this large runs "mostly" along that scan axis
# The femur label must run at least this far along its shaft for its axes to be read. Whole labels: OA6-1RK 5.31 mm,
# OA6-2RK 5.86. Cut to the distal few mm (review of #488), the ML axis swings by up to 42 degrees below 4.5 mm of label and by
# under 3 degrees above it.
MIN_FEMUR_MM = 4.5


def unit(v):
    n = np.linalg.norm(v)
    if n == 0:
        sidecar.fail('two landmarks coincide: re-place them')
    return v / n


def direction(v):
    """A direction for a refusal: the unit vector in scan (z, y, x) and the scan axis it runs mostly along, or the two it
    runs between."""
    u = unit(np.asarray(v, float))
    first, second = np.argsort(np.abs(u))[::-1][:2]
    along = f"mostly scan {'zyx'[first]}" if abs(u[first]) >= MOSTLY else f"between scan {'zyx'[first]} and {'zyx'[second]}"
    return f'{np.round(u, 2).tolist()} (scan z, y, x), {along}'


def main_axis(p):
    q = p - p.mean(axis=0)
    return np.linalg.eigh(q.T @ q)[1][:, -1]


def femur_axes(femur, sp, distal_mm):
    """The femur's shaft axis (toward the hip), its mediolateral axis (sign arbitrary), zyx unit vectors in mm space, and
    how far the label runs along the shaft (mm). `distal_mm` is a point near the knee end (the landmarks' centroid). The
    shaft, the length and the distal end come from the label's largest connected piece, so a stray fragment past the end
    does not move them. The mediolateral axis is the long axis of the cross-section of every femur voxel in the
    EPIPHYSIS_MM above that end: the condyles are wider side to side than front to back (standard deviation 0.875
    against 0.702 mm on OA6-1RK, 0.900 against 0.648 on OA6-2RK). On a short stub of femur the long axis is the condyles' width, not the shaft, and both axes are
    wrong: the caller refuses a label shorter than MIN_FEMUR_MM along the shaft."""
    pieces, _ = ndi.label(femur[::2, ::2, ::2])  # the caller has checked there is femur bone at the landmarks
    idx = np.argwhere(pieces)
    main = pieces[tuple(idx.T)] == np.argmax(np.bincount(pieces.ravel())[1:]) + 1
    p = idx * 2 * sp
    body = p[main]
    long = main_axis(body)
    if (distal_mm - body.mean(axis=0)) @ long > 0:
        long = -long
    t = (body - body.mean(axis=0)) @ long
    shaft = main_axis(body[t > np.median(t)])  # the proximal half, so the condyles do not pull it
    shaft = shaft if shaft @ long > 0 else -shaft
    s = p @ shaft
    end = s[main].min()
    # every piece inside the window counts: a condyle the label breaks into fragments is still part of the width
    q = p[(s >= end) & (s < end + EPIPHYSIS_MM)]
    q = q - q.mean(axis=0)
    q = q - np.outer(q @ shaft, shaft)
    return shaft, np.linalg.eigh(q.T @ q)[1][:, -1], float(s[main].max() - end)


def off_bone_mm(point, femur, vox):
    """Distance in mm to femur bone in a box covering MAX_OFF_BONE_MM, or None if the box has no bone."""
    c = np.round(point).astype(int)
    radius = int(np.ceil(MAX_OFF_BONE_MM / vox))
    lo = np.maximum(c - radius, 0)
    box = femur[tuple(slice(lo_, c_ + radius + 1) for lo_, c_ in zip(lo, c, strict=True))]
    if not box.any():
        return None
    dt = ndi.distance_transform_edt(~box)
    return float(dt[tuple(np.clip(c - lo, 0, np.array(box.shape) - 1))]) * vox


def make_femur_frame(grid, femur, shaft, ml):
    """The femur's frame on the scan grid: array axes (W, V, U) with W = `shaft`, U = `ml` (`femur_axes`' zyx unit vectors,
    perpendicular by construction), V = W x U, built in xyz and reversed as `tibia_frame.py` does so the basis is
    right-handed, on a box covering the femur label's voxels (every 2nd) plus FRAME_PAD_MM. W is the shaft, not SI: b toward
    a also runs from the back of the condyles to the front (44 degrees off the shaft on OA6-2RK), and the tibia grid's W is
    its shaft too."""
    w, u = shaft[::-1], ml[::-1]
    basis = np.column_stack([u, np.cross(w, u), w])  # columns U, V, W in scan xyz
    R = basis[::-1, ::-1].T  # frame axis i (W, V, U) as a scan (z, y, x) vector
    sp = np.array(grid['spacing_zyx_mm'], float)
    local = np.argwhere(femur[::2, ::2, ::2]) * 2 @ R.T  # frame coordinates of the voxels, origin at scan voxel 0
    pad = round(FRAME_PAD_MM / sp[0])
    low = np.floor(local.min(axis=0)) - pad
    shape = np.ceil(local.max(axis=0)) + pad + 1 - low
    return fr.make(
        grid['grid_id'], sp, parent_affine_xyz=grid['affine_xyz_to_world_mm'], R_zyx=R, origin_zyx=low @ R, shape=shape,
        axes="orientation only, no volume is resampled onto it: array axes (W, V, U), +W along the femur's shaft from the "
        "joint toward the hip, U the condyles' mediolateral axis (sign arbitrary: not named medial or lateral), V = W x U; "
        'the box covers the femur label',
    )


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--spec', type=sidecar.existing, required=True, help="the workflow's protocol.json: the points each distance joins, their definitions and ruler ids")
    ap.add_argument('--landmarks', type=sidecar.existing, required=True, nargs='+', help='points files on the scan grid that together hold points named a, b, c, d (the points.json files pick.py writes)')
    ap.add_argument('--hu-json', type=sidecar.existing, required=True, help='hu.json: spacing and grid')
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='labels.npy on the scan grid: the landmarks are checked against the femur')
    ap.add_argument('--label', type=int, default=1, help='femur label id')
    ap.add_argument('--frame', type=sidecar.existing, required=True, help="frame.json of the `frame` output (orient_joint.py): its bending-plane normal confirms the femur's mediolateral axis")
    a = ap.parse_args()
    grid = sidecar.grid(a.hu_json)
    lm = sidecar.load_points(a.landmarks, grid['grid_id'])
    knee = fr.load(a.frame)
    if knee['parent_grid_id'] != grid['grid_id'] or 'normal_zyx' not in knee:
        sidecar.fail(f'{a.frame} is not the frame orient_joint.py cut from this scan: pass the `frame` output\'s frame.json')
    if any(n not in lm for n in NAMES):
        sidecar.fail(f'place a, b (length) and c, d (width); the points files hold {sorted(lm)}')
    if list(lm['a']) == list(lm['b']) or list(lm['c']) == list(lm['d']):
        sidecar.fail('two landmarks coincide (a on b or c on d): re-place them')
    values, _, placed = measure.measure(a.spec, [DFL_ID, DFW_ID, RATIO_ID], a.hu_json, points=lm)
    names = NAMES
    sp = np.array(grid['spacing_zyx_mm'], float)
    p = {i: np.array(lm[i], float) for i in names}
    dfl, dfw = values[DFL_ID]['value'], values[DFW_ID]['value']
    pm = {i: p[i] * sp for i in names}  # mm, zyx
    checks = {}
    femur = np.asarray(np.load(a.labels, mmap_mode='r')) == a.label
    checks['off_bone_mm'] = {i: off_bone_mm(p[i], femur, sp[0]) for i in names}
    far = [i for i, d in checks['off_bone_mm'].items() if d is None or d > MAX_OFF_BONE_MM]
    if far:
        sidecar.fail(f'landmarks {far} are more than {MAX_OFF_BONE_MM} mm from femur bone: snap them '
                     'to the bone surface and look at the render again')
    checks['dfl_over_dfw'] = dfl / dfw
    if dfl < MIN_LENGTH_OVER_WIDTH * dfw:
        sidecar.fail(f'DFL {dfl:.3f} mm is under {MIN_LENGTH_OVER_WIDTH} of DFW {dfw:.3f} mm: a and b were probably placed on an '
                     'end-on view of the joint face, so a-b runs across the notch. Render a view along the shaft '
                     '(regions-and-landmarks) and re-place a and b on it')
    shaft, ml, checks['femur_length_mm'] = femur_axes(femur, sp, np.mean(list(pm.values()), axis=0))
    if checks['femur_length_mm'] < MIN_FEMUR_MM:
        sidecar.fail(f"the femur label runs only {checks['femur_length_mm']:.2f} mm along its shaft (at least {MIN_FEMUR_MM}): "
                     "too little shaft is labelled or in the field of view to find the femur's axes, so the labels or the scan "
                     'are the problem, not the points. Do not move the points: raise a To check item naming this')
    normal = unit(np.array(knee['normal_zyx'], float))  # voxel-index direction; frames need isotropic voxels, so mm agrees
    plane = checks['bending_plane'] = knee.get('plane_rule') == BENDING_PLANE and (knee.get('bend_deg') or 0) >= MIN_BEND_DEG
    agree = abs(ml @ normal)
    checks['ml_cos_to_bending_normal'] = agree if plane else None
    rulers = (
        ('a-b', 'a and b', f'at most {MAX_LENGTH_ML}', lambda c: c <= MAX_LENGTH_ML, 'side to side',
         'DFL runs from the front of the groove to the notch, in the sagittal plane'),
        ('c-d', 'c and d', f'at least {MIN_WIDTH_ML}', lambda c: c >= MIN_WIDTH_ML, 'not side to side',
         'DFW spans the two condyles'),
    )
    fit_ml, fit_normal = {}, {}
    for name, _, _, fits, _, _ in rulers:
        v = unit(pm[name[0]] - pm[name[2]])
        key = f'{name[0]}_{name[2]}'
        checks[f'{key}_cos_to_ml'] = abs(v @ ml)
        checks[f'{key}_cos_to_bending_normal'] = abs(v @ normal) if plane else None
        fit_ml[name] = fits(abs(v @ ml))
        fit_normal[name] = plane and fits(abs(v @ normal))
    failing = [r for r in rulers if not fit_ml[r[0]]]
    if failing:
        name, ends, limit, _, wrong, rule = failing[0]
        v = unit(pm[name[0]] - pm[name[2]])
        head = (f"{name} runs along {direction(v)}, {wrong} (|cos| {checks[f'{name[0]}_{name[2]}_cos_to_ml']:.2f} to the "
                f"mediolateral axis in the femur label, {limit}), but {rule}. The label's axis runs along {direction(ml)}")
        if all(fit_normal.values()):
            sidecar.fail(f"{head}. Both a-b and c-d fit the knee's bending plane, whose normal runs along {direction(normal)}; "
                         f"the two reads of the mediolateral axis {'agree only roughly' if agree >= MIN_ML_AGREE else 'differ'} "
                         f"(|cos| {agree:.2f}), so the label's axis may be wrong, not the points: leave them and raise a To "
                         'check item naming both axes.')
        if plane and agree >= MIN_ML_AGREE:
            misfit = [r[0] for r in rulers if not fit_normal[r[0]]]
            misfit = f"{' and '.join(misfit)} {'fails' if len(misfit) == 1 else 'fail'}"
            sidecar.fail(f'{head}, confirmed by the normal of the plane the femur and tibia shafts bend in (frame.json, |cos| '
                         f'{agree:.2f}), and {misfit} against that normal too. The condyles sit side by side along that '
                         'direction on this scan. A render that seems to show them along another direction has its image axes '
                         'mislabelled: name the scan axis along each image axis of that render before you place the points '
                         f'again. Which side is lateral and where the front is still come from a render of this scan. Re-place '
                         f'{ends}.')
        why = (f"its normal runs along {direction(normal)}, |cos| {agree:.2f} to the label's axis, at least {MIN_ML_AGREE}"
               if plane else
               f'frame.json has none: the knee bends less than {MIN_BEND_DEG:.0f} degrees or a shaft is out of the field')
        sidecar.fail(f'{head}; the bending plane does not confirm it ({why}). Re-place {ends}. If a render of this scan, with '
                     'each image axis named as a scan axis, shows the condyles side by side along another direction, leave '
                     'the points and raise a To check item naming the printed axis.')
    si_seed = pm['a'] - pm['b']
    si = unit(si_seed - (si_seed @ ml) * ml)
    frame = {
        'ml_vector_zyx': ml.tolist(),
        'si_vector_zyx': si.tolist(),
        'note': "ml: the femur label's condylar long axis, sign arbitrary; si: b toward a, made perpendicular to ml (toward "
        'the shaft)',
    }
    centroid = np.argwhere(femur[::4, ::4, ::4]).mean(axis=0) * 4 * sp
    if (centroid - (pm['c'] + pm['d']) / 2) @ si <= 0:
        sidecar.fail('SI (b toward a) points away from the femoral bulk: a is not the groove end nearer the shaft, or the '
                     'points are on the wrong view. Re-place a and b; do not explain this away')
    femur_frame = make_femur_frame(grid, femur, shaft, ml)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    fr.save(femur_frame, out / 'femur-frame.json')
    sidecar.emit_values(
        out / 'femoral.json',
        values,
        meta={'landmarks_zyx': lm, 'frame': frame, 'checks': checks,
              'inputs': {a.spec: sidecar.sha256_file(a.spec), a.frame: sidecar.sha256_file(a.frame)}},
        objects=placed,
        frame_file=str(out / 'femur-frame.json'),
    )


if __name__ == '__main__':
    main()
