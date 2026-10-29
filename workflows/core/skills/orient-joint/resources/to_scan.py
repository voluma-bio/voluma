"""Map a labels stack made on the oriented grid back to the scan grid (nearest neighbour), so measurements use the scan.

  python to_scan.py --in labels_big_oriented.npy --frame frame.json --header hu.json --out labels_big.npy
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/;
# only missing directories are added, so a script imported by another leaves the importer's order alone.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [d for d in (str(HERE), str(SKILLS / 'microct-core/resources')) if d not in sys.path]
try:
    import frame as fr
    import sidecar
except ModuleNotFoundError as e:
    print(f'{e}: a skill this script imports is missing; it expects <workflows>/core/skills/<skill>/resources/, or '
          '<workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it', file=sys.stderr)
    sys.exit(2)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--frame', required=True)
    ap.add_argument('--header', required=True, help='hu.json: gives the scan grid')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    frame = fr.load(a.frame)
    header = json.loads(Path(a.header).read_text())
    if frame['parent_grid_id'] != header['grid_id']:
        sidecar.fail(f'{a.frame} was made on another scan grid than {a.header}: map with the header of the scan the frame came from')
    stack = np.load(a.src)
    if list(stack.shape) != frame['shape']:
        sidecar.fail(f'{a.src} has shape {list(stack.shape)} but the frame\'s stack is {frame["shape"]}: '
                     'this array is not on the oriented grid')
    shape = header['shape_zyx']
    out = fr.to_scan(stack, frame, tuple(shape))
    np.save(a.out, out)
    sidecar.write(a.out, like=a.header, inputs=[a.src, a.frame], params={'mapped_from': frame['grid_id']})
    ids, counts = np.unique(out[out > 0], return_counts=True)
    sidecar.emit(labels=a.out, shape_zyx=shape, voxels={int(i): int(c) for i, c in zip(ids, counts)})
