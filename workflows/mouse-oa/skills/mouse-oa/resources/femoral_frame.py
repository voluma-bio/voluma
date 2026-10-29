"""Distal femoral length, width, W/L ratio and landmark frame from four annotated landmarks (deck #26-28).

  python femoral_frame.py --landmarks points-ab.json points-cd.json --hu-json hu.json --labels labels.npy --out <dir> [--label 1]

Landmarks (points files on the scan grid, as `pick.py` writes them, one per view or all four in one; picks named a to d, each name once; zyx voxel indices, floats allowed;
see ../references/oa-protocol.md for how to place them):
  a  midpoint of the upper line of the intercondylar groove      c  midpoint of the ridge on the lateral condyle
  b  intercondylar notch                                         d  vertex of the medial condyle
DFL = |a - b|, DFW = |c - d|, W/L = DFW / DFL, all straight 3D distances through physical spacing. The script also
builds a frame (ML from d to c, SI from b to a made perpendicular to ML, normal = ML x SI) and checks the points against
the femur label. A failed check stops the script (exit 2, nothing written): re-place the points, do not explain the check
away. The checks: each landmark within MAX_OFF_BONE_MM of femur bone; DFL at least MIN_LENGTH_OVER_WIDTH of DFW (an
end-on view of the joint face puts a and b across the notch and DFL comes out a third of its size); and SI (b to a)
pointing toward the shaft.

Writes femoral.json (the result record of `microct-core/resources/sidecar.py`, plus frame and checks); prints it.
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [str(HERE), str(SKILLS / 'microct-core/resources')]
try:
    import sidecar
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects core/skills/microct-core/resources/ in a directory above it '
             '(<workflows>/core/skills/<skill>/resources/, or <workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it)')

IDS = ('a', 'b', 'c', 'd')
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
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--landmarks', required=True, nargs='+', help='points files on the scan grid that together hold points named a, b, c, d (the points.json files pick.py writes)')
    ap.add_argument('--hu-json', required=True, help='hu.json: spacing and grid')
    ap.add_argument('--out', required=True)
    ap.add_argument('--labels', required=True, help='labels.npy on the scan grid: the landmarks are checked against the femur')
    ap.add_argument('--label', type=int, default=1, help='femur label id')
    a = ap.parse_args()
    grid = sidecar.grid(a.hu_json)
    lm = sidecar.load_points(a.landmarks, grid['grid_id'])
    missing = [i for i in IDS if i not in lm]
    if missing:
        sidecar.fail(f'the landmark files are missing {missing}: place a, b (length) and c, d (width)')
    sp = np.array(grid['spacing_zyx_mm'], float)
    p = {i: np.array(lm[i], float) for i in IDS}
    if any(v.shape != (3,) for v in p.values()):
        sidecar.fail('each landmark is three numbers [z, y, x] in scan voxel indices')
    dist = lambda x, y: float(np.linalg.norm((p[x] - p[y]) * sp))
    dfl, dfw = dist('a', 'b'), dist('c', 'd')
    values = {
        'distal-femoral-length-dfl': sidecar.value(
            dfl,
            'mm',
            'deck #26: straight distance from a (midpoint of the upper line of '
            'the intercondylar groove) to b (intercondylar notch)',
        ),
        'distal-femoral-width-dfw': sidecar.value(
            dfw,
            'mm',
            'deck #27: straight distance from c (midpoint of the ridge on the '
            'lateral condyle) to d (vertex of the medial condyle)',
        ),
        'width-length-ratio': sidecar.value(dfw / dfl, '1', 'deck #28: distal femoral width-to-length ratio, DFW / DFL'),
    }
    pm = {i: p[i] * sp for i in IDS}  # mm, zyx
    checks = {}
    si_seed = pm['a'] - pm['b']
    ml = unit(pm['c'] - pm['d'])
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
    checks['off_bone_mm'] = {i: off_bone_mm(p[i], femur, sp[0]) for i in IDS}
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
    if (centroid - (pm['c'] + pm['d']) / 2) @ si <= 0:
        sidecar.fail('SI (b toward a) points away from the femoral bulk: a is not the groove end nearer the shaft, or the '
                     'points are on the wrong view. Re-place a and b; do not explain this away')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sidecar.emit_values(
        out / 'femoral.json',
        values,
        meta={'landmarks_zyx': lm, 'frame': frame, 'checks': checks},
    )


if __name__ == '__main__':
    main()
