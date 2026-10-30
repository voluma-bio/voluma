"""Reading an annotations file: the curves an agent traced on slices of one aligned grid, as the scripts that cut regions need them.

Library, not a script: it imports `sidecar` and is imported by name, both through PYTHONPATH.
A file carries the `grid_id` of the grid it was traced on (indices mean nothing on another grid);
curves use the schema of `region_from_curves.py` (core `regions-and-landmarks/SKILL.md`).
"""

import json
from pathlib import Path

import sidecar
from region_from_curves import surface_from_curves

KEYS = (
    'grid_id', 'growth_plate_curves', 'growth_plate_distal_curves', 'under_plate_curves', 'articular_corrections',
    'width_points_uvw', 'compartment_midpoint_u', 'growth_plate_mid_u', 'height_section_v', 'v_limits', 'plate_patches',
)  # every key check_bounds covers: a script reads no other, so a misspelt optional key cannot silently fall back to its default


def load_annotations(path, grid):
    """Annotations hold indices on one aligned grid; read them only for that grid, and refuse any that are unknown, malformed or outside it.

    `grid` is a dict with `grid_id` and `shape` (W, V, U): a frame, or the sidecar of an array on the grid.
    """
    ann = json.loads(Path(path).read_text())
    if not isinstance(ann, dict):
        sidecar.fail(f'{path} must be a JSON object of annotation keys: known keys are {", ".join(KEYS)}')
    if 'grid_id' not in ann:
        sidecar.fail(f'{path} has no "grid_id": copy the grid_id of the aligned grid you traced on (its frame file) into it')
    if ann['grid_id'] != grid['grid_id']:
        sidecar.fail(f'{path} was traced on another aligned grid (grid_id differs): its indices do not apply here; trace again')
    unknown = [k for k in ann if k not in KEYS]
    if unknown:
        sidecar.fail(f'{path} has unknown key "{unknown[0]}": the known keys are {", ".join(KEYS)}')
    check_bounds(ann, grid['shape'])
    return ann


def check_bounds(ann, shape):
    """Refuse a known key whose value has the wrong form or lies outside the grid; ranges are [start, stop), limits inclusive."""
    W, V, U = shape
    size = f'{W} W x {V} V x {U} U'

    def malformed(key, want):
        sidecar.fail(f'annotations.json "{key}": expected {want}: fix the file')

    def number(key, x, want):
        if isinstance(x, bool) or not isinstance(x, (int, float)):
            malformed(key, want)

    def listof(key, x, n, want):
        if not isinstance(x, list) or (n is not None and len(x) != n):
            malformed(key, want)
        return x

    def mapping(key, x, want):
        if not isinstance(x, dict):
            malformed(key, want)
        return x

    def inside(key, what, value, n, axis, half_open=False):
        if not (0 <= value <= n - (0 if half_open else 1)):
            sidecar.fail(f'annotations.json "{key}": {what} {value:g} is outside the grid ({n} {axis} indices, 0 to {n if half_open else n - 1}; grid is {size}): trace again inside the grid')

    def curves(key, spec):
        mapping(key, spec, 'an object {"axis": …, "slices": …}')
        axis = spec.get('axis')
        if axis not in (0, 1, 2):
            return  # traced_surface and region_from_curves say what a curve spec needs
        rows_ax, cols_ax = [i for i in range(3) if i != axis]
        names = 'WVU'
        slices = mapping(key, spec.get('slices', {}), '"slices" as an object {"<section index>": [[row, column], ...]}')
        for k, pts in slices.items():
            try:
                section = int(k)
            except ValueError:
                malformed(key, f'integer section keys in "slices", got "{k}"')
            inside(key, f'{names[axis]} section', section, shape[axis], names[axis])
            for pt in listof(key, pts, None, f'a list of [row, column] points on section {k}'):
                listof(key, pt, 2, f'[row, column] points with two numbers on section {k}')
                for x in pt:
                    number(key, x, f'[row, column] points with two numbers on section {k}')
                for x, ax in zip(pt, (rows_ax, cols_ax)):
                    inside(key, f'{names[axis]} section {k}: a point with {names[ax]}', x, shape[ax], names[ax])

    def rng(key, x, n, axis):
        listof(key, x, 2, '[start, stop] with two numbers')
        for v in x:
            number(key, v, '[start, stop] with two numbers')
            inside(key, 'bound', v, n, axis, half_open=True)

    def scalar(key, x, n, axis, what='value'):
        number(key, x, 'a number')
        inside(key, what, x, n, axis)

    for key in ('growth_plate_curves', 'growth_plate_distal_curves', 'under_plate_curves'):
        if key in ann:
            curves(key, ann[key])
    fixes = listof('articular_corrections', ann.get('articular_corrections', []), None, 'a list of {"u_range", "v_range", "curves"}')
    for fix in fixes:
        mapping('articular_corrections', fix, 'each correction as {"u_range", "v_range", "curves"}')
        for name in ('u_range', 'v_range', 'curves'):
            if name not in fix:
                malformed('articular_corrections', f'each correction to have "{name}"')
        curves('articular_corrections[].curves', fix['curves'])
        rng('articular_corrections[].u_range', fix['u_range'], U, 'U')
        rng('articular_corrections[].v_range', fix['v_range'], V, 'V')
    for pt in listof('width_points_uvw', ann.get('width_points_uvw', []), None, 'a list of [u, v, w] points'):
        listof('width_points_uvw', pt, 3, '[u, v, w] points with three numbers')
        for key, x, n, axis in zip('UVW', pt, (U, V, W), 'UVW'):
            number('width_points_uvw', x, '[u, v, w] points with three numbers')
            inside('width_points_uvw', f'a point with {key}', x, n, axis)
    for side, u in mapping('compartment_midpoint_u', ann.get('compartment_midpoint_u', {}), '{"lateral": U, "medial": U}').items():
        scalar('compartment_midpoint_u', u, U, 'U', f'{side} U')
    for key, n, axis in (('growth_plate_mid_u', U, 'U'), ('height_section_v', V, 'V')):
        if key in ann:
            scalar(key, ann[key], n, axis)
    if 'v_limits' in ann:
        for x in listof('v_limits', ann['v_limits'], 2, '[first V, last V] with two numbers'):
            scalar('v_limits', x, V, 'V', 'limit')
    patches = mapping('plate_patches', ann.get('plate_patches', {}), '{"medial": {"u": [lo, hi], "v": [lo, hi]}, "lateral": {...}}')
    for side, patch in patches.items():
        mapping(f'plate_patches.{side}', patch, '{"u": [lo, hi], "v": [lo, hi]}')
        for key, n, axis in (('u', U, 'U'), ('v', V, 'V')):
            if key not in patch:
                malformed(f'plate_patches.{side}', f'"{key}": [lo, hi]')
            rng(f'plate_patches.{side}.{key}', patch[key], n, axis)


def need(ann, key, hint):
    if key not in ann:
        sidecar.fail(f'annotations.json has no "{key}": {hint}')
    return ann[key]


def traced_surface(spec, key, shape):
    """W index per (V, U) from curves in region_from_curves' schema, traced on coronal sections (axis 1, height = row)."""
    if spec.get('axis') != 1 or spec.get('height', 'row') != 'row':
        sidecar.fail(f'"{key}" must be traced on coronal sections of the aligned stack: {{"axis": 1, "height": "row", "slices": '
                     '{"<v>": [[w, u], ...]}} (a point is [row = W, column = U])')
    if len(spec.get('slices', {})) < 2:
        sidecar.fail(f'"{key}" needs curves on at least two coronal sections (V indices): trace more sections')
    H, *_, valid = surface_from_curves(spec, shape)
    return H, valid
