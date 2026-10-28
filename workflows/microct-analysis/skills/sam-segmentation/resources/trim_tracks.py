"""Trim each small structure's SAM track to the frames it actually occupies.

  python trim_tracks.py --labels labels_oriented.npy --out trimmed.npy [--tracks labels.json]

After a small structure ends, SAM keeps its object alive and it picks up whatever sits at the same spot on later frames (a
neighbouring bone, unlabelled bone). For every object in the sidecar `segment_sam` writes beside its labels (`--tracks`,
default `<labels>.json`), this keeps the unbroken run of slices around its prompt frame in which the object has a mask
with confidence >= `--min-conf` (0.5), and clears its label elsewhere. Run it on the small-structure request only, and
give `--only 5 7 8` to limit it to some labels. Slices are axis 0, so pass labels on the stack `segment_sam` was given,
before `to_scan.py`.

One rule, set after seeing OA6-1RK's reference, validated on that scan only (Dice 0.90-0.98 for 6 of 8 small labels). The
cut shortens a structure's ends, so trimmed volumes run 10-20% under the reference. A rule that follows overlap with the
neighbouring slice (IoU >= 0.3) scored higher on labels 5, 9 and 10 in the same experiment, and was also picked after
seeing the reference: neither is validated on a second scan.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'microct-core/resources'))
import sidecar


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
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--labels', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--tracks', help='segment_sam sidecar (default: <labels>.json)')
    ap.add_argument('--only', type=int, nargs='+', help='labels to trim (default: all objects in the sidecar)')
    ap.add_argument('--min-conf', type=float, default=0.5)
    a = ap.parse_args()
    tracks_path = a.tracks or str(sidecar.sidecar_path(a.labels))
    if not Path(tracks_path).exists():
        sidecar.fail(f'{tracks_path} not found: it is the sidecar segment_sam writes beside its labels')
    tracks = load_tracks(tracks_path)
    labels = np.load(a.labels)
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
    sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.labels, tracks_path],
                  params={'min_conf': a.min_conf, 'only': a.only})
    sidecar.emit(labels=a.out, trimmed=report)
