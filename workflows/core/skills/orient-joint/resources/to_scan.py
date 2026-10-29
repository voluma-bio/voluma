"""Map a labels stack made on the oriented grid back to the scan grid, so measurements use the scan.

Nearest neighbour. Refuses a frame made on another scan grid than `--header`, and an array whose shape is not the frame's stack.

Writes: <out>  the labels on the scan grid (.npy, the scan's shape), with its sidecar (the scan's grid, inputs, `mapped_from`)
Prints: one JSON line {labels, shape_zyx, voxels: {label id: voxel count}}
Example: python to_scan.py --in labels_big_oriented.npy --frame frame.json --header hu.json --out labels_big.npy
Exits 2 with one sentence on bad input, before writing anything.
"""
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
    ap = sidecar.parser(__doc__)
    ap.add_argument('--in', dest='src', required=True, help='labels .npy on the oriented grid (the frame\'s stack shape)')
    ap.add_argument('--frame', required=True, help='frame.json from orient_joint.py')
    ap.add_argument('--header', required=True, help='hu.json: gives the scan grid and shape')
    ap.add_argument('--out', required=True, help='labels .npy to write, on the scan grid')
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
