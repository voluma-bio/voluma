"""Reading an annotations file: the curves an agent traced on slices of one aligned grid, as the scripts that cut regions need them.

Library, not a script: it imports `sidecar` and is imported by name, both through PYTHONPATH.
A file carries the `grid_id` of the grid it was traced on (indices mean nothing on another grid);
curves use the schema of `region_from_curves.py` (../SKILL.md).
"""

import json
from pathlib import Path

import sidecar
from region_from_curves import surface_from_curves


def load_annotations(path, grid):
    """Annotations hold indices on one aligned grid; read them only for that grid, and refuse any that fall outside it.

    `grid` is a dict with `grid_id` and `shape` (W, V, U): a frame, or the sidecar of an array on the grid.
    """
    ann = json.loads(Path(path).read_text())
    if 'grid_id' not in ann:
        sidecar.fail(f'{path} has no "grid_id": copy the grid_id of the aligned grid you traced on (its frame file) into it')
    if ann['grid_id'] != grid['grid_id']:
        sidecar.fail(f'{path} was traced on another aligned grid (grid_id differs): its indices do not apply here; trace again')
    check_bounds(ann, grid['shape'])
    return ann


def check_bounds(ann, shape):
    """Refuse a section, point or range of the known keys that lies outside the grid; ranges are [start, stop), limits inclusive."""
    W, V, U = shape
    size = f'{W} W x {V} V x {U} U'

    def inside(key, what, value, n, axis, half_open=False):
        if not (0 <= value <= n - (0 if half_open else 1)):
            sidecar.fail(f'annotations.json "{key}": {what} {value:g} is outside the grid ({n} {axis} indices, 0 to {n - 1}; grid is {size}): trace again inside the grid')

    def curves(key, spec):
        axis = spec.get('axis')
        if axis not in (0, 1, 2):
            return  # traced_surface and region_from_curves say what a curve spec needs
        rows_ax, cols_ax = [i for i in range(3) if i != axis]
        names = 'WVU'
        for k, pts in spec.get('slices', {}).items():
            inside(key, f'{names[axis]} section', int(k), shape[axis], names[axis])
            for row, col in pts:
                inside(key, f'{names[axis]} section {k}: a point with {names[rows_ax]}', row, shape[rows_ax], names[rows_ax])
                inside(key, f'{names[axis]} section {k}: a point with {names[cols_ax]}', col, shape[cols_ax], names[cols_ax])

    for key in ('growth_plate_curves', 'growth_plate_distal_curves', 'under_plate_curves'):
        if key in ann:
            curves(key, ann[key])
    for fix in ann.get('articular_corrections', []):
        curves('articular_corrections[].curves', fix['curves'])
        for key, n, axis in (('u_range', U, 'U'), ('v_range', V, 'V')):
            for x in fix[key]:
                inside(f'articular_corrections[].{key}', 'bound', x, n, axis, half_open=True)
    for u, v, w in ann.get('width_points_uvw', []):
        for key, x, n, axis in (('U', u, U, 'U'), ('V', v, V, 'V'), ('W', w, W, 'W')):
            inside('width_points_uvw', f'a point with {key}', x, n, axis)
    for side, u in ann.get('compartment_midpoint_u', {}).items():
        inside('compartment_midpoint_u', f'{side} U', u, U, 'U')
    for key, n, axis in (('growth_plate_mid_u', U, 'U'), ('height_section_v', V, 'V')):
        if key in ann:
            inside(key, 'value', ann[key], n, axis)
    for x in ann.get('v_limits', []):
        inside('v_limits', 'limit', x, V, 'V')
    for side, patch in ann.get('plate_patches', {}).items():
        for key, n, axis in (('u', U, 'U'), ('v', V, 'V')):
            for x in patch[key]:
                inside(f'plate_patches.{side}.{key}', 'bound', x, n, axis, half_open=True)


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
