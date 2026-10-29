"""Put the pieces of a small-structure request back under their real labels and merge them into the big-bone labels.

  python merge_labels.py --big labels_big.npy --small small_trimmed.npy --map 61:6 62:6 5:5 --out labels_merged.npy

`segment_sam` rejects duplicate labels, so a structure in several 3D pieces was sent with one temporary label per piece
(61 and 62 for the two pieces of label 6). `--map temp:final` renames each; several temps may map to one final label. The two
volumes must be on the same grid (map the small request to the scan grid with `to_scan.py` first).

One rule, **not validated** (the bake-off that set the other rules did not test it): the big bones win overlaps. A small
voxel is written only where `--big` is 0; the voxels it would have taken from a big bone are counted in the output and left
with the big bone. A temp label that is also a label in `--big` is refused. A small-structure label that loses much of its
volume to a big bone is a To check item, not something to merge past.
"""
import argparse
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path, so every directory a script imports from is added here.
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'microct-core/resources')]
try:
    import sidecar
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects <workflows>/core/skills/<skill>/resources/ with '
             '<workflows>/core/skills/microct-core/resources/sidecar.py beside it')

if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--big', required=True, help='scan-grid labels of the big bones (clipped)')
    ap.add_argument('--small', required=True, help='scan-grid labels of the small request (trimmed, mapped back)')
    ap.add_argument('--map', nargs='+', required=True, metavar='temp:final', help='temporary label : label it goes back to')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    try:
        mapping = {int(t): int(f) for t, f in (m.split(':') for m in a.map)}
    except ValueError:
        sidecar.fail(f'--map takes temp:final integer pairs such as 61:6 62:6, got {a.map}')
    big = np.load(a.big)
    small = np.load(a.small, mmap_mode='r')
    if big.shape != small.shape:
        sidecar.fail(f'{a.big} {big.shape} and {a.small} {small.shape} are on different grids: map the small request to the scan grid first')
    g_big, g_small = sidecar.grid(sidecar.sidecar_path(a.big)), sidecar.grid(sidecar.sidecar_path(a.small))
    if g_big['grid_id'] != g_small['grid_id']:
        sidecar.fail('the two volumes have different grid ids: both must be on the scan grid')
    clash = sorted(set(mapping) & {int(i) for i in np.unique(big)})
    if clash:
        sidecar.fail(f'temporary labels {clash} are already labels in {a.big}: choose temporary labels the big bones do not use')
    present = {int(i) for i in np.unique(small) if i > 0}
    stray = sorted(present - set(mapping))
    if stray:
        sidecar.fail(f'{a.small} holds labels {stray} that --map does not mention: map each to its final label (or to 0 to drop it)')
    out, report = big.copy(), {}
    vox = float(np.prod(g_big['spacing_zyx_mm']))
    for temp, final in mapping.items():
        m = np.asarray(small) == temp
        free = m & (big == 0)
        out[free] = final
        report[temp] = {'final': final, 'voxels': int(m.sum()), 'written': int(free.sum()), 'lost_to_big_bones': int(m.sum() - free.sum())}
    np.save(a.out, out)
    sidecar.write(a.out, like=sidecar.sidecar_path(a.big), inputs=[a.big, a.small], params={'map': {str(k): v for k, v in mapping.items()}})
    ids, counts = np.unique(out[out > 0], return_counts=True)
    sidecar.emit(labels=a.out, merged=report, volume_mm3={int(i): round(float(c) * vox, 4) for i, c in zip(ids, counts)})
