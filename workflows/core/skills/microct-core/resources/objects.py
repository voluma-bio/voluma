"""Placed objects (a mask, a surface, a point, a line) saved as data: one writer and one loader per kind.

An object is an entry in the contract's output blocks (`packages/contracts`, output.ts), each on a named voxel grid, so
`report_output` takes it unchanged. A script that places something prints its entries as `objects` in its result record,
keyed by the output id the workflow declares; the worker passes them to `report_output` as they are:
  mask      {kind: 'structure', structure: {mask: <.npy>, gridId, shapeZyx, offsetZyx}}   uint8 volume, 1 inside, cropped to its
                                                                                           bounding box; its [0,0,0] is at offsetZyx
  surface   {kind: 'surface', surface: {heights: <.npy>, gridId, axis}}                   float32 heights along array `axis` over the
                                                                                           grid's other two axes; NaN = none
  point     {kind: 'annotation', annotation: {gridId, kind: 'point', zyx}}                voxel coordinates (>= 0), fractional allowed
  line      {kind: 'annotation', annotation: {gridId, kind: 'line', aZyx, bZyx}}
  volume    {kind: 'volume', volume: {kind, shapeZyx, affine, unit, gridId, file, dtype}}   an array already on disk that other
                                                                                           objects sit on (a scan, an aligned stack)
`gridId` is the `grid_id` in a sidecar (`sidecar.py`, `frame.py`). Every field name and the mask dtype are constants below: a
change in the contract is one edit here. Paths in an entry are absolute.

Library use (no CLI):
  import objects
  e = objects.surface('face.npy', heights, axis, like='hu.json')           # write the array as used; `like`: a sidecar of its grid
  e = objects.mask('slab.npy', m, like='hu.json', crop=True)               # crop=False keeps the whole grid (offset 0)
  e = objects.point(zyx, grid_id); e = objects.line(a_zyx, b_zyx, grid_id)
  e = objects.volume('tibia-hu.npy', 'tibia-frame.json')                    # kind='image' (unit HU) or 'labels'; header: hu.json or frame.json
  sidecar.emit_values(out_json, values, ..., objects={'slab': e})          # into the result record and stdout
  objects.load(e) -> {'kind', 'grid_id', ...} by kind (below); objects.kind_of(e)
  objects.read_file(record.json) -> {id: entry} of the entries to draw (masks, surfaces, points, lines) in a result record's `objects`
  objects.of_array(path, kind)   # the entry of a mask or surface .npy and its sidecar (offset_zyx there, if cropped)
  objects.dense(loaded_mask, shape)   # the mask on its whole grid
Loaded: mask {path, array (uint8), offset_zyx}; surface {path, heights, axis}; point {zyx}; line {a_zyx, b_zyx}; all with grid_id.
A structure that is a label in a volume, a volume, or a missing output has nothing to draw: load refuses it with a sentence.
"""
import json
from pathlib import Path

import numpy as np
import sidecar

GRID, SHAPE, OFFSET = 'gridId', 'shapeZyx', 'offsetZyx'
KIND, STRUCTURE, SURFACE, ANNOTATION = 'kind', 'structure', 'surface', 'annotation'
MASK, HEIGHTS, AXIS = 'mask', 'heights', 'axis'
POINT, LINE, ZYX, A, B = 'point', 'line', 'zyx', 'aZyx', 'bZyx'
VOLUME, AFFINE, UNIT, FILE, DTYPE = 'volume', 'affine', 'unit', 'file', 'dtype'
MISSING = 'missing'
VOLUME_DTYPES = {'image': ('int16', 'uint16', 'float32'), 'labels': ('uint8', 'uint16')}  # what the viewer loads, by volume kind
MASK_DTYPE = np.uint8  # what the contract says a mask file holds; the loader also reads bool


def _ints(v):
    return [int(n) for n in v]


def _coords(zyx, what):
    v = [float(n) for n in zyx]
    if len(v) != 3 or min(v) < 0:
        sidecar.fail(f'{what} {v}: voxel coordinates are three numbers z,y,x, each 0 or more (map a point into its grid first)')
    return v


def _abs(path):
    return str(Path(path).resolve())


def surface(path, heights, axis, like, where=None, **meta):
    """Save `heights` (float32, NaN where there is no surface) and return its entry. Pass the array the computation used.

    `where` (bool, the heights' shape) says where the surface is on the bone: it is NaN everywhere else, in the one file
    later scripts also read. `meta` (inputs, params, script) goes to the sidecar."""
    path = _abs(path)
    heights = np.asarray(heights, np.float32)
    if where is not None:
        heights = np.where(where, heights, np.float32(np.nan))
    np.save(path, heights)
    sidecar.write(path, like=like, surface_axis=int(axis), **meta)
    return {KIND: SURFACE, SURFACE: {HEIGHTS: path, GRID: sidecar.grid(like)['grid_id'], AXIS: int(axis)}}


def mask(path, m, like, crop=True, **meta):
    """Save the volume `m` (1 inside), cropped to its bounding box when `crop`, and return its entry. An empty mask is refused.

    `meta` (inputs, params, script) goes to the sidecar."""
    path = _abs(path)
    m = np.asarray(m, bool)
    box = tuple(slice(0, n) for n in m.shape)
    if crop:
        found = np.nonzero(m)
        if not len(found[0]):
            sidecar.fail(f'{path}: the mask is empty, so there is nothing to save')
        box = tuple(slice(int(i.min()), int(i.max()) + 1) for i in found)
    np.save(path, m[box].astype(MASK_DTYPE))
    offset = [s.start for s in box]
    sidecar.write(path, like=like, offset_zyx=offset, **meta)
    return {KIND: STRUCTURE, STRUCTURE: {MASK: path, GRID: sidecar.grid(like)['grid_id'], SHAPE: _ints(m[box].shape), OFFSET: offset}}


def point(zyx, grid_id):
    return {KIND: ANNOTATION, ANNOTATION: {GRID: grid_id, KIND: POINT, ZYX: _coords(zyx, 'point')}}


def line(a_zyx, b_zyx, grid_id):
    return {KIND: ANNOTATION, ANNOTATION: {GRID: grid_id, KIND: LINE, A: _coords(a_zyx, 'line end'), B: _coords(b_zyx, 'line end')}}


def volume(path, header, kind='image', unit=None):
    """The entry of a volume already on disk (`path` .npy with its sidecar). `header` is the json that holds the grid's
    `grid_id` and `affine_xyz_to_world_mm`: the scan's hu.json, or an aligned stack's frame.json. `unit` is HU for an
    image unless given, and none for labels."""
    unit = unit or ('HU' if kind == 'image' else None)
    path = _abs(path)
    g = sidecar.grid(header)
    if 'affine_xyz_to_world_mm' not in g:
        sidecar.fail(f'{header} has no affine_xyz_to_world_mm: pass the hu.json that scan-intake wrote, or the frame.json of the stack')
    side = sidecar.grid(sidecar.sidecar_path(path))
    if side['grid_id'] != g['grid_id']:
        sidecar.fail(f'{path} is on grid {side["grid_id"][:12]}..., but {header} is grid {g["grid_id"][:12]}...: pass the header of the array\'s own grid')
    a = np.load(path, mmap_mode='r')
    if kind not in VOLUME_DTYPES or str(a.dtype) not in VOLUME_DTYPES[kind]:
        sidecar.fail(f'{path} is {a.dtype} as a {kind!r} volume: the review loads {VOLUME_DTYPES} (kind: dtypes)')
    return {KIND: VOLUME, VOLUME: {KIND: kind, SHAPE: _ints(a.shape), AFFINE: g['affine_xyz_to_world_mm'], UNIT: unit,
                                   GRID: g['grid_id'], FILE: path, DTYPE: str(a.dtype)}}


def of_array(path, kind):
    """The entry of a mask or surface `.npy` written by a script: grid, offset and axis come from its sidecar."""
    path = _abs(path)
    side = json.loads(sidecar.sidecar_path(path).read_text())
    if 'grid_id' not in side:
        sidecar.fail(f'{sidecar.sidecar_path(path)} has no grid_id: write the array with sidecar.write')
    if kind == SURFACE:
        if 'surface_axis' not in side:
            sidecar.fail(f'{sidecar.sidecar_path(path)} has no surface_axis: write the surface with objects.surface')
        return {KIND: SURFACE, SURFACE: {HEIGHTS: path, GRID: side['grid_id'], AXIS: int(side['surface_axis'])}}
    return {KIND: STRUCTURE, STRUCTURE: {MASK: path, GRID: side['grid_id'], SHAPE: _ints(side['shape']),
                                         OFFSET: _ints(side.get('offset_zyx', [0, 0, 0]))}}


def kind_of(entry):
    """'mask', 'surface', 'point' or 'line'; refuses an entry that has nothing to draw."""
    kind = entry.get(KIND) if isinstance(entry, dict) else None
    if kind == SURFACE:
        return SURFACE
    if kind == STRUCTURE and MASK in entry.get(STRUCTURE, {}):
        return MASK
    if kind == ANNOTATION and entry.get(ANNOTATION, {}).get(KIND) in (POINT, LINE):
        return entry[ANNOTATION][KIND]
    what = {STRUCTURE: 'a structure that is a label in a volume is drawn with --labels',
            VOLUME: 'a volume is a grid the other objects sit on: give it to --hu or --labels',
            MISSING: 'the output was not made'}.get(kind, 'an object is a structure with a mask, a surface, or a point or line annotation')
    sidecar.fail(f'object {json.dumps(entry)[:100]} has nothing to draw: {what}')


def _file(entry):
    """(block, key) of the file a mask or surface entry names; None for an annotation."""
    return {MASK: (STRUCTURE, MASK), SURFACE: (SURFACE, HEIGHTS)}.get(kind_of(entry))


def file_of(entry):
    """The `.npy` an entry names (a mask or a surface), or None."""
    f = _file(entry)
    return entry[f[0]][f[1]] if f else None


def load(entry, grid_shapes=None):
    """What a drawer needs from one entry; see the module docstring for the keys.

    `grid_shapes` ({grid_id: shape}, where known) lets a mask be refused when its crop does not fit its grid."""
    kind = kind_of(entry)
    if kind == MASK:
        b = entry[STRUCTURE]
        a = np.load(b[MASK], mmap_mode='r')
        if a.dtype not in (np.dtype(MASK_DTYPE), np.dtype(bool)):
            sidecar.fail(f'{b[MASK]} is {a.dtype}, not {np.dtype(MASK_DTYPE)}: an object mask is a volume of 0 and 1')
        offset = np.array(b[OFFSET], int)
        grid = (grid_shapes or {}).get(b[GRID])
        if list(a.shape) != list(b[SHAPE]):
            sidecar.fail(f'{b[MASK]} has shape {list(a.shape)} but its entry says {list(b[SHAPE])}: the file and the entry are from different writes')
        if grid is not None and any(o + n > g for o, n, g in zip(offset, a.shape, grid)):
            sidecar.fail(f'{b[MASK]} is {list(a.shape)} at offset {offset.tolist()}, which does not fit its grid {list(grid)}: '
                         'its offset is stale; write the mask again')
        return {KIND: kind, 'grid_id': b[GRID], 'path': b[MASK], 'array': a.view(np.uint8), 'offset_zyx': offset}
    if kind == SURFACE:
        b = entry[SURFACE]
        return {KIND: kind, 'grid_id': b[GRID], 'path': b[HEIGHTS], 'heights': np.load(b[HEIGHTS]).astype(float), 'axis': int(b[AXIS])}
    b = entry[ANNOTATION]
    if kind == POINT:
        return {KIND: kind, 'grid_id': b[GRID], 'zyx': np.array(b[ZYX], float)}
    return {KIND: kind, 'grid_id': b[GRID], 'a_zyx': np.array(b[A], float), 'b_zyx': np.array(b[B], float)}


def read_file(path):
    """{id: entry} of the entries to draw in a result record's `objects` (volumes and missing outputs are left out); a
    relative path in an entry is relative to the record's directory."""
    path = Path(path).resolve()
    d = json.loads(path.read_text())
    objs = d.get('objects') if isinstance(d, dict) else None
    if not isinstance(objs, dict):
        sidecar.fail(f'{path} has no `objects`: pass the result record (<name>.json) of a script that places something')
    objs = {k: e for k, e in objs.items() if e.get(KIND) not in (VOLUME, MISSING)}
    if not objs:
        sidecar.fail(f'{path} has no object to draw: its `objects` are volumes or missing outputs')
    for e in objs.values():
        if f := _file(e):
            e[f[0]][f[1]] = str(path.parent / e[f[0]][f[1]])
    return objs


def dense(loaded, shape):
    """A loaded mask placed on its whole grid, `shape`."""
    out = np.zeros(shape, np.uint8)
    o, a = loaded['offset_zyx'], loaded['array']
    out[tuple(slice(int(i), int(i) + n) for i, n in zip(o, a.shape))] = a
    return out
