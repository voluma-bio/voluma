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

`--within A,B` (no `--seeds`) cuts two labels that touch apart, near where they touch and nowhere else. The contact is the voxels
where A meets B plus the bridging pieces: threshold bone no label holds, under `--bridge-max-mm3`, touching both and no other
label (a larger piece, or one touching a third bone, is a candidate to label first). In a box `--reach-mm` around the contact,
A's and B's bone at least `--seed-mm` from it seeds each side, and the watershed (minus the distance to the bone's edge) puts the
boundary at the narrowest bone between them; bone farther than `--reach-mm` from the contact never changes label. It prints
the bone that moved (`moved_mm3`: A to B, B to A, bridge to each) and records where the two touch after the cut in
`<out stem>-cuts.npz`; pass the output to `finish_labels.py --cut`, which lets that contact pass as a cut, not a join. Open a
crop at the cut before you report: the moved bone should be the joint's, not a condyle's.

Writes: <out>  uint8 labels on the grid of --labels, with its sidecar
        <out stem>-cuts.npz  with --within A,B: under key "lo-hi", the voxels of the lower label that touch the other (z,y,x rows)
Prints: one JSON line {labels, volume_mm3: {label id: volume}, core_fallback_labels (default mode only); with --within A,B also
  contact_box_zyx, bridge_pieces [{voxels, centre_zyx}], moved_mm3, cut_voxels}
Example: python classic_segment.py --hu hu.npy --labels labels.npy --out classic.npy --threshold-hu scan-settings.json
         python classic_segment.py --hu hu.npy --labels labels.npy --out split.npy --threshold-hu scan-settings.json --within 2 --seeds seeds.json
         python classic_segment.py --hu hu.npy --labels labels.npy --out cut.npy --threshold-hu scan-settings.json --within 6,2
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


def cut_pair(labels, hu, pair, threshold_hu, sp, reach_mm, seed_mm, bridge_max_mm3):
    """Cut labels A and B apart near their contact. Returns (box, new labels in box, cut voxels (z,y,x rows of the lower label
    touching the other, scan indices), info)."""
    A, B = pair
    lo, hi = sorted(pair)
    region = np.isin(np.asarray(labels), pair)
    if not all((np.asarray(labels) == p).any() for p in pair):
        sidecar.fail(f'labels {pair} are not both in the labels volume')
    box = crop_box(region, margin=2)
    del region
    lab = np.asarray(labels[box])
    bone = np.asarray(hu[box]) >= threshold_hu
    contact = touching(lab, A, B) | touching(lab, B, A)
    free, _ = ndi.label((lab == 0) & bone, structure=np.ones((3, 3, 3), int))
    near = [set(np.unique(free[ndi.binary_dilation(lab == p)])) - {0} for p in pair]
    others = set(np.unique(free[ndi.binary_dilation((lab > 0) & ~np.isin(lab, pair))])) - {0}
    vox_mm3 = float(np.prod(sp))
    sizes = np.bincount(free.ravel())
    bridge = [i for i in sorted((near[0] & near[1]) - others) if sizes[i] * vox_mm3 <= bridge_max_mm3]
    bridge_mask = np.isin(free, bridge)
    pieces = []
    objs = ndi.find_objects(free)
    for i in bridge:
        at = np.argwhere(free[objs[i - 1]] == i) + [o.start for o in objs[i - 1]]
        pieces.append({'voxels': len(at), 'centre_zyx': [int(c + s.start) for c, s in zip(at[len(at) // 2], box)]})
    del free
    zone = contact | bridge_mask
    if not zone.any():
        sidecar.fail(f'labels {A} and {B} do not touch, directly or through a bridging piece under {bridge_max_mm3} mm3: nothing to '
                     'cut. A join through a larger unlabelled piece, or one touching a third bone, is labelled first (relabel.py --pieces)')
    reach = [int(np.ceil(reach_mm / d)) for d in sp]
    zl = ndi.find_objects(zone.astype(np.uint8))[0]
    sub = tuple(slice(max(0, z.start - r), min(n, z.stop + r)) for z, r, n in zip(zl, reach, lab.shape))
    sl, sb, sz = lab[sub], bone[sub], zone[sub]
    inside = (np.isin(sl, pair) & sb) | bridge_mask[sub]
    dist = ndi.distance_transform_edt(~sz, sampling=sp)
    seeds = np.zeros(sl.shape, np.int32)
    for p in pair:
        own = (sl == p) & inside
        if not own.any():
            sidecar.fail(f'label {p} has no bone within {reach_mm} mm of the contact: nothing of it to cut')
        far = own & (dist >= seed_mm)
        if not far.any():  # a small structure wholly near the contact: its voxel farthest from it
            far = np.zeros_like(own)
            far[np.unravel_index(np.argmax(np.where(own, dist, -1)), own.shape)] = True
        seeds[far] = p
    del dist

    def build(sd, mask):
        sd[...] = seeds
        mask[...] = inside

    grown = grow(sl.shape, build, lambda view: edt_into(view, inside))
    new = sl.copy()
    new[grown > 0] = grown[grown > 0]
    moved = {f'{A}->{B}': (sl == A) & (new == B), f'{B}->{A}': (sl == B) & (new == A),
             f'bridge->{A}': (sl == 0) & (new == A), f'bridge->{B}': (sl == 0) & (new == B)}
    full = tuple(slice(b.start + s.start, b.start + s.stop) for b, s in zip(box, sub))
    at = np.argwhere(touching(new, lo, hi)) + [s.start for s in full]
    info = {'contact_box_zyx': [[s.start, s.stop] for s in full], 'bridge_pieces': pieces,
            'moved_mm3': {k: round(float(m.sum()) * vox_mm3, 5) for k, m in moved.items()}, 'cut_voxels': {f'{lo}-{hi}': len(at)}}
    return full, new, at.astype(np.int32), info


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
    ap.add_argument('--seeds', type=sidecar.existing, help='JSON {"<label>": [[z,y,x], ...]}: the parts of label --within L')
    ap.add_argument('--reach-mm', type=float, default=0.3, help='mm: with --within A,B, how far from the contact bone may change label')
    ap.add_argument('--seed-mm', type=float, default=0.15, help='mm: with --within A,B, bone at least this far from the contact seeds each side')
    ap.add_argument('--bridge-max-mm3', type=float, default=0.05, help='mm3: with --within A,B, the largest unlabelled piece taken as a bridge')
    a = ap.parse_args()
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels, mmap_mode='r')
    if hu.shape != labels.shape:
        sidecar.fail(f'hu {hu.shape} and labels {labels.shape} are on different grids: map the labels to the scan first')
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    two = a.within is not None and len(a.within) == 2
    if two and a.seeds is not None:
        sidecar.fail('--within A,B seeds itself from each bone near the contact: drop --seeds')
    if not two and (a.within is None) != (a.seeds is None):
        sidecar.fail('--within L and --seeds go together')
    if two:
        full, new, at, info = cut_pair(labels, hu, a.within, a.threshold_hu, sp, a.reach_mm, a.seed_mm, a.bridge_max_mm3)
        out = np.asarray(labels).copy()
        out[full] = new
        lo, hi = sorted(a.within)
        np.savez_compressed(Path(a.out).with_name(f'{Path(a.out).stem}-cuts.npz'), **{f'{lo}-{hi}': at})
        np.save(a.out, out)
        sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.hu, a.labels],
                      params={'threshold_hu': a.threshold_hu, 'within': a.within, 'reach_mm': a.reach_mm, 'seed_mm': a.seed_mm,
                              'bridge_max_mm3': a.bridge_max_mm3, 'moved_mm3': info['moved_mm3']})
        vox = float(np.prod(sp))
        ids, counts = np.unique(out[out > 0], return_counts=True)
        sidecar.emit(labels=a.out, volume_mm3={int(i): round(float(c) * vox, 4) for i, c in zip(ids, counts)}, **info)
        raise SystemExit(0)
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
