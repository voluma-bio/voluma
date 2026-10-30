"""Compute the protocol's distances, label volumes and ratios, in mm and mm³, with definitions and inputs.

`--spec` is the workflow's protocol.json (keyed by output id); `--output` lists the outputs to compute, and each is built from its
spec entry, which holds (and may add "kind": "diagnostic" for a number that is not a deliverable):
  {"points": ["a", "b"], "ruler": "dfl-ruler", "definition": "..."}    distance between two named points of --points; "ruler" is the
                                                                        output id of the line drawn between them (an object)
  {"labels": [3], "volume": "bone-labels", "definition": "..."}        voxels of those label values in --labels; "volume" is the
                                                                        output id of the labels volume the count was made on (an object)
  {"num": "<output id>", "den": "<output id>", "definition": "..."}    a ratio of two outputs listed before it in --output
Points are voxel indices on the grid of --grid (fractions allowed). A ratio's unit is "1" when both values share a unit, else
"<num unit>/<den unit>". Refused: an output the spec lacks or an entry of none of these forms, a point or labels file not
given, a point missing from the files, a ratio naming an output not computed before it, a zero denominator.
The record format is in `microct-core/resources/sidecar.py`.

Writes: <out>  the result record {values: {id: {value, unit, definition, kind, ...}}, objects, grid_id, spacing_zyx_mm, inputs}
Prints: one JSON line {out, values: {id: {value, unit, definition, kind}}, objects}
Example: python measure.py --spec protocol.json --output patella-volume --labels labels.npy --grid hu.json --out measurements.json
Exits 2 with one sentence on bad input, before writing anything.
"""

import json
from pathlib import Path

import numpy as np
import objects
import sidecar


def distance_mm(points_zyx, spacing_zyx_mm):
    p = np.asarray(points_zyx, float)
    if p.shape != (2, 3):
        raise ValueError(f'a distance needs two [z, y, x] points, got shape {p.shape}')
    return float(np.linalg.norm((p[1] - p[0]) * np.asarray(spacing_zyx_mm, float)))


def volume_mm3(labels, ids, spacing_zyx_mm):
    return float(np.isin(labels, ids).sum() * np.prod(spacing_zyx_mm))


def ratio(num, den):
    if den['value'] == 0:
        raise ValueError('ratio denominator is zero')
    unit = '1' if num['unit'] == den['unit'] else f'{num["unit"]}/{den["unit"]}'
    return num['value'] / den['value'], unit


def measure(spec, outputs, grid_path, labels=None, points=None):
    """Values, input hashes and objects of `outputs` (ids of `spec`), on the grid of `grid_path`; `labels` is a .npy path, `points` {name: zyx}."""
    grid = sidecar.grid(grid_path)
    sp = grid['spacing_zyx_mm']
    out, inputs, placed = {}, {}, {}
    for oid in outputs:
        if oid not in spec:
            sidecar.fail(f'the spec has no entry for the output {oid!r}: its entries are {sorted(spec)}')
        e = spec[oid]
        kind = e.get('kind', 'measurement')
        if 'points' in e:
            missing = [n for n in e['points'] if n not in (points or {})]
            if missing:
                sidecar.fail(f'{oid}: the points files lack {missing}: pass --points files that hold them')
            p = [points[n] for n in e['points']]
            try:
                value, unit, extra = distance_mm(p, sp), 'mm', {'points_zyx': p}
            except ValueError as err:
                sidecar.fail(f'{oid}: {err}')
            if 'ruler' in e:
                placed[e['ruler']] = objects.line(p[0], p[1], grid['grid_id'])
        elif 'labels' in e:
            if not labels:
                sidecar.fail(f'{oid} counts label voxels: pass --labels')
            inputs[labels] = sidecar.sha256_file(labels)
            value, unit, extra = volume_mm3(np.load(labels, mmap_mode='r'), e['labels'], sp), 'mm³', {'labels': e['labels']}
            if 'volume' in e:
                placed[e['volume']] = objects.volume(labels, grid_path, kind='labels')
        elif 'num' in e and 'den' in e:
            missing = [k for k in (e['num'], e['den']) if k not in out]
            if missing:
                sidecar.fail(f'{oid} is a ratio of {missing}, which --output must list before it')
            try:
                value, unit = ratio(out[e['num']], out[e['den']])
            except ValueError as err:
                sidecar.fail(f'{oid}: {err}')
            extra = {'num': e['num'], 'den': e['den']}
        else:
            sidecar.fail(f'the entry for {oid!r} is not a distance (points), a label volume (labels) or a ratio (num, den)')
        out[oid] = sidecar.value(value, unit, e.get('definition', ''), kind, **extra)
    return out, inputs, placed


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--spec', type=sidecar.existing, required=True, help="the workflow's protocol.json")
    ap.add_argument('--output', nargs='+', required=True, metavar='ID', help='output ids to compute, in this order (a ratio after the values it divides)')
    ap.add_argument('--grid', type=sidecar.existing, required=True, help='hu.json (or any sidecar): the grid the points and labels are on')
    ap.add_argument('--labels', type=sidecar.existing, help='labels.npy on --grid, for the label volumes (its sidecar beside it)')
    ap.add_argument('--points', type=sidecar.existing, nargs='+', help='points files on --grid that hold the named points (the points.json files pick.py writes)')
    ap.add_argument('--out', required=True, help='JSON file to write')
    a = ap.parse_args()
    spec = json.loads(Path(a.spec).read_text())
    grid = sidecar.grid(a.grid)
    points = sidecar.load_points(a.points, grid['grid_id']) if a.points else None
    values, inputs, placed = measure(spec, a.output, a.grid, a.labels, points)
    inputs.update({a.grid: sidecar.sha256_file(a.grid), a.spec: sidecar.sha256_file(a.spec)})
    sidecar.emit_values(
        a.out, values, objects=placed, meta={'grid_id': grid['grid_id'], 'spacing_zyx_mm': grid['spacing_zyx_mm'], 'inputs': inputs}
    )


if __name__ == '__main__':
    main()
