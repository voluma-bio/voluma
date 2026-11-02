"""Measure the distal femur from four landmarks (DFL, DFW, W/L), check them and build the landmark frame.

Landmarks (points files on the scan grid, as `pick.py` writes them, one per view or all four in one; each name once; zyx voxel indices, floats allowed;
see ../references/oa-protocol.md for how to place them). The spec (--spec, protocol.json) says which pair each distance joins (a-b and c-d) and gives the definitions and ruler ids:
  a  midpoint of the upper line of the intercondylar groove      c  midpoint of the ridge on the lateral condyle
  b  intercondylar notch                                         d  vertex of the medial condyle
DFL = |a - b|, DFW = |c - d|, W/L = DFW / DFL (deck #26-28), all straight 3D distances through physical spacing, computed by
`measure.py`'s code from the spec's entries. The script finds the femur's mediolateral (ML) axis from the label alone (the
long axis of the condyles' cross-section, perpendicular to the shaft), builds a frame (that ML, and SI from b to a made
perpendicular to it) and checks the points against the femur. A failed check on the points stops the script (exit 2,
nothing written): re-place the points, do not explain the check away. The checks: each landmark within 0.05 mm of femur
bone; DFL at least 0.4 of DFW (an end-on view of the joint face puts a and b across the notch and DFL comes out a third of
its size); a-b in the sagittal plane (|cos| to ML at most 0.5) and c-d across the condyles (|cos| to ML at least 0.7), so
points placed with the sides and the front swapped (another scan's axes taken for this one's) are refused on any knee, left
or right; and SI (b to a) pointing toward the shaft. Also refused: a missing landmark, coincident landmarks, a points file
on another grid, and a femur label shorter than 4.5 mm along its shaft, whose axes cannot be read (a fault of the labels
or the field of view, not of the points). That refusal, and a printed ML axis that a render of the scan contradicts, are
raised as a To check item, not answered by moving the points.

Writes: <out>/femoral.json  the result record of `microct-core/resources/sidecar.py` (ids distal-femoral-length-dfl,
        distal-femoral-width-dfw, width-length-ratio; mm, mm, 1), plus landmarks_zyx, frame (ml and si vectors, zyx) and checks;
        `objects` holds dfl-ruler (a to b) and dfw-ruler (c to d), lines on the scan grid
Prints: one JSON line {out, values: {id: {value, unit, definition, kind}}, objects}
Example: python femoral_frame.py --spec protocol.json --landmarks points-ab.json points-cd.json --hu-json hu.json --labels labels.npy --out femoral/
Exits 2 with one sentence on bad input, before writing anything.
"""

from pathlib import Path

import measure
import numpy as np
import sidecar
from scipy import ndimage as ndi

NAMES = ('a', 'b', 'c', 'd')
DFL_ID, DFW_ID, RATIO_ID = 'distal-femoral-length-dfl', 'distal-femoral-width-dfw', 'width-length-ratio'
MAX_OFF_BONE_MM = 0.05  # a landmark further than this from femur bone fails the check
MIN_LENGTH_OVER_WIDTH = 0.4  # DFL / DFW below this fails. One scan (n=1): OA6-1RK reference 0.71, the end-on pick that was wrong 0.27
EPIPHYSIS_MM = 1.5  # the distal end of the femur whose widest cross-axis is taken as mediolateral
# |cos| of a ruler's angle to the femur's mediolateral axis. a-b lies in the sagittal plane (0 ideally), c-d runs side to
# side (1 ideally); the axis itself is within about 20 degrees of the knee's bending-plane normal and the tibial plateau's
# long axis on OA6-1RK and OA6-2RK. OA6-2RK run f45f630f, axes swapped: a-b 0.81, c-d 0.40; correct placements on both scans 0.02 to 0.05 and 0.99.
MAX_LENGTH_ML = 0.5
MIN_WIDTH_ML = 0.7
# The femur label must run at least this far along its shaft for its axes to be read. Whole labels: OA6-1RK 5.31 mm,
# OA6-2RK 5.86. Cut to the distal few mm (review of #488), the ML axis swings by up to 42 degrees below 4.5 mm of label and by
# under 3 degrees above it.
MIN_FEMUR_MM = 4.5


def unit(v):
    n = np.linalg.norm(v)
    if n == 0:
        sidecar.fail('two landmarks coincide: re-place them')
    return v / n


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


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--spec', type=sidecar.existing, required=True, help="the workflow's protocol.json: the points each distance joins, their definitions and ruler ids")
    ap.add_argument('--landmarks', type=sidecar.existing, required=True, nargs='+', help='points files on the scan grid that together hold points named a, b, c, d (the points.json files pick.py writes)')
    ap.add_argument('--hu-json', type=sidecar.existing, required=True, help='hu.json: spacing and grid')
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='labels.npy on the scan grid: the landmarks are checked against the femur')
    ap.add_argument('--label', type=int, default=1, help='femur label id')
    a = ap.parse_args()
    grid = sidecar.grid(a.hu_json)
    lm = sidecar.load_points(a.landmarks, grid['grid_id'])
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
    _, ml, checks['femur_length_mm'] = femur_axes(femur, sp, np.mean(list(pm.values()), axis=0))
    if checks['femur_length_mm'] < MIN_FEMUR_MM:
        sidecar.fail(f"the femur label runs only {checks['femur_length_mm']:.2f} mm along its shaft (at least {MIN_FEMUR_MM}): "
                     "too little shaft is labelled or in the field of view to find the femur's axes, so the labels or the scan "
                     'are the problem, not the points. Do not move the points: raise a To check item naming this')
    checks['a_b_cos_to_ml'] = abs(unit(pm['a'] - pm['b']) @ ml)
    checks['c_d_cos_to_ml'] = abs(unit(pm['c'] - pm['d']) @ ml)
    axis = (f"The femur's mediolateral axis (the long axis of its condyles' cross-section in the label) runs along "
            f'{np.round(ml, 2).tolist()} (scan z, y, x): that is the scan direction that runs side to side on this scan, '
            'not which side is lateral or where the front is; read those from a render of this scan, never from another scan')
    way_out = ('If a render of this scan shows the condyles side by side along another direction, the axis is wrong: leave the '
               'points and raise a To check item naming the printed axis')
    if checks['a_b_cos_to_ml'] > MAX_LENGTH_ML:
        sidecar.fail(f"a-b runs side to side (|cos| {checks['a_b_cos_to_ml']:.2f} to the mediolateral axis, at most "
                     f'{MAX_LENGTH_ML}), but DFL runs from the front of the groove to the notch, in the sagittal plane. {axis}. '
                     f'Re-place a and b. {way_out}')
    if checks['c_d_cos_to_ml'] < MIN_WIDTH_ML:
        sidecar.fail(f"c-d does not run side to side (|cos| {checks['c_d_cos_to_ml']:.2f} to the mediolateral axis, at least "
                     f'{MIN_WIDTH_ML}), but DFW spans the two condyles. {axis}. Re-place c and d. {way_out}')
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
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sidecar.emit_values(
        out / 'femoral.json',
        values,
        meta={'landmarks_zyx': lm, 'frame': frame, 'checks': checks, 'inputs': {a.spec: sidecar.sha256_file(a.spec)}},
        objects=placed,
    )


if __name__ == '__main__':
    main()
