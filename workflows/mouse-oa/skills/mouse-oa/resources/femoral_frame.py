"""Measure the distal femur from four landmarks (DFL, DFW, W/L), check them and build the landmark frame.

Landmarks (points files on the scan grid, as `pick.py` writes them, one per view or all four in one; each name once; zyx voxel indices, floats allowed;
see ../references/oa-protocol.md for how to place them). The spec (--spec, protocol.json) names the pair each distance joins:
  a  midpoint of the upper line of the intercondylar groove      c  midpoint of the ridge on the lateral condyle
  b  intercondylar notch                                         d  vertex of the medial condyle
DFL = |a - b|, DFW = |c - d|, W/L = DFW / DFL (deck #26-28), all straight 3D distances through physical spacing, computed by
`measure.py`'s code from the spec's entries. The script also builds a frame (ML from d to c, SI from b to a made perpendicular to ML, normal = ML x SI) and checks the points against
the femur label. A failed check stops the script (exit 2, nothing written): re-place the points, do not explain the check
away. The checks: each landmark within 0.05 mm of femur bone; DFL at least 0.4 of DFW (an end-on view of the joint face
puts a and b across the notch and DFL comes out a third of its size); and SI (b to a) pointing toward the shaft. Also
refused: a missing landmark, coincident landmarks, a points file on another grid.

Writes: <out>/femoral.json  the result record of `microct-core/resources/sidecar.py` (ids distal-femoral-length-dfl,
        distal-femoral-width-dfw, width-length-ratio; mm, mm, 1), plus landmarks_zyx, frame (ml, si, normal vectors, zyx) and checks;
        `objects` holds dfl-ruler (a to b) and dfw-ruler (c to d), lines on the scan grid
Prints: one JSON line {out, values: {id: {value, unit, definition, kind}}, objects}
Example: python femoral_frame.py --spec protocol.json --landmarks points-ab.json points-cd.json --hu-json hu.json --labels labels.npy --out femoral/
Exits 2 with one sentence on bad input, before writing anything.
"""

import json
from pathlib import Path

import measure
import numpy as np
import sidecar
from scipy import ndimage as ndi

DFL_ID, DFW_ID, RATIO_ID = 'distal-femoral-length-dfl', 'distal-femoral-width-dfw', 'width-length-ratio'
SNAP_BOX = 40  # voxels either side of a landmark searched for the nearest femur voxel
MAX_OFF_BONE_MM = 0.05  # a landmark further than this from femur bone fails the check
MIN_LENGTH_OVER_WIDTH = 0.4  # DFL / DFW below this fails. One scan (n=1): OA6-1RK reference 0.71, the end-on pick that was wrong 0.27


def unit(v):
    n = np.linalg.norm(v)
    if n == 0:
        sidecar.fail('two landmarks coincide: re-place them')
    return v / n


def off_bone_mm(point, femur, vox):
    """Distance in mm from a point to the nearest femur voxel within SNAP_BOX, or None if none is that close."""
    c = np.round(point).astype(int)
    lo = np.maximum(c - SNAP_BOX, 0)
    box = femur[tuple(slice(lo_, c_ + SNAP_BOX + 1) for lo_, c_ in zip(lo, c, strict=True))]
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
    spec = json.loads(Path(a.spec).read_text())
    lm = sidecar.load_points(a.landmarks, grid['grid_id'])
    values, _, placed = measure.measure(spec, [DFL_ID, DFW_ID, RATIO_ID], a.hu_json, points=lm)
    (a_, b_), (c_, d_) = spec[DFL_ID]['points'], spec[DFW_ID]['points']  # a, b, c, d
    names = (a_, b_, c_, d_)
    sp = np.array(grid['spacing_zyx_mm'], float)
    p = {i: np.array(lm[i], float) for i in names}
    dfl, dfw = values[DFL_ID]['value'], values[DFW_ID]['value']
    pm = {i: p[i] * sp for i in names}  # mm, zyx
    checks = {}
    si_seed = pm[a_] - pm[b_]
    ml = unit(pm[c_] - pm[d_])
    si_perp = si_seed - (si_seed @ ml) * ml
    if np.linalg.norm(si_perp) < 0.01:
        sidecar.fail('the length axis a-b is parallel to the width axis c-d: re-place the landmarks')
    si = unit(si_perp)
    frame = {
        'ml_vector_zyx': ml.tolist(),
        'si_vector_zyx': si.tolist(),
        'normal_vector_zyx': np.cross(ml, si).tolist(),
        'note': 'ml: d to c; si: b toward a, made perpendicular to ml (toward the shaft); normal = ml x si, '
        'anterior or posterior depending on the knee: confirm on a render before using its sign',
    }
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
    centroid = np.argwhere(femur[::4, ::4, ::4]).mean(axis=0) * 4 * sp
    if (centroid - (pm[c_] + pm[d_]) / 2) @ si <= 0:
        sidecar.fail('SI (b toward a) points away from the femoral bulk: a is not the groove end nearer the shaft, or the '
                     'points are on the wrong view. Re-place a and b; do not explain this away')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sidecar.emit_values(
        out / 'femoral.json',
        values,
        meta={'landmarks_zyx': lm, 'frame': frame, 'checks': checks},
        objects=placed,
    )


if __name__ == '__main__':
    main()
