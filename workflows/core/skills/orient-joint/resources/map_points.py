"""Move points and candidate pieces between the scan grid and the oriented stack, so a small structure found on the scan
gets a SAM box on the stack.

  python map_points.py --frame frame.json --to-oriented z,y,x [z,y,x ...]      scan voxel -> (slice, row, col) on the stack
  python map_points.py --frame frame.json --to-scan s,r,c [s,r,c ...]         stack (slice, row, col) -> scan voxel
  python map_points.py --frame frame.json --points-file points.json --out mapped.json      a points file, to the other grid
  python map_points.py --frame frame.json --pieces cand.npy [--ids 1 3 4] --out boxes.json

`--points-file` takes a points file (`pick.py` writes one) made on the frame's grid or on its parent scan grid and writes the same
points on the other, with that grid's `grid_id`, so a script that refuses a file from the wrong grid accepts the new one. Fractional.

`--pieces` takes the candidate volume `unlabelled.py` wrote (scan grid, one id per 3D piece) and gives each piece the SAM
prompt for the stack: `promptFrame` (the slice that cuts most of the piece), `box` ([row0, col0, row1, col1], ends inclusive,
that piece's extent on that slice), `centre_srs` and the slice range it spans. The box is where the piece is, not yet snapped to
the bone: pass it to `snap_boxes.py --index <promptFrame>` and look at it. Prints the same table and writes it to `--out`.
A piece with `voxels_outside_stack` > 0 is cut by the stack's edge and is listed under `cut_by_stack`: its box and its SAM track
would be truncated, so re-orient with a larger `--margin-mm` before prompting it.
Points are fractional where the mapping is; a point outside the stack is reported, not clipped.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [str(HERE), str(SKILLS / 'microct-core/resources')]
try:
    import frame as fr
    import sidecar
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects core/skills/microct-core/resources/ in a directory above it '
             '(<workflows>/core/skills/<skill>/resources/, or <workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it)')


def parse_points(items):
    try:
        pts = np.array([[float(v) for v in i.split(',')] for i in items])
    except ValueError:
        sidecar.fail(f'points are z,y,x (or s,r,c) numbers separated by commas, got {items}')
    if pts.shape[1] != 3:
        sidecar.fail(f'each point needs three numbers, got {items}')
    return pts


def piece_prompt(voxels_zyx, frame):
    srs = np.rint(fr.from_scan_points(voxels_zyx, frame)).astype(int)
    shape = frame['shape']
    ok = ((srs >= 0) & (srs < shape)).all(axis=1)
    if not ok.any():
        sidecar.fail('the piece lies outside the oriented stack: is this the frame of this scan?')
    srs = srs[ok]
    counts = np.bincount(srs[:, 0])
    best = int(counts.argmax())
    on = srs[srs[:, 0] == best]
    (r0, c0), (r1, c1) = on[:, 1:].min(0), on[:, 1:].max(0)
    return {'promptFrame': best, 'box': [int(r0), int(c0), int(r1), int(c1)], 'centre_srs': srs.mean(0).round().astype(int).tolist(),
            'slices': [int(srs[:, 0].min()), int(srs[:, 0].max())], 'voxels_inside_stack': int(ok.sum()),
            'voxels_outside_stack': int((~ok).sum())}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--frame', required=True, help='frame.json from orient_joint.py')
    ap.add_argument('--to-oriented', nargs='+', metavar='z,y,x')
    ap.add_argument('--to-scan', nargs='+', metavar='s,r,c')
    ap.add_argument('--points-file', help='points file on the frame grid or the scan grid: written to --out on the other')
    ap.add_argument('--pieces', help='candidate volume from unlabelled.py (scan grid)')
    ap.add_argument('--ids', type=int, nargs='+', help='candidate ids to map (default: all)')
    ap.add_argument('--out', help='JSON file for --pieces or --points-file')
    a = ap.parse_args()
    if sum(x is not None for x in (a.to_oriented, a.to_scan, a.points_file, a.pieces)) != 1:
        sidecar.fail('give exactly one of --to-oriented, --to-scan, --points-file, --pieces')
    if (a.pieces or a.points_file) and not a.out:
        sidecar.fail('--pieces and --points-file need --out')
    frame = fr.load(a.frame)
    if a.to_oriented:
        sidecar.emit(oriented_srs=fr.from_scan_points(parse_points(a.to_oriented), frame).round(2).tolist())
    elif a.to_scan:
        sidecar.emit(scan_zyx=fr.to_scan_points(parse_points(a.to_scan), frame).round(2).tolist())
    elif a.points_file:
        d = json.loads(Path(a.points_file).read_text())
        if d.get('grid_id') == frame['parent_grid_id']:
            target, move = frame['grid_id'], fr.from_scan_points
        elif d.get('grid_id') == frame['grid_id']:
            target, move = frame['parent_grid_id'], fr.to_scan_points
        else:
            sidecar.fail(f'{a.points_file} is on neither grid of this frame (scan {frame["parent_grid_id"][:12]}..., frame '
                         f'{frame["grid_id"][:12]}...): it needs the frame.json of the grid it was picked on')
        points = sidecar.load_points(a.points_file, d['grid_id'])
        if not points:
            sidecar.fail(f'{a.points_file} holds no points')
        names, pts = list(points), move(list(points.values()), frame)
        Path(a.out).write_text(json.dumps({'grid_id': target, 'points': [{'name': n, 'zyx': p.tolist()} for n, p in zip(names, pts, strict=True)]}, indent=1) + '\n')
        sidecar.emit(points=a.out, grid_id=target)
    else:
        grid = sidecar.grid(sidecar.sidecar_path(a.pieces))['grid_id']
        if grid != frame['parent_grid_id']:
            sidecar.fail(f'{a.pieces} is not on the scan grid this frame was made from: run unlabelled.py on the scan-grid labels')
        cand = np.load(a.pieces, mmap_mode='r')
        ids = a.ids or [int(i) for i in np.unique(cand) if i > 0]
        cand = np.asarray(cand)
        boxes = ndi.find_objects(cand)  # one pass over the volume, then each piece is searched inside its own box only
        prompts = {}
        for i in ids:
            if i < 1 or i > len(boxes) or boxes[i - 1] is None:
                sidecar.fail(f'candidate {i} is not in {a.pieces}')
            sl = boxes[i - 1]
            vox = np.argwhere(cand[sl] == i) + [s.start for s in sl]
            prompts[str(i)] = piece_prompt(vox, frame)
        cut = [i for i, p in prompts.items() if p['voxels_outside_stack']]
        Path(a.out).write_text(json.dumps(prompts, indent=1) + '\n')
        sidecar.emit(boxes=a.out, pieces=prompts, cut_by_stack=cut)
