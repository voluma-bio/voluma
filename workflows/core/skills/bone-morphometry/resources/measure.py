"""Compute the protocol's distances, label volumes and ratios, in mm and mm³, with definitions and inputs.

`--spec` is the workflow's protocol.json (keyed by output id); `--output` lists the outputs to compute, and each is built from its
spec entry, which holds (and may add "kind": "diagnostic" for a number that is not a deliverable):
  {"points": ["a", "b"], "ruler": "dfl-ruler", "definition": "..."}    distance between two named points of --points; "ruler" is the
                                                                        output id of the line drawn between them (an object)
  {"num": "<output id>", "den": "<output id>", "definition": "..."}    a ratio of two outputs listed before it in --output
  {"definition": "..."}                                                 a label volume: the voxels of the labels of the structures the
                                                                        output is `on` in --outputs (outputs.json), counted in --labels
                                                                        (that structures' `grid`, the labels volume, is the object)
Points are voxel indices on the grid of --grid (fractions allowed). A ratio's unit is "1" when both values share a unit, else
"<num unit>/<den unit>". Refused: an output the spec lacks, a point or labels file not given, a point missing from
the files, a label volume whose output is not `on` structures with a label, a ratio naming an output not computed before it, a zero denominator.
The record format is in `microct-core/resources/sidecar.py`.

Writes: <out>  the result record {values: {id: {value, unit, definition, kind, ...}}, objects, grid_id, spacing_zyx_mm, inputs}
Prints: one JSON line {out, values: {id: {value, unit, definition, kind}}, objects}
Example: python measure.py --spec protocol.json --outputs outputs.json --output patella-volume --labels labels.npy --grid hu.json --out measurements.json
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


def structure_labels(oid, declared):
    """(label ids, labels-volume id) of the structures the output `oid` is `on`, from outputs.json's list `declared`."""
    by_id = {o["id"]: o for o in declared}
    structs = [by_id.get(s, {}) for s in by_id.get(oid, {}).get("on", [])]
    if not structs or any("label" not in s for s in structs) or len({s["grid"] for s in structs}) != 1:
        sidecar.fail(f"{oid}: it is neither a distance nor a ratio, and in --outputs it is not `on` structures with a label on one labels volume")
    return [s["label"] for s in structs], structs[0]["grid"]


def measure(spec_path, outputs, grid_path, labels=None, points=None, declared=None):
    """Values, input hashes and objects of `outputs` (ids of the spec at `spec_path`), on the grid of `grid_path`; `labels` is a .npy path, `points` {name: zyx}, `declared` outputs.json's list."""
    grid = sidecar.grid(grid_path)
    sp = grid['spacing_zyx_mm']
    out, inputs, placed = {}, {}, {}
    for oid in outputs:
        e = sidecar.protocol(spec_path, oid)
        kind = e.get('kind', 'measurement')
        if 'points' in e:
            missing = [n for n in e['points'] if n not in (points or {})]
            if missing:
                sidecar.fail(f'{oid}: no point named {missing} in the points files given')
            p = [points[n] for n in e['points']]
            try:
                value, unit, extra = distance_mm(p, sp), 'mm', {'points_zyx': p}
            except ValueError as err:
                sidecar.fail(f'{oid}: {err}')
            if 'ruler' in e:
                placed[e['ruler']] = objects.line(p[0], p[1], grid['grid_id'])
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
            if not labels or declared is None:
                sidecar.fail(f'{oid} counts label voxels: pass --labels and --outputs')
            ids, volume = structure_labels(oid, declared)
            inputs[labels] = sidecar.sha256_file(labels)
            value, unit, extra = volume_mm3(np.load(labels, mmap_mode='r'), ids, sp), 'mm³', {'labels': ids}
            placed[volume] = objects.volume(labels, grid_path, kind='labels')
        out[oid] = sidecar.value(value, unit, e.get('definition', ''), kind, **extra)
    return out, inputs, placed


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--spec', type=sidecar.existing, required=True, help="the workflow's protocol.json")
    ap.add_argument('--output', nargs='+', required=True, metavar='ID', help='output ids to compute, in this order (a ratio after the values it divides)')
    ap.add_argument('--outputs', type=sidecar.existing, help="the workflow's outputs.json: says which structures (and so which label ids) a label volume is on")
    ap.add_argument('--grid', type=sidecar.existing, required=True, help='hu.json (or any sidecar): the grid the points and labels are on')
    ap.add_argument('--labels', type=sidecar.existing, help='labels.npy on --grid, for the label volumes (its sidecar beside it)')
    ap.add_argument('--points', type=sidecar.existing, nargs='+', help='points files on --grid that hold the named points (the points.json files pick.py writes)')
    ap.add_argument('--out', required=True, help='JSON file to write')
    a = ap.parse_args()
    declared = json.loads(Path(a.outputs).read_text()) if a.outputs else None
    grid = sidecar.grid(a.grid)
    points = sidecar.load_points(a.points, grid['grid_id']) if a.points else None
    values, inputs, placed = measure(a.spec, a.output, a.grid, a.labels, points, declared)
    inputs.update({a.grid: sidecar.sha256_file(a.grid), a.spec: sidecar.sha256_file(a.spec)})
    sidecar.emit_values(
        a.out, values, objects=placed, meta={'grid_id': grid['grid_id'], 'spacing_zyx_mm': grid['spacing_zyx_mm'], 'inputs': inputs}
    )


if __name__ == '__main__':
    main()
