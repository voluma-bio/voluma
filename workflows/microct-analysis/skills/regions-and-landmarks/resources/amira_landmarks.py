"""Write points as an Amira landmark file, so the lab can check them on the scan in Amira.

  python amira_landmarks.py --points points.json --header hu.json --out landmarks.landmarkAscii

`--points` is the points.json `pick.py` writes, or a plain {"name": [z, y, x]} file (femoral landmarks, the width points
`iioc.py` writes): scan voxel indices, fractions allowed. Each point is moved to physical millimetres with the DICOM affine in
`hu.json` (voxel centres, DICOM patient coordinates) and written as one landmark set in Amira's ASCII landmark format
(`# AmiraMesh 3D ASCII 2.0`, `ContentType "LandmarkSet"`), in the order of the file; `<out>.names.json` lists that order,
because the format has no names. Load it in Amira on the same DICOM series. Amira takes its own origin from the series: if the
points sit a constant offset from the bone, the series was loaded with another origin; check one point on a known feature.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path, so every directory a script imports from is added here.
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'microct-core/resources')]
try:
    import sidecar
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects <workflows>/microct-analysis/skills/<skill>/resources/ with '
             '<workflows>/microct-analysis/skills/microct-core/resources/sidecar.py beside it')


def to_world_mm(points_zyx, affine_xyz):
    """Physical mm (x, y, z) of voxel-index points (z, y, x); the affine consumes (x, y, z) voxel-centre indices."""
    xyz1 = np.column_stack([np.asarray(points_zyx, float)[:, ::-1], np.ones(len(points_zyx))])
    return (xyz1 @ np.asarray(affine_xyz).T)[:, :3]


def amira_text(world_mm):
    rows = '\n'.join(' '.join(f'{c:.6f}' for c in p) for p in world_mm)
    return (
        '# AmiraMesh 3D ASCII 2.0\n\n'
        f'define Markers {len(world_mm)}\n\n'
        'Parameters {\n    NumSets 1,\n    ContentType "LandmarkSet"\n}\n\n'
        'Markers { float[3] Coordinates } @1\n\n'
        '# Data section follows\n'
        f'@1\n{rows}\n'
    )


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--points', required=True)
    ap.add_argument('--header', required=True, help='hu.json of the scan the points are on (has the affine)')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    header = json.loads(Path(a.header).read_text())
    if 'affine_xyz_to_world_mm' not in header:
        sidecar.fail(f'{a.header} has no affine_xyz_to_world_mm: pass the hu.json that scan-intake wrote')
    points = sidecar.load_points(a.points)
    if not points:
        sidecar.fail(f'{a.points} holds no points')
    names = list(points)
    world = to_world_mm([points[n] for n in names], header['affine_xyz_to_world_mm'])
    Path(a.out).write_text(amira_text(world))
    Path(a.out + '.names.json').write_text(json.dumps(names) + '\n')
    sidecar.emit(landmarks=a.out, names=names, world_mm_xyz=world.round(4).tolist())
