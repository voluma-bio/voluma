"""Sidecar JSON for arrays: the shared half of the resource contract, and a CLI for arrays you write yourself.

Every `.npy` a resource writes has `<name>.json` beside it:
  grid_id          which voxel grid the array lives on (the scan's, or an oriented stack's own)
  shape, dtype     of the array
  spacing_zyx_mm   voxel size in mm, axes in array order
  inputs           {path: sha256} of every file the array was computed from
  params           the parameters that produced it
A sidecar that already exists keeps its other keys (`segment_sam` puts its prompts and per-object confidence in the same file).

Library use (other resources import this file):
  import sidecar
  sidecar.write(out_npy, like='hu.json', inputs=[hu_path], params={...})   # same grid as `like`
  sidecar.write(out_npy, grid_id=new_id, spacing_zyx_mm=[...], inputs=[...], params={...})   # a new grid
  sidecar.grid(path)       # the grid fields (grid_id, spacing_zyx_mm) of a sidecar or an intake header
  sidecar.emit(**fields)   # print the one JSON line a resource prints to stdout
  sidecar.save_image(fig, path)  # the image limits below, JPEG
  sidecar.fail(sentence)   # print a sentence the agent can act on to stderr and exit 2

CLI (for an array you made yourself):
  python sidecar.py --array out.npy --like hu.json [--input a.npy ...] [--param key=value ...]
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

MAX_IMAGE_PX = 2000  # Pi's image limit for Meta models; larger images may be rejected or resized
MAX_IMAGE_BYTES = 1 << 20  # view_image refuses files over 1 MiB, and every image is resent with later requests
JPEG_QUALITY = 85


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 22), b''):
            h.update(chunk)
    return h.hexdigest()


def sidecar_path(array_path):
    return Path(array_path).with_suffix('.json')


def grid(path):
    """grid_id and spacing_zyx_mm from a sidecar or an intake header."""
    d = json.loads(Path(path).read_text())
    if 'grid_id' not in d or 'spacing_zyx_mm' not in d:
        fail(f'{path} has no grid_id/spacing_zyx_mm: pass the hu.json that scan-intake wrote, or an array sidecar')
    return {'grid_id': d['grid_id'], 'spacing_zyx_mm': d['spacing_zyx_mm']}


def derived_grid_id(parent_grid_id, frame):
    """Id for a grid defined by a transform of another grid (an oriented stack): hash of the parent id and the frame."""
    blob = json.dumps({'parent': parent_grid_id, 'frame': frame}, sort_keys=True, default=float)
    return hashlib.sha256(blob.encode()).hexdigest()


def write(array_path, *, like=None, grid_id=None, spacing_zyx_mm=None, inputs=(), params=None, script=None):
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
    }
    out = sidecar_path(array_path)
    if out.exists():  # segment_sam writes its own <labels>.json (axis, prompt, per-object confidence): keep its keys
        meta = {**json.loads(out.read_text()), **meta}
    out.write_text(json.dumps(meta, indent=1, default=float) + '\n')
    return out


def emit(**fields):
    print(json.dumps(fields, default=float))


def fail(sentence):
    print(sentence, file=sys.stderr)
    sys.exit(2)


def save_image(fig, path, dpi=100):
    """Save a matplotlib figure as the image the agent will open: JPEG, at most 2000 px a side and 1 MiB.

    JPEG q85 keeps a 6-view sheet well under 1 MiB where PNG does not. Use a .png path only for a small crop
    where exact colours matter. Fails with a sentence if the figure cannot be made to fit.
    """
    path = Path(path)
    w, h = fig.get_size_inches() * dpi
    if max(w, h) > MAX_IMAGE_PX:
        fail(f'{path.name} would be {w:.0f}x{h:.0f} px, over the {MAX_IMAGE_PX} px limit: use a smaller figure size')
    kw = {'pil_kwargs': {'quality': JPEG_QUALITY}} if path.suffix.lower() in ('.jpg', '.jpeg') else {}
    fig.savefig(path, dpi=dpi, **kw)
    save_checked(path)


def save_checked(path):
    """Fail if an image on disk is over the size or pixel limits."""
    from PIL import Image
    w, h = Image.open(path).size
    size = Path(path).stat().st_size
    if max(w, h) > MAX_IMAGE_PX or size > MAX_IMAGE_BYTES:
        fail(f'{path} is {w}x{h}, {size} bytes: over the {MAX_IMAGE_PX} px / 1 MiB limit; render fewer or smaller panels')


def _value(s):
    try:
        return json.loads(s)
    except ValueError:
        return s


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--array', required=True)
    ap.add_argument('--like', required=True, help='hu.json or another sidecar: the grid this array is on')
    ap.add_argument('--input', action='append', default=[])
    ap.add_argument('--param', action='append', default=[], help='key=value')
    a = ap.parse_args()
    params = {k: _value(v) for k, v in (p.split('=', 1) for p in a.param)}
    out = write(a.array, like=a.like, inputs=a.input, params=params, script='sidecar.py')
    emit(sidecar=str(out))
