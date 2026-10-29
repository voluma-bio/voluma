"""Placed objects (a mask, a surface, a point, a line) saved as data: one writer and one loader per kind.

An object is an entry in the shapes the review screen reads (`packages/contracts`, output.ts), each on a named voxel grid:
  mask      {mask: <.npy>, gridId, shapeZyx, offsetZyx}   a bool volume cropped to its bounding box; its [0,0,0] is at offsetZyx on the grid
  surface   {heights: <.npy>, gridId, axis}               float32 heights along array `axis` over the grid's other two axes; NaN = none
  point     {kind: 'point', zyx, gridId}                  voxel coordinates on the grid, fractional allowed
  line      {kind: 'line', aZyx, bZyx, gridId}
`gridId` is the `grid_id` in a sidecar (`sidecar.py`, `frame.py`). Every field name is a constant below: a rename in the contract is
one edit here. Files are paths; the harness's `report_output` turns them into file refs.

Library use (no CLI):
  import objects
  e = objects.surface('face.npy', heights, axis, like='hu.json')           # write the array as used; `like`: a sidecar of its grid
  e = objects.mask('slab.npy', m, like='hu.json', crop=True)               # crop=False keeps the whole grid (offset 0)
  e = objects.point(zyx, grid_id); e = objects.line(a_zyx, b_zyx, grid_id)
  sidecar.emit_values(out_json, values, ..., objects={'slab': e})          # printed beside `values`, passed to report_output unchanged
  objects.load(e) -> {'kind', 'grid_id', ...} by kind (below); objects.kind_of(e); objects.read_file(F.json) -> {id: entry}; load_file -> {id: loaded}
  objects.of_array(path, kind)   # the entry of a mask or surface .npy and its sidecar (offset_zyx there, if cropped)
  objects.dense(loaded_mask, shape)   # the mask on its whole grid
Loaded: mask {array (uint8 view), offset_zyx}; surface {heights, axis}; point {zyx}; line {a_zyx, b_zyx}; all with grid_id.
A structure that is a label in a volume, or reported missing, has no data here: load refuses it with a sentence.
"""
import json
from pathlib import Path

import numpy as np
import sidecar

GRID, SHAPE, OFFSET = 'gridId', 'shapeZyx', 'offsetZyx'
MASK, HEIGHTS, AXIS = 'mask', 'heights', 'axis'
KIND, POINT, LINE, ZYX, A, B = 'kind', 'point', 'line', 'zyx', 'aZyx', 'bZyx'
SURFACE = 'surface'


def _ints(v):
    return [int(n) for n in v]


def _floats(v):
    return [float(n) for n in v]


def surface(path, heights, axis, like):
    """Save `heights` (float32, NaN where there is no surface) and return its entry. Pass the array the computation used."""
    h = np.asarray(heights, np.float32)
    np.save(path, h)
    sidecar.write(path, like=like, axis=int(axis))
    return {HEIGHTS: str(path), GRID: sidecar.grid(like)['grid_id'], AXIS: int(axis)}


def mask(path, m, like, crop=True):
    """Save the bool volume `m`, cropped to its bounding box when `crop`, and return its entry. An empty mask is refused."""
    m = np.asarray(m, bool)
    box = tuple(slice(0, n) for n in m.shape)
    if crop:
        found = np.nonzero(m)
        if not len(found[0]):
            sidecar.fail(f'{path}: the mask is empty, so there is nothing to save')
        box = tuple(slice(int(i.min()), int(i.max()) + 1) for i in found)
    np.save(path, m[box])
    offset = [s.start for s in box]
    sidecar.write(path, like=like, offset_zyx=offset)
    return {MASK: str(path), GRID: sidecar.grid(like)['grid_id'], SHAPE: _ints(m[box].shape), OFFSET: offset}


def point(zyx, grid_id):
    return {KIND: POINT, ZYX: _floats(zyx), GRID: grid_id}


def line(a_zyx, b_zyx, grid_id):
    return {KIND: LINE, A: _floats(a_zyx), B: _floats(b_zyx), GRID: grid_id}


def of_array(path, kind):
    """The entry of a mask or surface `.npy` written by a script: grid, offset and axis come from its sidecar."""
    side = json.loads(sidecar.sidecar_path(path).read_text())
    if 'grid_id' not in side:
        sidecar.fail(f'{sidecar.sidecar_path(path)} has no grid_id: write the array with sidecar.write')
    if kind == SURFACE:
        return {HEIGHTS: str(path), GRID: side['grid_id'], AXIS: int(side.get('axis', 0))}
    offset = _ints(side.get('offset_zyx', [0, 0, 0]))
    return {MASK: str(path), GRID: side['grid_id'], SHAPE: _ints(side['shape']), OFFSET: offset}


def kind_of(entry):
    """'mask', 'surface', 'point' or 'line'; refuses an entry that has nothing to draw."""
    if not isinstance(entry, dict) or GRID not in entry:
        sidecar.fail(f'an object entry is a dict with a {GRID}: {json.dumps(entry)[:100]}')
    if MASK in entry:
        return MASK
    if HEIGHTS in entry:
        return SURFACE
    if entry.get(KIND) in (POINT, LINE):
        return entry[KIND]
    sidecar.fail(f'object {json.dumps(entry)[:100]} has no data to draw (a mask, heights, a point or a line): a structure that is a '
                 'label in a volume is drawn with --labels, and a missing one has nothing to draw')


def load(entry):
    """What a drawer needs from one entry; see the module docstring for the keys."""
    kind = kind_of(entry)
    out = {KIND: kind, 'grid_id': entry[GRID]}
    if kind == MASK:
        a = np.load(entry[MASK], mmap_mode='r')
        if a.dtype != bool:
            sidecar.fail(f'{entry[MASK]} is {a.dtype}, not bool: an object mask is a boolean volume')
        return {**out, 'array': a.view(np.uint8), 'offset_zyx': np.array(entry[OFFSET], int)}
    if kind == SURFACE:
        return {**out, 'heights': np.load(entry[HEIGHTS]).astype(float), 'axis': int(entry[AXIS])}
    if kind == POINT:
        return {**out, 'zyx': np.array(entry[ZYX], float)}
    return {**out, 'a_zyx': np.array(entry[A], float), 'b_zyx': np.array(entry[B], float)}


def read_file(path):
    """{id: entry} from a JSON file: the `objects` a script printed."""
    d = json.loads(Path(path).read_text())
    if not isinstance(d, dict) or not d:
        sidecar.fail(f'{path} is not a file of objects: it is {{"<id>": <entry>, ...}}, the `objects` a script printed')
    return d


def load_file(path):
    """{id: loaded} from a JSON file of {id: entry}."""
    return {k: load(v) for k, v in read_file(path).items()}


def dense(loaded, shape):
    """A loaded mask placed on its whole grid, `shape`."""
    out = np.zeros(shape, np.uint8)
    o, a = loaded['offset_zyx'], loaded['array']
    out[tuple(slice(int(i), int(i) + n) for i, n in zip(o, a.shape))] = a
    return out
