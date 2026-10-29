"""A file a run reported to the review assets: OME-Zarr multiscale levels and meshes, under `<out>/<sha256>/`.

  python review_assets.py --source <file.npy> --as image|labels|mask|surface [--axis 0|1|2] [--int16] --out <dir>

`image`, `labels`, `mask` take a 3-D `.npy`; `surface` takes a 2-D float32 height field (NaN off the bone) measured along
array axis `--axis`. `--int16` (image only) rounds a float image, such as the scan's HU, to int16 at level 0; values outside int16 are an error.
The sha256 is of the `.npy` bytes. A finished conversion has `manifest.json` (written last), which records the converter
version and the mode (`--as`, `--axis`, `--int16`); asked again with the same version and mode, the script prints it and does
nothing else, otherwise it converts again. Paths in the manifest are relative to `<out>/<sha256>/`.

Levels (OME-Zarr 0.4 on Zarr v2, Blosc zstd, 64-cubed chunks): level 0 is the source; each next level halves every axis
(rounding up) until every axis is at most ceil(level 0 / 8); the last is one chunk. Images are averaged, labels and masks take the
mode. A level voxel covers `scaleZyx` source voxels per axis. Meshes: marching cubes per nonzero label (or one for a mask), or the
height field triangulated over its finite cells. `mesh*.bin` is float32 vertices as full-resolution source voxel (x, y, z),
then uint32 indices, little-endian. A cropped mask's levels and meshes are in its crop's voxels; the reader adds the crop's offset.
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

import numcodecs
import numpy as np
import zarr
from scipy import ndimage as ndi
from skimage.measure import marching_cubes

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [d for d in (str(HERE), str(SKILLS / 'microct-core/resources'))
                if d not in sys.path]
try:
    import sidecar
except ModuleNotFoundError as e:
    print(f'{e}: a skill this script imports is missing; it expects <workflows>/core/skills/<skill>/resources/', file=sys.stderr)
    sys.exit(2)

CHUNK = 64
BIG = 1_000_000  # an object of more voxels is meshed at step 2
SLAB = 128  # source planes read per downsampling step (even, so slabs pair up)
COMPRESSOR = numcodecs.Blosc(cname='zstd', clevel=5, shuffle=numcodecs.Blosc.SHUFFLE)
VERSION = 1  # bump when the output for the same input changes
KINDS = ('image', 'labels', 'mask', 'surface')


def stored_dtype(a):
    return np.dtype(np.uint8) if a.dtype == bool else a.dtype


def level_shapes(shape):
    target = [-(-n // 8) for n in shape]
    shapes = [list(shape)]
    while any(n > t for n, t in zip(shapes[-1], target)):
        shapes.append([-(-n // 2) for n in shapes[-1]])
    return shapes


def blocks(slab):
    """(8, Z/2, Y/2, X/2): the 2x2x2 neighbours of each voxel of the next level; an odd axis repeats its last plane."""
    slab = np.pad(slab, [(0, n % 2) for n in slab.shape], mode='edge')
    z, y, x = (n // 2 for n in slab.shape)
    return slab.reshape(z, 2, y, 2, x, 2).transpose(1, 3, 5, 0, 2, 4).reshape(8, z, y, x)


def down_mean(slab):
    out = blocks(slab).mean(axis=0, dtype=np.float32)
    return np.rint(out).astype(slab.dtype) if np.issubdtype(slab.dtype, np.integer) else out.astype(slab.dtype)


def down_mode(slab):
    """Most common value of each block; on a tie the foreground wins, so a one-voxel-thick object doesn't vanish."""
    v = blocks(slab)
    score = np.zeros(v.shape, np.uint8)
    for i in range(8):
        score[i] = sum((v[i] == v[j]) for j in range(8)) * 2 + (v[i] != 0)
    return np.take_along_axis(v, score.argmax(axis=0)[None], axis=0)[0]


def write_levels(src, group, mode):
    """Level arrays 0..n of `src` (a (Z, Y, X) array) in the zarr `group`; returns their shapes."""
    shapes = level_shapes(src.shape)
    down = down_mean if mode == 'mean' else down_mode
    dtype = stored_dtype(src)
    for k, shape in enumerate(shapes):
        last = k == len(shapes) - 1 and k > 0
        arr = group.create_array(str(k), shape=tuple(shape), dtype=dtype, compressors=COMPRESSOR,
                                 chunks=tuple(shape) if last else tuple(min(CHUNK, n) for n in shape))
        prev = src if k == 0 else group[str(k - 1)]
        step = CHUNK if k == 0 else SLAB
        for z in range(0, prev.shape[0], step):
            slab = np.asarray(prev[z:z + step]).astype(dtype, copy=False)
            if k:
                slab = down(slab)
            z //= 1 if k == 0 else 2
            arr[z:z + len(slab)] = slab
    return shapes


def mesh_of(sub, lo, step):
    """Marching-cubes surface of a bool crop whose corner is voxel `lo` (z, y, x); vertices as full-resolution (x, y, z)."""
    crop = np.pad(sub, 1).astype(np.float32)
    try:
        verts, faces, _, _ = marching_cubes(crop, 0.5, step_size=step, allow_degenerate=False)
    except ValueError:  # a slab one or two voxels thick has no step-2 surface
        verts, faces, _, _ = marching_cubes(crop, 0.5, step_size=1, allow_degenerate=False)
    return (verts + np.array(lo) - 1)[:, ::-1], faces  # skimage winds faces inward in (z, y, x); the axis reversal mirrors them outward


def height_mesh(face, axis, step):
    """The (A, B) height field `face` (heights along array `axis`) as a mesh over the grid cells whose corners are all finite."""
    rows, cols = np.arange(0, face.shape[0], step), np.arange(0, face.shape[1], step)
    r, c = np.meshgrid(rows, cols, indexing='ij')
    h = face[r, c]
    ok = np.isfinite(h)
    ids = -np.ones(ok.shape, np.int64)
    ids[ok] = np.arange(ok.sum())
    a, b, cc, d = ids[:-1, :-1], ids[1:, :-1], ids[1:, 1:], ids[:-1, 1:]
    tris = np.concatenate([np.stack([a, b, cc], -1).reshape(-1, 3), np.stack([a, cc, d], -1).reshape(-1, 3)])
    zyx = np.empty((ok.sum(), 3), np.float64)
    zyx[:, [i for i in range(3) if i != axis]] = np.stack([r[ok], c[ok]], 1)
    zyx[:, axis] = h[ok]
    return zyx[:, ::-1], tris[(tris >= 0).all(1)]


def write_mesh(path, verts, faces):
    path.write_bytes(np.asarray(verts, '<f4').tobytes() + np.asarray(faces, '<u4').tobytes())
    return {'vertices': len(verts), 'indices': int(np.asarray(faces).size)}


def write_meshes(arr, kind, out):
    """One mesh per nonzero label of `arr` (a mask is label 1)."""
    meshes = []
    labelled = arr if kind == 'labels' else (arr != 0).astype(np.uint8)
    boxes = ndi.find_objects(np.asarray(labelled))
    for i, box in enumerate(boxes, 1):
        if box is None:
            continue
        sub = np.asarray(labelled[box]) == i
        verts, faces = mesh_of(sub, [s.start for s in box], 2 if sub.sum() > BIG else 1)
        name = f'mesh-{i}.bin' if kind == 'labels' else 'mesh.bin'
        meshes.append(({'label': i} if kind == 'labels' else {}) | {'path': name} | write_mesh(out / name, verts, faces))
    return meshes


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--source', required=True, help='a .npy file')
    ap.add_argument('--as', dest='kind', required=True, choices=KINDS)
    ap.add_argument('--axis', type=int, choices=(0, 1, 2), help='surface only: the array axis the height is measured along')
    ap.add_argument('--int16', action='store_true', help='image only: round a float image to int16 at level 0')
    ap.add_argument('--out', required=True, help='directory that receives <sha256>/')
    a = ap.parse_args()
    src = Path(a.source)
    if (a.kind == 'surface') != (a.axis is not None):
        sidecar.fail('--axis goes with --as surface, and only with it: say which array axis the heights are measured along')
    if a.int16 and a.kind != 'image':
        sidecar.fail('--int16 goes with --as image, and only with it')
    if not src.is_file() or src.suffix != '.npy':
        sidecar.fail(f'--as {a.kind} takes a .npy file; {src} is not one')
    arr = np.load(src, mmap_mode='r')
    want = 2 if a.kind == 'surface' else 3
    if arr.ndim != want:
        sidecar.fail(f'--as {a.kind} takes a {want}-D array; {src} has shape {list(arr.shape)}')
    if a.kind == 'surface':
        if arr.dtype != np.float32:
            sidecar.fail(f'a surface is float32 heights (NaN off the bone); {src} is {arr.dtype}')
    elif a.kind != 'image' and arr.dtype.kind not in 'biu':
        sidecar.fail(f'--as {a.kind} takes integer or boolean values; {src} is {arr.dtype}')
    elif arr.dtype.kind not in 'biuf':
        sidecar.fail(f'--as {a.kind} takes numbers; {src} is {arr.dtype}')
    if a.int16 and arr.dtype.kind != 'f':
        sidecar.fail(f'--int16 rounds a float image; {src} is {arr.dtype}')
    digest = sidecar.sha256_file(src)

    out = Path(a.out) / digest
    mode = {'as': a.kind, 'axis': a.axis, 'int16': a.int16}
    manifest_path = out / 'manifest.json'
    if manifest_path.exists():
        done = json.loads(manifest_path.read_text())
        if done.get('converterVersion') == VERSION and done.get('mode') == mode:
            print(manifest_path.read_text().strip())
            return
    if a.int16:
        lo, hi = float(arr.min()), float(arr.max())
        info = np.iinfo(np.int16)
        if not (info.min <= lo and hi <= info.max):  # NaN fails both
            sidecar.fail(f'values run from {lo:g} to {hi:g} (or hold NaN): {src} cannot be stored as int16')
        arr = np.rint(arr).astype(np.int16)
    manifest = {'sourceSha256': digest, 'converterVersion': VERSION, 'mode': mode, 'levels': [], 'meshes': []}

    shutil.rmtree(out, ignore_errors=True)  # an interrupted conversion has no manifest: start clean
    out.mkdir(parents=True)
    if a.kind == 'surface':
        step = 2 if np.isfinite(arr).sum() > BIG else 1
        verts, faces = height_mesh(np.asarray(arr), a.axis, step)
        manifest['meshes'].append({'path': 'mesh.bin'} | write_mesh(out / 'mesh.bin', verts, faces))
    else:
        group = zarr.open_group(out / 'image.zarr', mode='w', zarr_format=2)
        shapes = write_levels(arr, group, 'mode' if a.kind in ('labels', 'mask') else 'mean')
        scales = [[2 ** k] * 3 for k in range(len(shapes))]
        group.attrs['multiscales'] = [{
            'version': '0.4', 'name': a.kind,
            'axes': [{'name': n, 'type': 'space'} for n in 'zyx'],
            'datasets': [{'path': str(k), 'coordinateTransformations': [{'type': 'scale', 'scale': [float(s) for s in sc]}]}
                         for k, sc in enumerate(scales)]}]
        manifest['levels'] = [{'path': f'image.zarr/{k}', 'shapeZyx': shapes[k], 'scaleZyx': scales[k]} for k in range(len(shapes))]
        if a.kind in ('labels', 'mask'):
            manifest['meshes'] = write_meshes(arr, a.kind, out)

    text = json.dumps(manifest, allow_nan=False)
    (out / 'manifest.json').write_text(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
