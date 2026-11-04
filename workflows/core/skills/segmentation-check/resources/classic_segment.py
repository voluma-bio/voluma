"""Second opinion on boundaries: a seeded watershed inside the bone threshold, seeded from your labels.

Default mode: seeds are the eroded cores of each label (`--core-mm` deep; a label with no core left seeds from its bone voxels,
and is listed in `core_fallback_labels`), the elevation is the Gaussian gradient magnitude of the HU volume (sigma 1 voxel),
and basins grow with 6-connectivity inside bone (HU at or above `--threshold-hu`). It shares the labels' idea of which bone is
which, so it checks where boundaries run, not identity: a label on two bones stays on two bones. The output holds only the
watershed's labels (bone voxels).

`--within L --seeds seeds.json` splits the voxels of label L between parts you seed: seeds.json is
{"<label>": [[z,y,x], ...]}, one entry per part (use L for the part that keeps its id), z,y,x scan voxel indices. Each seed grows to
a ball of 3 voxels before the watershed; voxels of other labels are left alone, and the output is `--labels` with the parts
written over label L. The elevation here is minus the distance to the label's edge, so the cut falls where the label pinches
(the contact), whatever the HU gradient does; a seed only has to lie inside its part. `--within` and `--seeds` go together;
a seed outside the region around label L is refused.

`--within A,B` cuts two labels that touch apart: it splits their union, with the unlabelled bone that bridges them (each piece
of threshold bone no label holds that touches both and no other label), between seeds of A and of B (one or more in each bone's core), so the
boundary falls at the narrowest bone between them. Where the two touch after the cut is recorded in
`<out stem>-cuts.npz`; pass the output to `finish_labels.py --cut`, which lets that contact pass as a cut, not a join.

Writes: <out>  uint8 labels on the grid of --labels, with its sidecar
        <out stem>-cuts.npz  with --within: for each pair of parts "A-B", the voxels of A that touch B (z,y,x rows)
Prints: one JSON line {labels, volume_mm3: {label id: volume}, core_fallback_labels (default mode only)}
Example: python classic_segment.py --hu hu.npy --labels labels.npy --out classic.npy --threshold-hu scan-settings.json
         python classic_segment.py --hu hu.npy --labels labels.npy --out split.npy --threshold-hu scan-settings.json --within 2 --seeds seeds.json
         python classic_segment.py --hu hu.npy --labels labels.npy --out cut.npy --threshold-hu scan-settings.json --within 6,2 --seeds seeds.json
Exits 2 with one sentence on bad input, before writing anything.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import sidecar
from scipy import ndimage as ndi
from skimage.segmentation._watershed_cy import watershed_raveled

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


def touching(lab, a, b):
    """Boolean mask of the voxels of label a with a 6-neighbour of label b."""
    out = np.zeros(lab.shape, bool)
    is_b = lab == b
    for ax in range(3):
        for d in (1, -1):
            nb = np.zeros_like(is_b)
            src = [slice(None)] * 3
            dst = [slice(None)] * 3
            src[ax], dst[ax] = (slice(d, None), slice(None, -d)) if d > 0 else (slice(None, d), slice(-d, None))
            nb[tuple(dst)] = is_b[tuple(src)]
            out |= nb
    return out & (lab == a)


def within_arg(s):
    try:
        ids = [int(x) for x in s.split(',')]
    except ValueError:
        raise argparse.ArgumentTypeError(f'--within takes a label id or two, e.g. 2 or 6,2; got {s!r}') from None
    if not 1 <= len(ids) <= 2 or len(set(ids)) != len(ids):
        raise argparse.ArgumentTypeError(f'--within takes one label id or two different ones, got {s!r}')
    return ids


def grow(shape, build, fill_elevation):
    """Seeded watershed, 6-connected: the basins of the seeds flood the mask over the elevation. `build(seeds, mask)` fills an
    int32 seed view and an int8 mask view, `fill_elevation(view)` a float64 view. Returns an int32 view: assign it into the
    caller's volume, which casts it.
    skimage's `watershed` casts every input to float64/int32 and pads again: about 26 bytes per voxel, 7 GB on a whole scan
    against an 8 GiB sandbox. This builds the padded arrays once (13 bytes per voxel), builders' temporaries freed before the
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
    return out[inner]


if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--hu', type=sidecar.existing, required=True, help='hu.npy of the scan')
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='label volume .npy on the scan grid, with its sidecar beside it')
    ap.add_argument('--out', required=True, help='labels .npy to write')
    ap.add_argument('--threshold-hu', type=sidecar.threshold_arg, required=True, help='voxels at or above it are bone: the scan\'s segmentation threshold: its scan-settings.json, or a number in HU')
    ap.add_argument('--core-mm', type=float, default=0.05, help='mm: how deep each label is eroded to make its seed, in the default segmentation mode')
    ap.add_argument('--within', type=within_arg, help='label id to split between the parts in --seeds, or two (A,B) to cut apart')
    ap.add_argument('--seeds', type=sidecar.existing, help='JSON {"<label>": [[z,y,x], ...]}: the parts of label --within')
    a = ap.parse_args()
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels, mmap_mode='r')
    if hu.shape != labels.shape:
        sidecar.fail(f'hu {hu.shape} and labels {labels.shape} are on different grids: map the labels to the scan first')
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    if (a.within is None) != (a.seeds is None):
        sidecar.fail('--within and --seeds go together')
    region = np.isin(np.asarray(labels), a.within) if a.within is not None else np.asarray(labels) > 0
    if a.within is not None and not region.any():
        sidecar.fail(f'labels {a.within} are not in {a.labels}')
    box = crop_box(region)
    del region
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
        if len(a.within) == 2 and set(map(int, spec)) != set(a.within):
            sidecar.fail(f'--within {a.within[0]},{a.within[1]} cuts those two apart: seed each of them, and nothing else, in --seeds')
        lab = np.asarray(labels[box])
        seeds = np.zeros(lab.shape, np.int32)
        for k, pts in spec.items():
            for p in pts:
                q = [c - s.start for c, s in zip(p, box)]
                if not all(0 <= c < n for c, n in zip(q, lab.shape)):
                    sidecar.fail(f'seed {p} for part {k} is outside the region around labels {a.within}')
                seeds[tuple(q)] = int(k)
        seeds = np.where(ndi.binary_dilation(seeds > 0, iterations=3),
                         ndi.maximum_filter(seeds, size=7), 0) * np.isin(lab, a.within)
        inside = np.isin(lab, a.within) & (h >= a.threshold_hu)
        if len(a.within) == 2:  # the unlabelled bone that bridges the two is part of the cut, or they stay joined through it
            free, n = ndi.label((lab == 0) & (h >= a.threshold_hu), structure=np.ones((3, 3, 3), int))
            near = [set(np.unique(free[ndi.binary_dilation(lab == p)])) - {0} for p in a.within]
            # a piece that also touches a third label is left alone: giving it to A or B would join them to that label
            others = set(np.unique(free[ndi.binary_dilation((lab > 0) & ~np.isin(lab, a.within))])) - {0}
            bridge = sorted((near[0] & near[1]) - others)
            if bridge:
                inside |= np.isin(free, bridge)
                info['bridge_voxels'] = int(np.isin(free, bridge).sum())
            del free

        def build(sd, mask):
            sd[...] = seeds
            mask[...] = inside

        out[box] = grow(h.shape, build, lambda view: edt_into(view, inside))
        merged = np.asarray(labels).copy()
        merged[out > 0] = out[out > 0]
        out = merged
        parts = sorted(int(k) for k in spec)
        cuts = {}
        for i, pa in enumerate(parts):
            for pb in parts[i + 1:]:
                at = np.argwhere(touching(out[box], pa, pb)) + [s.start for s in box]
                cuts[f'{pa}-{pb}'] = at.astype(np.int32)
                info.setdefault('cut_voxels', {})[f'{pa}-{pb}'] = len(at)
        np.savez_compressed(Path(a.out).with_name(f'{Path(a.out).stem}-cuts.npz'), **cuts)
    np.save(a.out, out)
    sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.hu, a.labels] + ([a.seeds] if a.seeds else []),
                  params={'threshold_hu': a.threshold_hu, 'core_mm': a.core_mm, 'within': a.within})
    vox = float(np.prod(sp))
    ids, counts = np.unique(out[out > 0], return_counts=True)
    sidecar.emit(labels=a.out, volume_mm3={int(i): round(float(c) * vox, 4) for i, c in zip(ids, counts)}, **info)
