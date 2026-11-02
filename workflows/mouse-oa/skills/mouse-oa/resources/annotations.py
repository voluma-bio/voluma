"""Reading an annotations file: the curves an agent traced on slices of one aligned grid, as the scripts that cut regions need them.

Library, not a script: it imports `sidecar` and is imported by name, both through PYTHONPATH.
A file carries the `grid_id` of the grid it was traced on (indices mean nothing on another grid);
curves use the schema of `region_from_curves.py` (core `regions-and-landmarks/SKILL.md`).
"""

import json
from itertools import pairwise
from pathlib import Path

import numpy as np
import sidecar
from region_from_curves import surface_from_curves
from scipy import ndimage as ndi

KEYS = (
    'grid_id', 'growth_plate_curves', 'growth_plate_distal_curves', 'under_plate_curves', 'articular_corrections',
    'width_points_uvw', 'compartment_midpoint_u', 'growth_plate_mid_u', 'height_section_v', 'v_limits', 'plate_patches', 'plate_eroded',
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
    if 'width_points_uvw' in ann:
        for pt in listof('width_points_uvw', ann['width_points_uvw'], 2, 'two [u, v, w] points'):
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
    marks = mapping('plate_eroded', ann.get('plate_eroded', {}), '{"<V>": [{"u": [first, last], "eroded": "<why>"}]}')
    for k, runs in marks.items():
        try:
            section = int(k)
        except ValueError:
            malformed('plate_eroded', f'integer section keys, got "{k}"')
        inside('plate_eroded', 'V section', section, V, 'V')
        for run in listof('plate_eroded', runs, None, f'a list of {{"u": [first, last], "eroded": "<why>"}} marks on section {k}'):
            mapping('plate_eroded', run, f'marks as {{"u": [first, last], "eroded": "<why>"}} on section {k}')
            if 'u' not in run or 'eroded' not in run:
                malformed('plate_eroded', f'every mark on section {k} to have "u": [first, last] and "eroded": "<why>"')
            listof('plate_eroded', run['u'], 2, f'"u": [first, last], the U range where the plate is gone, on section {k}')
            for x in run['u']:
                if isinstance(x, bool) or not isinstance(x, int):
                    malformed('plate_eroded', f'"u": [first, last] with two integers on section {k}')
                inside('plate_eroded', f'section {k}: a U', x, U, 'U')
            if run['u'][0] > run['u'][1]:
                malformed('plate_eroded', f'"u": [first, last] with first <= last on section {k}')
            if not (isinstance(run['eroded'], str) and run['eroded'].strip()):
                malformed('plate_eroded', f'"eroded" on section {k} to say why the plate is gone, as a sentence')
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


def refuse_off_tibia(ann, key, tib, spec_path, vox):
    """Refuse curve points that lie off the tibia: on the section's coronal cut of the tibia mask (axes W, U), farther than the spec's
    `off_tibia_margin_um` (entry plate-faces) from any tibia voxel. A line run across empty space or up a cortical wall's far side is
    an invented face, so the script stops and names the section, the count and the first point."""
    margin = round(sidecar.protocol(spec_path, 'plate-faces', 'off_tibia_margin_um')['off_tibia_margin_um'] / 1000 / vox)
    refused = []
    for k, pts in sorted(ann[key]['slices'].items(), key=lambda kv: int(kv[0])):
        dist = ndi.distance_transform_edt(~tib[:, int(k), :])
        off = [(w, u) for w, u in pts if dist[min(max(round(w), 0), dist.shape[0] - 1), min(max(round(u), 0), dist.shape[1] - 1)] > margin]
        if off:
            refused.append(f'V={k}: {len(off)} of {len(pts)} points, the first at W={off[0][0]:g}, U={off[0][1]:g}')
    if refused:
        shown = '; '.join(refused[:6]) + (f'; and {len(refused) - 6} more sections' if len(refused) > 6 else '')
        sidecar.fail(f'"{key}" has points more than {margin * vox * 1000:.0f} um off the tibia: {shown}. Trace the face on the bone only')


def refuse_gaps(ann, key, tib, spec_path, vox):
    """Refuse a face that leaves bone at plate level untraced. "Bone at plate level" is the tibia within the spec's `max_gap_um`
    (entry plate-faces) of the curve's W at that column. On each traced section, neighbouring points are at most that far apart
    over the section's bone (a span over columns without bone does not count: the notch between the condyles) and the first and last
    point are within it of the bone's ends (past the end points, bone is any tibia within the section's own W band). Across V, traced sections are at most that far apart over the rows where the tibia exists
    at plate level, and the first and last one are within it of those rows' ends. The stop names each stretch."""
    gap = sidecar.protocol(spec_path, 'plate-faces', 'max_gap_um')['max_gap_um'] / 1000 / vox
    um = vox * 1000
    cum = np.concatenate([np.zeros((1, *tib.shape[1:]), np.uint16), np.cumsum(tib, axis=0, dtype=np.uint16)])  # tibia voxels above each W, per (V, U)

    def near_tibia(v, w):
        """Bool over U: tibia on section v within the gap of W `w`."""
        lo, hi = np.clip(np.floor(w - gap), 0, tib.shape[0]).astype(int), np.clip(np.floor(w + gap) + 1, 0, tib.shape[0]).astype(int)
        u = np.arange(tib.shape[2])
        return cum[hi, v, u] > cum[lo, v, u]

    def count_between(mask, a, b):
        """Columns of `mask` strictly between positions a and b."""
        lo, hi = int(np.floor(a)) + 1, int(np.ceil(b))
        return int(mask[lo:hi].sum())

    problems = []
    for k, pts in sorted(ann[key]['slices'].items(), key=lambda kv: int(kv[0])):
        v = int(k)
        pts = np.array(sorted(pts, key=lambda p: p[1]), float)
        bone = near_tibia(v, np.interp(np.arange(tib.shape[2]), pts[:, 1], pts[:, 0]))
        # past the end points the curve has no height: any tibia in the section's own W band counts
        lo, hi = int(max(np.floor(pts[:, 0].min() - gap), 0)), int(np.floor(pts[:, 0].max() + gap)) + 1
        outside = np.arange(tib.shape[2])
        outside = (outside < pts[0, 1]) | (outside > pts[-1, 1])
        bone[outside] = tib[lo:hi, v, :].any(axis=0)[outside]
        cols = np.flatnonzero(bone)
        if not len(cols):
            continue
        us = pts[:, 1]
        for a, b in pairwise(us):
            n = count_between(bone, a, b)
            if n > gap:
                problems.append(f'V={v}: U={a:g}..{b:g} has {n} bone columns between two points')
        if us[0] - cols[0] > gap:
            problems.append(f'V={v}: the first point is at U={us[0]:g}, bone starts at U={cols[0]}')
        if cols[-1] - us[-1] > gap:
            problems.append(f'V={v}: the last point is at U={us[-1]:g}, bone ends at U={cols[-1]}')
    levels = sorted(int(k) for k in ann[key]['slices'])
    H, *_ = surface_from_curves(ann[key], tib.shape)  # callers have run traced_surface, so the spec is valid
    rows = np.array([near_tibia(v, H[v]).any() for v in range(tib.shape[1])])
    where = np.flatnonzero(rows)
    if len(where):
        for a, b in pairwise(levels):
            n = count_between(rows, a, b)
            if n > gap:
                problems.append(f'sections V={a} and V={b} have {n} rows with bone at plate level between them')
        if levels[0] - where[0] > gap:
            problems.append(f'the first traced section is V={levels[0]}, the plate starts at V={where[0]}')
        if where[-1] - levels[-1] > gap:
            problems.append(f'the last traced section is V={levels[-1]}, the plate ends at V={where[-1]}')
    if problems:
        shown = '; '.join(problems[:6]) + (f'; and {len(problems) - 6} more' if len(problems) > 6 else '')
        sidecar.fail(f'"{key}" leaves bone at plate level untraced at more than {gap * um:.0f} um spacing (points on a section, sections in V, '
                     f'or the ends of the bone): {shown}. Trace the plate there ({len(levels)} traced sections: V={levels[0]}..{levels[-1]})')


def eroded_marks(ann, key, shape, on_bone):
    """The worker's `ann["plate_eroded"]` ranges for the curves `key`, which must lie on a section with a curve whose points reach both
    ends of the range (a mark never replaces points; the curve follows the remaining bone through it). Returns (eroded, record):
    `eroded`, bool (V, U): the marked ranges, on the rows between two traced sections where both mark (a face is linear in V between
    traced sections), and `record`, the dict the script reports: the marked ranges with their share of the tibia's width on their
    section, and the eroded share of the footprint `on_bone` over the traced V range."""
    slices = ann[key]['slices']
    reasons = {(int(k), *run['u']): run['eroded'] for k, runs in ann.get('plate_eroded', {}).items() for run in runs}
    refused = []
    marked = {}  # V -> bool U array of the marked ranges on that section
    for v, a, b in sorted(reasons):
        us = [p[1] for p in slices.get(str(v), [])]
        if not us:
            refused.append(f'V={v}, U={a}..{b}: the section has no curve')
        elif min(us) > a or max(us) < b:
            refused.append(f'V={v}, U={a}..{b}: the curve spans only U={min(us):g}..{max(us):g}')
        marked.setdefault(v, np.zeros(shape[2], bool))[a : b + 1] = True
    if refused:
        shown = '; '.join(refused[:6]) + (f'; and {len(refused) - 6} more' if len(refused) > 6 else '')
        sidecar.fail(f'"plate_eroded" marks {len(refused)} range(s) the curves "{key}" do not trace: {shown}. Trace the remaining bone through each marked range')
    sections = sorted(int(k) for k in slices)
    eroded = np.zeros(shape[1:], bool)
    for v in range(sections[0], sections[-1] + 1):
        lo = max(s for s in sections if s <= v)
        hi = min(s for s in sections if s >= v)
        eroded[v] = marked.get(lo, False) & marked.get(hi, False) if lo != hi else marked.get(lo, False)
    eroded &= on_bone
    eroded_runs = [{'v': v, 'u': [a, b], 'reason': r, 'width_fraction': on_bone[v, a : b + 1].sum() / max(on_bone[v].sum(), 1)} for (v, a, b), r in sorted(reasons.items())]
    rows = on_bone[sections[0] : sections[-1] + 1]
    record = {'eroded_stretches': eroded_runs, 'eroded_fraction': float(eroded[sections[0] : sections[-1] + 1].sum() / max(rows.sum(), 1))}
    return eroded, record
