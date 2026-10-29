"""Give a whole 3D piece a different label: the fix for "this component carries the wrong label" and for naming a
candidate from `unlabelled.py`.

  python relabel.py --labels labels.npy --out fixed.npy --at z,y,x --to 5
  python relabel.py --labels labels.npy --out fixed.npy --at z,y,x --to 5 --pieces cand.npy

Without `--pieces`, the piece is the 26-connected part of the label under the voxel `--at` (the voxel must be labelled).
With `--pieces` (a candidate volume from `unlabelled.py`), it is the candidate containing the voxel; it overwrites whatever
label those voxels had, and the previous labels are reported. `--to 0` clears the piece.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/;
# only missing directories are added, so a script imported by another leaves the importer's order alone.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [d for d in (str(HERE), str(SKILLS / 'microct-core/resources')) if d not in sys.path]
try:
    import sidecar
except ModuleNotFoundError as e:
    print(f'{e}: a skill this script imports is missing; it expects <workflows>/core/skills/<skill>/resources/, or '
          '<workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it', file=sys.stderr)
    sys.exit(2)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--labels', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--at', required=True, help='z,y,x of a voxel in the piece')
    ap.add_argument('--to', type=int, required=True)
    ap.add_argument('--pieces')
    a = ap.parse_args()
    labels = np.load(a.labels)
    z, y, x = (int(v) for v in a.at.split(','))
    if a.pieces:
        src = np.load(a.pieces, mmap_mode='r')
        k = int(src[z, y, x])
        if k == 0:
            sidecar.fail(f'voxel {a.at} is in no candidate of {a.pieces}: pick a voxel inside one (centre_zyx)')
        m = np.asarray(src) == k
    else:
        lv = int(labels[z, y, x])
        if lv == 0:
            sidecar.fail(f'voxel {a.at} is unlabelled: pass --pieces <candidates.npy> to label an unlabelled piece')
        pieces, _ = ndi.label(labels == lv, np.ones((3, 3, 3)))
        m = pieces == pieces[z, y, x]
    before = {int(i): int(c) for i, c in zip(*np.unique(labels[m], return_counts=True))}
    labels[m] = a.to
    np.save(a.out, labels)
    sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.labels] + ([a.pieces] if a.pieces else []),
                  params={'at': [z, y, x], 'to': a.to})
    sidecar.emit(labels=a.out, voxels=int(m.sum()), previous_labels=before, now=a.to)
