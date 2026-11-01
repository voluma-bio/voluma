"""A file a run reported to the review assets: OME-Zarr multiscale levels and meshes, under `<out>/<sha256>/`.

  python review_assets.py --source <file.npy> --as image|labels|mask|surface [--axis 0|1|2] [--int16] --out <dir>

`image`, `labels`, `mask` take a 3-D `.npy`; `surface` takes a 2-D float32 height field (NaN off the bone) measured along
array axis `--axis`. `--int16` (image only) rounds a float image, such as the scan's HU, to int16 at level 0; values outside int16 are an error.
The sha256 is of the `.npy` bytes. A finished conversion has `manifest.json` (written last), which records the converter
version and the mode (`--as`, `--axis`, `--int16`); asked again with the same version and mode, the script prints it and does
nothing else; with the same version but another mode it exits 2 (use another `--out`), and with an older version or an
unreadable manifest it converts again. Paths in the manifest are relative to `<out>/<sha256>/`.

With `--cache` (default VOLUMA_REVIEW_CACHE), completed conversions are reused across runs of the same input.
VOLUMA_REVIEW_RUNTIME must identify the pinned sandbox image. The cache is partitioned by the converter's code and
runtime, mode and source bytes, not by a run's affine or grid id: assets contain voxel coordinates only.
Cache hits copy the assets into `--out`, preserving run-scoped URLs and authorization. Each publisher writes a unique
generation, then a small `ready` record selecting it. Readers select that immutable generation once; concurrent or
interrupted publishers cannot modify its files. A failed cache write still publishes to `--out`; a failed copy from the
cache converts again. No calibration, source paths or geometry are read from the cache.

Levels (OME-Zarr 0.4 on Zarr v2, Blosc zstd, 64-cubed chunks): level 0 is the source; each next level halves every axis
(rounding up) until every axis is at most ceil(level 0 / 8); the last is one chunk. Images are averaged; labels and masks take the
mode of each 2x2x2 block, a tie going to the foreground. A one-voxel sheet survives every level (it fills 4 of 8 voxels of a block: a tie), but a one-voxel rod does not
(2 of 8: the background wins), so do not read rods and other thin structures off coarse levels. A level voxel covers `scaleZyx` source voxels per axis. Integer coordinates are voxel centres: voxel i of level k has its
centre at source coordinate i*2^k + (2^k-1)/2, which is the translation in each dataset's OME `coordinateTransformations`. Meshes: marching cubes per nonzero label (or one for a mask), or the
height field triangulated over its finite cells, wound so each normal points toward +axis. `mesh*.bin` is float32 vertices as full-resolution source voxel (x, y, z),
then uint32 indices, little-endian. A cropped mask's levels and meshes are in its crop's voxels; the reader adds the crop's offset.
"""
import hashlib
import json
import os
import shutil
import sys
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

import numcodecs
import numpy as np
import sidecar  # microct-core's resources/, on PYTHONPATH as in every sandbox of a run
import zarr
from scipy import ndimage as ndi
from skimage.measure import marching_cubes

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


def write_levels(src, group, mode, dtype=None):
    """Level arrays 0..n of `src` (a (Z, Y, X) array) in the zarr `group`; returns their shapes. A `dtype` other than the
    source's rounds level 0 to it."""
    shapes = level_shapes(src.shape)
    down = down_mean if mode == 'mean' else down_mode
    dtype = np.dtype(dtype or stored_dtype(src))
    for k, shape in enumerate(shapes):
        last = k == len(shapes) - 1 and k > 0
        arr = group.create_array(str(k), shape=tuple(shape), dtype=dtype, compressors=COMPRESSOR,
                                 chunk_key_encoding={'name': 'v2', 'separator': '/'},
                                 chunks=tuple(shape) if last else tuple(min(CHUNK, n) for n in shape))
        prev = src if k == 0 else group[str(k - 1)]
        step = CHUNK if k == 0 else SLAB
        for z in range(0, prev.shape[0], step):
            slab = np.asarray(prev[z:z + step])
            if k == 0 and slab.dtype.kind == 'f' and dtype.kind == 'i':
                slab = np.rint(slab)
            slab = slab.astype(dtype, copy=False)
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
    # (a, b, cc) turns from +row toward +col, so its normal is +height when (row, col, height) is a right-handed frame in
    # (x, y, z) = reversed zyx; otherwise swap two corners.
    order = [i for i in range(3) if i != axis] + [axis]
    frame = np.zeros((3, 3))
    frame[[2 - i for i in order], range(3)] = 1
    if np.linalg.det(frame) < 0:
        tris = tris[:, [0, 2, 1]]
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


def publish(src, dst):
    """Copies src to dst, 32 files at a time (a bucket mount is slow per file), manifest.json last so a copy cut short has none."""
    files = [p for p in src.rglob('*') if p.is_file() and p.name != 'manifest.json']
    dst.mkdir(parents=True, exist_ok=True)
    # Modal's R2 mount does not keep empty directories, so a parent made before the copies is gone by
    # open(). Parallel mkdir of one parent fails with File exists (STAGE_PREPARE_SCRIPT). Make the
    # parent immediately before each copy, one mkdir at a time, and retry if it still vanishes.
    mkdir_lock = Lock()

    def copy(p):
        target = dst / p.relative_to(src)
        for attempt in range(4):
            try:
                with mkdir_lock:
                    target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, target)
                return
            except (FileNotFoundError, FileExistsError):
                if attempt == 3:
                    raise

    with ThreadPoolExecutor(32) as pool:
        list(pool.map(copy, files))
    shutil.copyfile(src / 'manifest.json', dst / 'manifest.json')


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--source', required=True, type=sidecar.existing, help='a .npy file (any name)')
    ap.add_argument('--as', dest='kind', required=True, choices=KINDS)
    ap.add_argument('--axis', type=int, choices=(0, 1, 2), help='surface only: the array axis the height is measured along')
    ap.add_argument('--int16', action='store_true', help='image only: round a float image to int16 at level 0')
    ap.add_argument('--out', required=True, help='directory that receives <sha256>/')
    ap.add_argument('--cache', default=os.environ.get('VOLUMA_REVIEW_CACHE'),
                    help='input-owned directory for completed conversions shared across runs (default VOLUMA_REVIEW_CACHE)')
    a = ap.parse_args()
    runtime = os.environ.get('VOLUMA_REVIEW_RUNTIME')
    if a.cache and not runtime:
        sidecar.fail('VOLUMA_REVIEW_RUNTIME must identify the pinned sandbox image when using --cache')
    src = Path(a.source)
    if (a.kind == 'surface') != (a.axis is not None):
        sidecar.fail('--axis goes with --as surface, and only with it: say which array axis the heights are measured along')
    if a.int16 and a.kind != 'image':
        sidecar.fail('--int16 goes with --as image, and only with it')
    if not src.is_file():
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

    final = Path(a.out) / digest
    mode = {'as': a.kind, 'axis': a.axis, 'int16': a.int16}
    manifest_path = final / 'manifest.json'
    try:
        done = json.loads(manifest_path.read_text())
    except (OSError, ValueError):  # none yet, or unreadable: convert
        done = {}
    if done.get('converterVersion') == VERSION:
        if done.get('mode') != mode:
            sidecar.fail(f'{final} already holds {src} converted as {done.get("mode")}; give --out another directory for {mode}')
        print(manifest_path.read_text().strip())
        return
    cached = None
    if a.cache:
        # Include the pinned image: dependency changes can change output without changing this script.
        code = hashlib.sha256(Path(__file__).read_bytes() + b'\0' + runtime.encode()).hexdigest()
        mode_id = hashlib.sha256(json.dumps(mode, sort_keys=True).encode()).hexdigest()
        cached = Path(a.cache) / code / mode_id / digest
        try:
            generation = cached / uuid.UUID((cached / 'ready').read_text().strip()).hex
            text = (generation / 'manifest.json').read_text()
            ready = json.loads(text)
        except (FileNotFoundError, ValueError):
            ready = {}
        if (ready.get('sourceSha256') == digest and ready.get('converterVersion') == VERSION
                and ready.get('mode') == mode):
            try:
                publish(generation, final)
            except OSError as e:
                print(f'review assets: could not copy input cache ({e}); converting again', file=sys.stderr)
            else:
                print(f'review assets: reused {digest} from input cache', file=sys.stderr)
                print(text.strip())
                return
    if a.int16:
        lo, hi = np.float64(np.inf), np.float64(-np.inf)
        for z in range(0, arr.shape[0], SLAB):
            slab = arr[z:z + SLAB]
            lo, hi = np.minimum(lo, slab.min()), np.maximum(hi, slab.max())  # propagate NaN
        info = np.iinfo(np.int16)
        if not (info.min <= lo and hi <= info.max):  # NaN fails both
            sidecar.fail(f'values run from {lo:g} to {hi:g} (or hold NaN): {src} cannot be stored as int16')
    manifest = {'sourceSha256': digest, 'converterVersion': VERSION, 'mode': mode, 'levels': [], 'meshes': []}

    shutil.rmtree(final, ignore_errors=True)  # an interrupted conversion has no manifest: start clean
    # Built on local disk and copied: zarr writes by renaming, which a cloud-bucket mount (--out in a run) cannot do.
    # A fixed path, cleared at the start: a conversion killed on timeout leaves no temp dir to pile up on the reused sandbox.
    out = Path('/tmp/review-assets-work')
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir()
    if a.kind == 'surface':
        step = 2 if np.isfinite(arr).sum() > BIG else 1
        verts, faces = height_mesh(np.asarray(arr), a.axis, step)
        manifest['meshes'].append({'path': 'mesh.bin'} | write_mesh(out / 'mesh.bin', verts, faces))
    else:
        group = zarr.open_group(out / 'image.zarr', mode='w', zarr_format=2)
        shapes = write_levels(arr, group, 'mode' if a.kind in ('labels', 'mask') else 'mean',
                              np.int16 if a.int16 else None)
        scales = [[2 ** k] * 3 for k in range(len(shapes))]
        group.attrs['multiscales'] = [{
            'version': '0.4', 'name': a.kind,
            'axes': [{'name': n, 'type': 'space'} for n in 'zyx'],
            'datasets': [{'path': str(k), 'coordinateTransformations': [
                {'type': 'scale', 'scale': [float(s) for s in sc]},
                {'type': 'translation', 'translation': [(s - 1) / 2 for s in sc]}]}
                         for k, sc in enumerate(scales)]}]
        manifest['levels'] = [{'path': f'image.zarr/{k}', 'shapeZyx': shapes[k], 'scaleZyx': scales[k]} for k in range(len(shapes))]
        if a.kind in ('labels', 'mask'):
            manifest['meshes'] = write_meshes(arr, a.kind, out)

    text = json.dumps(manifest, allow_nan=False)
    (out / 'manifest.json').write_text(text + '\n')
    if cached is not None:
        # Never overwrite completed files: another publisher can stop halfway through its own generation.
        # A cache write must not fail this run: --out is what the viewer reads.
        generation = uuid.uuid4().hex
        try:
            publish(out, cached / generation)
            (cached / 'ready').write_text(generation + '\n')
        except OSError as e:
            print(f'review assets: could not write input cache ({e}); publishing to --out only', file=sys.stderr)
    try:
        publish(out, final)  # manifest.json last: a reader never sees half a manifest
    except OSError:
        traceback.print_exc()
        print('could not write the review files', file=sys.stderr)
        sys.exit(1)
    shutil.rmtree(out)
    print(text)


if __name__ == '__main__':
    main()
