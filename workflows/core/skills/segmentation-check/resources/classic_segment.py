"""A second opinion on boundaries: a seeded watershed inside the bone threshold, seeded from the labels you already have.

  python classic_segment.py --hu hu.npy --labels labels.npy --out classic.npy --threshold-hu <T> [--core-mm 0.05]
  python classic_segment.py --hu hu.npy --labels labels.npy --out split.npy --threshold-hu <T> --within 2 --seeds seeds.json

Default mode: seeds are the eroded cores of each label (`--core-mm` deep; a label with no core left seeds from its bone voxels),
the elevation is the Gaussian gradient magnitude of the HU volume (sigma 1 voxel), and basins grow with 6-connectivity inside
bone. It shares the labels' idea of which bone is which, so it checks where boundaries run, not identity: a label on two bones
stays on two bones.

`--within L --seeds seeds.json` splits the voxels of label L between parts you seed: seeds.json is
{"<label>": [[z,y,x], ...]}, one entry per part (use L for the part that keeps its id). Each seed grows to a ball of 3 voxels
before the watershed; voxels of other labels are left alone. The elevation here is minus the distance to the label's edge,
so the cut falls where the label pinches (the contact), whatever the HU gradient does; a seed only has to lie inside its part.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi
from skimage.segmentation._watershed_cy import watershed_raveled

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/;
# only missing directories are added, so a script imported by another leaves the importer's order alone.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [d for d in (str(HERE), str(SKILLS / 'microct-core/resources')) if d not in sys.path]
try:
    import sidecar
except ModuleNotFoundError as e:
    print(f'{e}: a skill this script imports is missing; it expects <workflows>/core/skills/<skill>/resources/, or '
          '<workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it', file=sys.stderr)
    sys.exit(2)


MARGIN = 10
SLAB = 64  # z-slab depth of the chunked gradient and distance
GRADIENT_RADIUS = 4  # a Gaussian of sigma 1 voxel reaches 4 voxels: the halo a slab needs for the whole-volume values


def crop_box(mask, margin=MARGIN):
    sl = ndi.find_objects(mask.astype(np.uint8))[0]
    return tuple(slice(max(0, s.start - margin), s.stop + margin) for s in sl)


def cores(lab, core_vox, bone):
    """Seeds (uint8, the label's id) at each label's eroded core, eroded inside the label's own box: no full-size temporary."""
    seeds = np.zeros(lab.shape, np.uint8)
    n_fallback = []
    for lv, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None:
            continue
        m = lab[sl] == lv
        core = ndi.binary_erosion(m, iterations=core_vox)
        if not core.any():
            core = m & bone[sl]
            n_fallback.append(lv)
        seeds[sl][core] = lv
    return seeds, n_fallback


def gradient_into(view, h):
    """Gaussian gradient magnitude (sigma 1 voxel) of the HU array `h`, written into `view` a z-slab at a time."""
    for z0 in range(0, h.shape[0], SLAB):
        z1 = min(z0 + SLAB, h.shape[0])
        lo, hi = max(0, z0 - GRADIENT_RADIUS), min(h.shape[0], z1 + GRADIENT_RADIUS)
        g = ndi.gaussian_gradient_magnitude(np.asarray(h[lo:hi], np.float32), sigma=1.0)
        view[z0:z1] = g[z0 - lo : z1 - lo]


def edt_into(view, inside):
    """Minus the distance (voxels) to the nearest voxel outside `inside`, written into `view` a z-slab at a time. scipy's
    `distance_transform_edt` allocates about 60 bytes per voxel; this keeps the 12 of its nearest-voxel indices."""
    nearest = ndi.distance_transform_edt(inside, return_distances=False, return_indices=True)
    yy, xx = np.ogrid[: inside.shape[1], : inside.shape[2]]
    for z0 in range(0, inside.shape[0], SLAB):
        z1 = min(z0 + SLAB, inside.shape[0])
        zz = np.arange(z0, z1)[:, None, None]
        d2 = (nearest[0, z0:z1] - zz).astype(np.int64) ** 2 + (nearest[1, z0:z1] - yy) ** 2 + (nearest[2, z0:z1] - xx) ** 2
        np.negative(np.sqrt(d2), out=view[z0:z1])


def grow(shape, build, fill_elevation):
    """Seeded watershed, 6-connected: the basins of the seeds flood the mask over the elevation. `build(seeds, mask)` fills an
    int32 seed view and an int8 mask view, `fill_elevation(view)` a float64 view.
    skimage's `watershed` casts every input to float64/int32 and pads again: about 26 bytes per voxel, 7 GB on a whole scan
    against a 4 GiB sandbox. This builds the padded arrays once (13 bytes per voxel), builders' temporaries freed before the
    float64 image exists, and calls skimage's raveled core, which is private: re-check it when skimage is bumped in requirements.txt."""
    padded = tuple(n + 2 for n in shape)
    inner = (slice(1, -1),) * 3
    out = np.zeros(padded, np.int32)
    flood = np.zeros(padded, np.int8)
    build(out[inner], flood[inner])
    out[flood == 0] = 0  # a seed outside the mask would never be flooded from
    image = np.zeros(padded, np.float64)
    fill_elevation(image[inner])
    strides = np.array(image.strides, dtype=np.intp) // image.itemsize
    neighbours = np.array([strides[0], -strides[0], strides[1], -strides[1], strides[2], -strides[2]], dtype=np.intp)
    watershed_raveled(image.ravel(), np.flatnonzero(out), neighbours, flood.ravel(), strides, 0.0, out.ravel(), False)
    del image, flood
    return out[inner].astype(np.uint8)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--hu', required=True)
    ap.add_argument('--labels', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--threshold-hu', type=float, required=True)
    ap.add_argument('--core-mm', type=float, default=0.05)
    ap.add_argument('--within', type=int)
    ap.add_argument('--seeds')
    a = ap.parse_args()
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels, mmap_mode='r')
    if hu.shape != labels.shape:
        sidecar.fail(f'hu {hu.shape} and labels {labels.shape} are on different grids: map the labels to the scan first')
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    if (a.within is None) != (a.seeds is None):
        sidecar.fail('--within and --seeds go together')
    box = crop_box(np.asarray(labels) == a.within if a.within else np.asarray(labels) > 0)
    h = hu[box]
    out = np.zeros(hu.shape, np.uint8)
    info = {}
    if a.within is None:
        def build(seeds, mask):
            bone = h >= a.threshold_hu
            seeds[...], info['core_fallback_labels'] = cores(np.asarray(labels[box]), max(1, round(a.core_mm / sp[0])), bone)
            mask[...] = bone

        out[box] = grow(h.shape, build, lambda view: gradient_into(view, h))
    else:
        spec = json.loads(Path(a.seeds).read_text())
        lab = np.asarray(labels[box])
        seeds = np.zeros(lab.shape, np.int32)
        for k, pts in spec.items():
            for p in pts:
                q = [c - s.start for c, s in zip(p, box)]
                if not all(0 <= c < n for c, n in zip(q, lab.shape)):
                    sidecar.fail(f'seed {p} for part {k} is outside the region around label {a.within}')
                seeds[tuple(q)] = int(k)
        seeds = np.where(ndi.binary_dilation(seeds > 0, iterations=3),
                         ndi.maximum_filter(seeds, size=7), 0) * (lab == a.within)
        inside = (lab == a.within) & (h >= a.threshold_hu)

        def build(sd, mask):
            sd[...] = seeds
            mask[...] = inside

        out[box] = grow(h.shape, build, lambda view: edt_into(view, inside))
        merged = np.asarray(labels).copy()
        merged[out > 0] = out[out > 0]
        out = merged
    np.save(a.out, out)
    sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.hu, a.labels] + ([a.seeds] if a.seeds else []),
                  params={'threshold_hu': a.threshold_hu, 'core_mm': a.core_mm, 'within': a.within})
    vox = float(np.prod(sp))
    ids, counts = np.unique(out[out > 0], return_counts=True)
    sidecar.emit(labels=a.out, volume_mm3={int(i): round(float(c) * vox, 4) for i, c in zip(ids, counts)}, **info)
