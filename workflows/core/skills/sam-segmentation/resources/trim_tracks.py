"""Trim each small structure's SAM track to the frames it actually occupies.

After a small structure ends, SAM keeps its object alive and it picks up whatever sits at the same spot on later frames (a
neighbouring bone, unlabelled bone). For every object in the sidecar `segment_sam` writes beside its labels (`--tracks`,
default `<labels>.json`), this keeps the unbroken run of slices around its prompt frame in which the object has a mask
with confidence >= `--min-conf`, and clears its label elsewhere. Run it on the small-structure request only, and
give `--only 5 7 8` to limit it to some labels. Slices are axis 0, so pass labels on the stack `segment_sam` was given,
before `to_scan.py`. `--like` is that stack's sidecar (`oriented.json`). `segment_sam`'s own sidecar has no grid, so stamp
one on its output right after the call (`sidecar.py --array small_oriented.npy --like oriented.json`); this script refuses
labels whose `grid_id` is not `--like`'s, so labels from another orientation of the same scan cannot pass.

Writes: <out>  the trimmed labels (.npy, the shape of --labels), with its sidecar (the grid of --like, min_conf, only)
Prints: one JSON line {labels, trimmed: {label: {kept_slices, slices, voxels_before, voxels_after}}}
Example: python trim_tracks.py --labels small_oriented.npy --out small_trimmed_oriented.npy --like oriented.json --only 61 62 5
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
    import sidecar
except ModuleNotFoundError as e:
    print(f'{e}: a skill this script imports is missing; it expects <workflows>/core/skills/<skill>/resources/, or '
          '<workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it', file=sys.stderr)
    sys.exit(2)



def load_tracks(path):
    """{label: {'prompt_frame': int, 'confidence': {slice: float}}} from the sidecar `segment_sam` writes beside its labels.

    The one place that knows the file's format: `{axis, shape, prompt, objects: [{label, name, promptFrame, box,
    confidence: {"<slice>": 0-1}}]}`. A slice missing from `confidence` had no mask.
    """
    raw = json.loads(Path(path).read_text())
    if 'objects' not in raw:
        sidecar.fail(f'{path} has no "objects": it is not the sidecar segment_sam writes beside its labels')
    if raw.get('axis', 0) != 0:
        sidecar.fail(f'{path} was sliced along axis {raw["axis"]}: trim_tracks needs slices on axis 0 (an oriented stack)')
    return {o['label']: {'prompt_frame': o['promptFrame'],
                         'confidence': {int(f): c for f, c in o['confidence'].items()}}
            for o in raw['objects']}


def trim(confidence, frame, n_frames, min_conf=0.5):
    """Boolean per-slice keep vector: the unbroken run around `frame` where confidence >= min_conf."""
    keep = np.zeros(n_frames, bool)
    if confidence.get(frame, 0.0) < min_conf:
        return keep
    keep[frame] = True
    for step in (1, -1):
        f = frame + step
        while 0 <= f < n_frames and confidence.get(f, 0.0) >= min_conf:
            keep[f] = True
            f += step
    return keep


if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--labels', required=True, help='labels .npy from segment_sam, on the oriented stack, stamped with its grid')
    ap.add_argument('--out', required=True, help='trimmed labels .npy to write')
    ap.add_argument('--like', required=True, help='sidecar of the stack segment_sam was given (oriented.json): the grid of the output')
    ap.add_argument('--tracks', help='segment_sam sidecar (default: <labels>.json)')
    ap.add_argument('--only', type=int, nargs='+', help='labels to trim (default: all objects in the sidecar)')
    ap.add_argument('--min-conf', type=float, default=0.5, help='SAM confidence (0-1) a slice needs to be kept')
    a = ap.parse_args()
    tracks_path = a.tracks or str(sidecar.sidecar_path(a.labels))
    if not Path(tracks_path).exists():
        sidecar.fail(f'{tracks_path} not found: it is the sidecar segment_sam writes beside its labels')
    tracks = load_tracks(tracks_path)
    grid = sidecar.grid(a.like)
    labels = np.load(a.labels)
    stamped = json.loads(sidecar.sidecar_path(a.labels).read_text()).get('grid_id')
    if stamped != grid['grid_id']:
        sidecar.fail(f'{a.labels} is not stamped with the grid of {a.like} (it has {stamped}): run '
                     f'`sidecar.py --array {a.labels} --like {a.like}` right after segment_sam, and check that it was run on that stack')
    unknown = [lv for lv in (a.only or []) if lv not in tracks]
    if unknown:
        sidecar.fail(f'labels {unknown} are not objects in {tracks_path} (it has {sorted(tracks)})')
    report = {}
    for label, t in tracks.items():
        if a.only and label not in a.only:
            continue
        keep = trim(t['confidence'], t['prompt_frame'], labels.shape[0], a.min_conf)
        before = int((labels == label).sum())
        labels[(labels == label) & ~keep[:, None, None]] = 0
        report[label] = {'kept_slices': int(keep.sum()), 'slices': labels.shape[0], 'voxels_before': before,
                             'voxels_after': int((labels == label).sum())}
    np.save(a.out, labels)
    sidecar.write(a.out, like=a.like, inputs=[a.labels, tracks_path],
                  params={'min_conf': a.min_conf, 'only': a.only})
    sidecar.emit(labels=a.out, trimmed=report)
