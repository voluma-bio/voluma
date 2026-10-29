"""Map a labels stack made on the oriented grid back to the scan grid, so measurements use the scan.

Nearest neighbour. Refuses a frame made on another scan grid than `--header`, and an array whose shape is not the frame's stack.

Writes: <out>  the labels on the scan grid (.npy, the scan's shape), with its sidecar (the scan's grid, inputs, `mapped_from`)
Prints: one JSON line {labels, shape_zyx, voxels: {label id: voxel count}}
Example: python to_scan.py --in labels_big_oriented.npy --frame frame.json --header hu.json --out labels_big.npy
Exits 2 with one sentence on the input it checks; a missing file is a Python error.
"""
import json
from pathlib import Path

import frame as fr
import numpy as np
import sidecar

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
