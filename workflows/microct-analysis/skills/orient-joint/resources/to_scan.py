"""Map a labels stack made on the oriented grid back to the scan grid (nearest neighbour), so measurements use the scan.

  python to_scan.py --in labels_oriented.npy --frame frame.json --header hu.json --out labels.npy
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from orient_joint import to_scan

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'microct-core/resources'))
import sidecar

if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--frame', required=True)
    ap.add_argument('--header', required=True, help='hu.json: gives the scan grid')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    import json
    frame = json.loads(Path(a.frame).read_text())
    stack = np.load(a.src)
    if list(stack.shape) != frame['shape_srs']:
        sidecar.fail(f'{a.src} has shape {list(stack.shape)} but the frame\'s stack is {frame["shape_srs"]}: '
                     'this array is not on the oriented grid')
    shape = json.loads(Path(a.header).read_text())['shape_zyx']
    out = to_scan(stack, frame, tuple(shape))
    np.save(a.out, out)
    sidecar.write(a.out, like=a.header, inputs=[a.src, a.frame], params={'mapped_from': frame['grid_id']})
    ids, counts = np.unique(out[out > 0], return_counts=True)
    sidecar.emit(labels=a.out, shape_zyx=shape, voxels={int(i): int(c) for i, c in zip(ids, counts)})
