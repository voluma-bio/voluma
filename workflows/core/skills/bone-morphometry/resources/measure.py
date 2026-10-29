"""Compute distances, label volumes and ratios from a JSON spec, in mm and mm³, with definitions and inputs.

Spec (all sections optional; a name is the output id the value is written under, unique across sections; an entry may
add "kind": "diagnostic" for a number that is not a deliverable):
  {"distances": {"name": {"points_zyx": [[z, y, x], [z, y, x]], "definition": "..."}},
   "volumes":   {"name": {"labels": "labels.npy", "ids": [3], "definition": "..."}},
   "ratios":    {"name": {"num": "name_a", "den": "name_b", "definition": "..."}}}
Points are voxel indices on the grid of --grid (fractions allowed). A ratio's unit is "1" when both values share a
unit, else "<num unit>/<den unit>". Ratios may use distances, volumes and earlier ratios. Refused: a name used twice, a
distance that is not two [z, y, x] points, a volume without "labels" and "ids", a ratio naming something not computed
before it, a zero denominator. The record format is in `microct-core/resources/sidecar.py`.

Writes: <out>  the result record {values: {id: {value, unit, definition, kind, ...}}, grid_id, spacing_zyx_mm, inputs}
Prints: one JSON line {out, values: {id: {value, unit, definition, kind}}}
Example: python measure.py --spec spec.json --grid hu.json --out measurements.json
Exits 2 with one sentence on bad input, before writing anything.
"""

import json
from pathlib import Path

import numpy as np
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


def measure(spec, grid):
    sp = grid['spacing_zyx_mm']
    out, inputs = {}, {}

    def add(name, value, unit, entry, **extra):
        if name in out:
            sidecar.fail(f'the name {name!r} is used twice in the spec: give each measurement its own name')
        out[name] = sidecar.value(value, unit, entry.get('definition', ''), entry.get('kind', 'measurement'), **extra)

    for name, d in spec.get('distances', {}).items():
        try:
            add(name, distance_mm(d['points_zyx'], sp), 'mm', d, points_zyx=d['points_zyx'])
        except (KeyError, ValueError) as e:
            sidecar.fail(f'distance {name!r}: {e}; expected {{"points_zyx": [[z, y, x], [z, y, x]]}}')
    for name, v in spec.get('volumes', {}).items():
        if 'labels' not in v or 'ids' not in v:
            sidecar.fail(f'volume {name!r} needs "labels" (a .npy path) and "ids" (a list of label values)')
        inputs[v['labels']] = sidecar.sha256_file(v['labels'])
        add(
            name,
            volume_mm3(np.load(v['labels'], mmap_mode='r'), v['ids'], sp),
            'mm³',
            v,
            labels=v['labels'],
            ids=v['ids'],
        )
    for name, r in spec.get('ratios', {}).items():
        missing = [k for k in (r.get('num'), r.get('den')) if k not in out]
        if missing:
            sidecar.fail(f'ratio {name!r} refers to {missing}, which are not distances, volumes or earlier ratios')
        try:
            value, unit = ratio(out[r['num']], out[r['den']])
        except ValueError as e:
            sidecar.fail(f'ratio {name!r}: {e}')
        add(name, value, unit, r, num=r['num'], den=r['den'])
    return out, inputs


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--spec', type=sidecar.existing, required=True, help='JSON spec, described above')
    ap.add_argument('--grid', type=sidecar.existing, required=True, help='hu.json (or any sidecar): the grid the points and labels are on')
    ap.add_argument('--out', required=True, help='JSON file to write')
    a = ap.parse_args()
    grid = sidecar.grid(a.grid)
    values, inputs = measure(json.loads(Path(a.spec).read_text()), grid)
    inputs.update({a.grid: sidecar.sha256_file(a.grid), a.spec: sidecar.sha256_file(a.spec)})
    sidecar.emit_values(
        a.out, values, meta={'grid_id': grid['grid_id'], 'spacing_zyx_mm': grid['spacing_zyx_mm'], 'inputs': inputs}
    )


if __name__ == '__main__':
    main()
