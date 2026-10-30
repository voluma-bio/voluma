"""Sidecar JSON for arrays: the shared half of the resource contract, and a CLI for arrays you write yourself.

Every `.npy` a resource writes has `<name>.json` beside it:
  grid_id          which voxel grid the array lives on (the scan's, or an oriented stack's own)
  shape, dtype     of the array
  spacing_zyx_mm   voxel size in mm, axes in array order
  inputs           {path: sha256} of every file the array was computed from
  params           the parameters that produced it
  offset_zyx       only on a cropped array: the index on the grid of its [0, 0, 0] (`objects.mask`, the morphometry maps)
  surface_axis     only on a surface: the array axis its heights are measured along (`objects.surface`)
`write` owns the keys above: it writes `offset_zyx` and `surface_axis` when given and removes a stale one when not. A sidecar that
already exists keeps its other keys (`segment_sam` puts its prompts, per-object confidence and its own `axis`, the one it sliced along, in the same file).

Library use (other resources import this file):
  import sidecar
  sidecar.write(out_npy, like='hu.json', inputs=[hu_path], params={...})   # same grid as `like`
  sidecar.write(out_npy, grid_id=new_id, spacing_zyx_mm=[...], inputs=[...], params={...})   # a new grid
  sidecar.grid(path)       # the grid fields (grid_id, spacing_zyx_mm, and shape when the file has one) of a sidecar or an intake header
  sidecar.bone_threshold_hu(header, override)   # the lab's measurement threshold in this scan's HU, or the override
  sidecar.emit(**fields)   # print the one JSON line a resource prints to stdout (fails on NaN)
  sidecar.value(v, unit, definition, kind='measurement', **provenance)   # one entry of a result record
  sidecar.emit_values(out_json, values, meta=None, objects=None, **fields)   # write the result record, print it (below)
  sidecar.save_image(fig, path)  # the image limits below, JPEG
  sidecar.load_points(paths, grid_id)   # {name: [z, y, x]} merged from points files (`pick.py` writes one per view); refuses another grid
  sidecar.fail(sentence)   # print a sentence the agent can act on to stderr and exit 2
  sidecar.parser(__doc__)  # the argparse parser every resource uses: the docstring is the `--help` text, defaults appended;
                           # any argument error is one sentence on stderr and exit 2
  ap.add_argument('--hu', type=sidecar.existing)   # an input file or directory: refused after parsing, before anything is written

Result record: every script that reports numbers writes `{"values": {id: {value, unit, definition, kind, ...}}, ...meta}`
to its JSON file and prints `{"out": path, "values": {id: {value, unit, definition, kind}}, ...}` (values rounded to 6 decimals).
A script that places something (`objects.py`) adds `"objects": {id: entry}` to the record and to what it prints; `quad_view.py
--objects` takes the record.
`id` is the output id the caller asks for (a flag or a spec key; the workflow's `outputs.json` binds to it), `kind` is
`measurement` or `diagnostic` (a number that helps judge a measurement but is not one), and `value` may be null.

CLI (for an array you made yourself):
  python sidecar.py --array out.npy --like hu.json [--input a.npy ...] [--param key=value ...]
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

MAX_IMAGE_PX = 2000  # view_image's limit; larger images may be rejected or resized
MAX_IMAGE_BYTES = 1 << 20  # view_image refuses files over 1 MiB, and every image is resent with later requests
JPEG_QUALITIES = (85, 75, 65)  # `save_image` tries each until the file is under the limit


class HelpFormatter(argparse.RawDescriptionHelpFormatter, argparse.ArgumentDefaultsHelpFormatter):
    """Keeps the docstring's layout and appends `(default: X)` to an option that has a real default."""

    def _get_help_string(self, action):
        if action.default is None or action.default is False:
            return action.help
        return super()._get_help_string(action)


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        fail(message)  # one sentence, not argparse's usage text and prog prefix

    def parse_known_args(self, args=None, namespace=None):
        # argparse reads `--window -500,6000` as a flag followed by another flag. Join an option that takes exactly
        # one value with the token after it (`--window=-500,6000`), unless that token is itself an option of this parser.
        args = sys.argv[1:] if args is None else list(args)
        one_value = {o for act in self._actions if act.nargs is None for o in act.option_strings}
        known = {o for act in self._actions for o in act.option_strings}
        joined, i = [], 0
        while i < len(args):
            if args[i] == '--':
                joined += args[i:]
                break
            if args[i] in one_value and i + 1 < len(args) and args[i + 1] not in known and args[i + 1] != '--':
                joined.append(f'{args[i]}={args[i + 1]}')
                i += 2
            else:
                joined.append(args[i])
                i += 1
        return super().parse_known_args(joined, namespace)


def existing(path):
    """`type=` of an argument that names an input: a path that must exist (a file or a directory)."""
    if not Path(path).exists():
        raise argparse.ArgumentTypeError(f'{path} does not exist')
    return path


def parser(doc, **kwargs):
    """The parser of a resource: `doc` is its module docstring, printed whole by `--help`. Options are never abbreviated,
    so a flag's missing value cannot swallow an abbreviated flag (`--out --h`) as that value."""
    return _Parser(description=doc, formatter_class=HelpFormatter, allow_abbrev=False, **kwargs)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 22), b''):
            h.update(chunk)
    return h.hexdigest()


def sidecar_path(array_path):
    return Path(array_path).with_suffix('.json')


def grid(path):
    """grid_id and spacing_zyx_mm (and the shape and `affine_xyz_to_world_mm`, when the file has them) from a sidecar or an intake header."""
    d = json.loads(Path(path).read_text())
    if 'grid_id' not in d or 'spacing_zyx_mm' not in d:
        fail(f'{path} has no grid_id/spacing_zyx_mm: pass the hu.json that scan-intake wrote, or an array sidecar')
    shape = d.get('shape', d.get('shape_zyx'))
    affine = d.get('affine_xyz_to_world_mm')
    return {'grid_id': d['grid_id'], 'spacing_zyx_mm': d['spacing_zyx_mm'], **({'shape': shape} if shape else {}),
            **({'affine_xyz_to_world_mm': affine} if affine else {})}


LAB_BONE_MU_PER_CM = 2.16  # the lab's bone threshold, as a Scanco linear attenuation coefficient


def bone_threshold_hu(header, override=None):
    """The bone threshold every BV, BV/TV and TV measurement uses: `override` if given, else the lab's 2.16/cm in HU.

    HU = 1000 * (mu / mu_water - 1), with mu_water from the `calibration` block scan-intake wrote into hu.json (2459.9 HU
    at mu_water 0.6243/cm). Another scanner or energy gives another HU value for the same 2.16/cm, so there is no literal.
    This is the measurement threshold; the 2500 HU used to build segmentation masks is a separate, passed-in choice.
    """
    if override is not None:
        return float(override)
    cal = json.loads(Path(header).read_text()).get('calibration', {}) if header else {}
    if not header:
        fail('the bone threshold needs the scan\'s hu.json for its calibration (--hu-json), or an explicit --threshold in HU')
    if 'mu_water_per_cm' not in cal:
        fail(f'{header} has no Scanco calibration (mu_water_per_cm), so the lab threshold of {LAB_BONE_MU_PER_CM}/cm cannot be '
             'converted to HU: pass the threshold explicitly with --threshold and say where it came from')
    return round(1000 * (LAB_BONE_MU_PER_CM / cal['mu_water_per_cm'] - 1), 3)


def derived_grid_id(parent_grid_id, frame):
    """Id for a grid defined by a transform of another grid (an oriented stack): hash of the parent id and the frame."""
    blob = json.dumps({'parent': parent_grid_id, 'frame': frame}, sort_keys=True, default=float)
    return hashlib.sha256(blob.encode()).hexdigest()


def write(array_path, *, like=None, grid_id=None, spacing_zyx_mm=None, inputs=(), params=None, script=None, offset_zyx=None,
          surface_axis=None):
    """Write the sidecar of `array_path`, beside the keys of an existing one that this function does not own."""
    if like is not None:
        g = grid(like)
        grid_id, spacing_zyx_mm = g['grid_id'], g['spacing_zyx_mm']
    if grid_id is None:
        fail('sidecar.write needs `like` or a grid_id')
    a = np.load(array_path, mmap_mode='r')
    meta = {
        'grid_id': grid_id, 'shape': list(a.shape), 'dtype': str(a.dtype), 'spacing_zyx_mm': spacing_zyx_mm,
        'inputs': {str(p): sha256_file(p) for p in inputs}, 'params': params or {},
        'script': script or Path(sys.argv[0]).name,
        **({'offset_zyx': [int(i) for i in offset_zyx]} if offset_zyx is not None else {}),
        **({'surface_axis': int(surface_axis)} if surface_axis is not None else {}),
    }
    out = sidecar_path(array_path)
    if out.exists():  # segment_sam writes its own <labels>.json (prompt, per-object confidence): keep its keys
        old = {k: v for k, v in json.loads(out.read_text()).items() if k not in ('offset_zyx', 'surface_axis')}  # positional: never stale
        meta = {**old, **meta}
    out.write_text(json.dumps(meta, indent=1, default=float) + '\n')
    return out


def load_points(paths, grid_id):
    """{name: [z, y, x]} merged from points files (a path, or a list of them: `pick.py` writes one per view).

    A file is `{"grid_id": ..., "points": [{"name": ..., "zyx": [z, y, x]}, ...]}` (more keys per point are fine). Indices mean
    nothing on another grid, so a file without a `grid_id`, or made on a grid other than `grid_id` (the one the caller is working
    on), is refused; so is a name that two files both hold."""
    point = '{"name": "a", "zyx": [z, y, x]}'
    shape = f'{{"grid_id": "<grid>", "points": [{point}, ...]}}'
    merged, source = {}, {}
    for path in [paths] if isinstance(paths, (str, Path)) else paths:
        d = json.loads(Path(path).read_text())
        if not isinstance(d, dict) or not isinstance(d.get('points'), list):
            fail(f'{path} is not a points file: it is {shape}')
        if 'grid_id' not in d:
            fail(f'{path} has no "grid_id": add the grid_id of the grid the indices are on (the scan\'s is in hu.json)')
        if d['grid_id'] != grid_id:
            fail(f'{path} is on another grid than {grid_id[:12]}... (its grid_id is {str(d["grid_id"])[:12]}...): its indices do not '
                 'apply here. Map it with `python <orient-joint>/resources/map_points.py --frame frame.json --points-file '
                 f'{path} --out <new>.json` when the frame links the two grids, or pick the points again')
        for p in d['points']:
            zyx = p.get('zyx') if isinstance(p, dict) else None
            if not (isinstance(p, dict) and isinstance(p.get('name'), str) and isinstance(zyx, list) and len(zyx) == 3
                    and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in zyx)):
                fail(f'{path} has a malformed point, {json.dumps(p)[:80]}: each is {point}, with three numbers in zyx')
            if p['name'] in merged:
                fail(f'point "{p["name"]}" is in both {source[p["name"]]} and {path}: give each point one name')
            merged[p['name']], source[p['name']] = zyx, path
    return merged


def emit(**fields):
    """Print the one JSON line a resource prints. NaN and infinity are not JSON: a value that is one is a failure."""
    try:
        line = json.dumps(fields, default=float, allow_nan=False)
    except ValueError:
        bad = [k for k, v in fields.items() if _has_nonfinite(v)]
        fail(f'{sys.argv[0]} computed a NaN or infinite value ({", ".join(bad)}): the input does not support this measurement')
    print(line)


def value(v, unit, definition, kind='measurement', **provenance):
    """One entry of a result record. `provenance` (points, labels, ...) goes in the file, not on stdout."""
    return dict(value=None if v is None else float(v), unit=unit, definition=definition, kind=kind, **provenance)


def emit_values(out_json, values, meta=None, objects=None, **fields):
    """Write the result record to `out_json` and print it, with `fields` (paths of what the script wrote) beside it.

    `objects` ({id: entry} from `objects.py`) goes in the record and on stdout, so a caller passes the record, never retypes it."""
    record = {'values': values, **(meta or {}), **({'objects': objects} if objects else {})}
    try:
        text = json.dumps(record, indent=1, default=float, allow_nan=False)
    except ValueError:
        bad = [k for k, v in values.items() if _has_nonfinite(v)]
        fail(f'{sys.argv[0]} computed a NaN or infinite value ({", ".join(bad)}): the input does not support this measurement')
    Path(out_json).write_text(text + '\n')
    brief = {k: {'value': None if v['value'] is None else round(v['value'], 6), 'unit': v['unit'], 'definition': v['definition'],
                 'kind': v['kind']} for k, v in values.items()}
    emit(out=str(out_json), **fields, values=brief, **({'objects': objects} if objects else {}))


def _has_nonfinite(v):
    if isinstance(v, dict):
        return any(_has_nonfinite(x) for x in v.values())
    if isinstance(v, (list, tuple)):
        return any(_has_nonfinite(x) for x in v)
    return isinstance(v, float) and not np.isfinite(v)


def fail(sentence):
    print(sentence, file=sys.stderr)
    sys.exit(2)


def save_image(fig, path, dpi=100):
    """Save a matplotlib figure as the image the agent will open: JPEG, at most 2000 px a side and 1 MiB.

    A JPEG that is over 1 MiB is saved again at quality 75, then 65 (noisy CT panes at q85 can exceed it). Use a .png path
    only for a small crop where exact colours matter. Fails with a sentence if the figure cannot be made to fit.
    """
    path = Path(path)
    w, h = fig.get_size_inches() * dpi
    if max(w, h) > MAX_IMAGE_PX:
        fail(f'{path.name} would be {w:.0f}x{h:.0f} px, over the {MAX_IMAGE_PX} px limit: use a smaller figure size')
    if path.suffix.lower() not in ('.jpg', '.jpeg'):
        fig.savefig(path, dpi=dpi)
    else:
        for q in JPEG_QUALITIES:
            fig.savefig(path, dpi=dpi, pil_kwargs={'quality': q})
            if path.stat().st_size <= MAX_IMAGE_BYTES:
                break
    save_checked(path)


def save_checked(path):
    """Fail if an image on disk is over the size or pixel limits."""
    from PIL import Image
    w, h = Image.open(path).size
    size = Path(path).stat().st_size
    if max(w, h) > MAX_IMAGE_PX or size > MAX_IMAGE_BYTES:
        Path(path).unlink()  # an over-limit image is no output: leave none behind
        fail(f'{path} is {w}x{h}, {size} bytes: over the {MAX_IMAGE_PX} px / 1 MiB limit; render fewer or smaller panels')


def _value(s):
    try:
        return json.loads(s)
    except ValueError:
        return s


if __name__ == '__main__':
    ap = parser(__doc__)
    ap.add_argument('--array', required=True)
    ap.add_argument('--like', required=True, help='hu.json or another sidecar: the grid this array is on')
    ap.add_argument('--input', action='append', default=[])
    ap.add_argument('--param', action='append', default=[], help='key=value')
    a = ap.parse_args()
    params = {k: _value(v) for k, v in (p.split('=', 1) for p in a.param)}
    out = write(a.array, like=a.like, inputs=a.input, params=params, script='sidecar.py')
    emit(sidecar=str(out))
