"""Distal femoral length, width, W/L ratio and landmark frame from four annotated landmarks (deck #26-28).

  python femoral_frame.py --landmarks landmarks.json --hu-json hu.json --out <dir> [--labels labels.npy --label 1]

Landmarks (zyx voxel indices on the scan grid, floats allowed; the points.json `pick.py` writes for picks named a to d works as is;
see ../references/oa-protocol.md for how to place them):
  a  midpoint of the upper line of the intercondylar groove      c  midpoint of the ridge on the lateral condyle
  b  intercondylar notch                                         d  vertex of the medial condyle
DFL = |a - b|, DFW = |c - d|, W/L = DFW / DFL, all straight 3D distances through physical spacing. The script also
builds a frame (ML from d to c, SI from b to a made perpendicular to ML, normal = ML x SI) and, with --labels,
reports how far each landmark lies from femur bone, so a landmark floating in
the joint space is caught, and whether SI points toward the femoral shaft.

Writes femoral.json (values, frame, checks); prints one JSON line.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; microct-core is found by walking up to the directory that holds it.
CORE = next((p / 'microct-analysis/skills/microct-core/resources' for p in HERE.parents
             if (p / 'microct-analysis/skills/microct-core/resources/sidecar.py').exists()), None)
if CORE is None:
    sys.exit('Cannot find microct-core: this script expects microct-analysis/skills/microct-core/resources/ in a '
             'directory above it (<workflows>/workflow-mouse-oa/resources/ with <workflows>/microct-analysis/ beside it)')
sys.path[:0] = [str(HERE), str(CORE)]
import sidecar

IDS = ('a', 'b', 'c', 'd')
SNAP_BOX = 40  # voxels either side of a landmark searched for the nearest femur voxel
MAX_OFF_BONE_MM = 0.05  # a landmark further than this from femur bone is flagged


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
    ap.add_argument('--landmarks', required=True, help='JSON {"a": [z,y,x], "b": ..., "c": ..., "d": ...}, or the points.json pick.py wrote with picks named a, b, c, d')
    ap.add_argument('--hu-json', required=True, help='hu.json: spacing and grid')
    ap.add_argument('--out', required=True)
    ap.add_argument('--labels', help='labels.npy on the scan grid: checks each landmark against the femur')
    ap.add_argument('--label', type=int, default=1, help='femur label id')
    a = ap.parse_args()
    lm = sidecar.load_points(a.landmarks)
    missing = [i for i in IDS if i not in lm]
    if missing:
        sidecar.fail(f'landmarks.json is missing {missing}: place a, b (length) and c, d (width)')
    sp = np.array(sidecar.grid(a.hu_json)['spacing_zyx_mm'], float)
    p = {i: np.array(lm[i], float) for i in IDS}
    if any(v.shape != (3,) for v in p.values()):
        sidecar.fail('each landmark is three numbers [z, y, x] in scan voxel indices')
    dist = lambda x, y: float(np.linalg.norm((p[x] - p[y]) * sp))
    dfl, dfw = dist('a', 'b'), dist('c', 'd')
    values = {
        'DFL': {
            'value': dfl,
            'unit': 'mm',
            'definition': 'deck #26: straight distance from a (midpoint of the upper line of '
            'the intercondylar groove) to b (intercondylar notch)',
        },
        'DFW': {
            'value': dfw,
            'unit': 'mm',
            'definition': 'deck #27: straight distance from c (midpoint of the ridge on the '
            'lateral condyle) to d (vertex of the medial condyle)',
        },
        'DFW/DFL': {'value': dfw / dfl, 'unit': '1', 'definition': 'deck #28: distal femoral width-to-length ratio'},
    }
    pm = {i: p[i] * sp for i in IDS}  # mm, zyx
    checks = {'warnings': []}
    si_seed = pm['a'] - pm['b']
    ml = unit(pm['c'] - pm['d'])
    si_perp = si_seed - (si_seed @ ml) * ml
    if np.linalg.norm(si_perp) < 0.01:
        checks['warnings'].append('the length axis a-b is parallel to the width axis c-d: re-place the landmarks')
        frame = None
    else:
        si = unit(si_perp)
        frame = {
            'ml_vector_zyx': ml.tolist(),
            'si_vector_zyx': si.tolist(),
            'normal_vector_zyx': np.cross(ml, si).tolist(),
            'note': 'ml: d to c; si: b toward a, made perpendicular to ml (toward the shaft); normal = ml x si, '
            'anterior or posterior depending on the knee: confirm on a render before using its sign',
        }
    if a.labels:
        labels = np.load(a.labels, mmap_mode='r')
        femur = np.asarray(labels) == a.label
        checks['off_bone_mm'] = {i: off_bone_mm(p[i], femur, sp[0]) for i in IDS}
        far = [i for i, d in checks['off_bone_mm'].items() if d is None or d > MAX_OFF_BONE_MM]
        if far:
            checks['warnings'].append(
                f'landmarks {far} are more than {MAX_OFF_BONE_MM} mm from femur bone: snap them '
                'to the bone surface and look at the render again'
            )
        if frame:
            centroid = np.argwhere(femur[::4, ::4, ::4]).mean(axis=0) * 4 * sp
            toward = bool((centroid - (pm['c'] + pm['d']) / 2) @ np.array(frame['si_vector_zyx']) > 0)
            checks['si_points_toward_shaft'] = toward
            if not toward:
                checks['warnings'].append('SI points away from the femoral bulk: a and b (or c and d) may be swapped')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'femoral.json').write_text(
        json.dumps({'values': values, 'landmarks_zyx': lm, 'frame': frame, 'checks': checks}, indent=1) + '\n'
    )
    sidecar.emit(
        out=str(out / 'femoral.json'),
        values={k: round(v['value'], 5) for k, v in values.items()},
        warnings=checks['warnings'],
    )


if __name__ == '__main__':
    main()
