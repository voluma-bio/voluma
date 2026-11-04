"""Clean up a scan: set what is not the specimen (holder, rod, padding, debris) to air, keeping all leg bone.

The specimen is found from its bone. The knee is the largest bone component at --threshold-hu (femur, tibia, fibula and
patella fuse at threshold); every other bone component within --near-mm of it stays too (sesamoids, fragments, fibula
pieces), as does any component you name with --keep. The specimen is then the matter (smoothed HU above --air-hu) joined to
that bone, after an erosion of --neck-mm severs it from anything that touches it through a contact thinner than twice that:
a holder tube, a strip of padding or the field's bright edge that only rests against the skin is cut off and removed. A holder
part that presses against the leg over a contact wider than 2 x --neck-mm stays joined and is kept: look for it in the
images and rerun with a larger --neck-mm. Matter within --margin-mm of kept bone always stays, so a thin bone's soft tissue
is never shaved. Every bone component stays whole, joined to the specimen or not, except the holder's rod (wholly within
--edge-mm of the field's edge, along at least half the scan's length) and pieces of the reconstruction's bright rim (wholly
within 0.15 mm of the outside of its circle). Each removed bone component is printed,
and each kept one beyond --near-mm of the knee, so a worker can raise a To check item for it (bone wrongly removed is lost
to every later step: --keep a removed piece that may be leg).
Works on a 2x-coarsened copy, so the result is decided in 2x2x2 blocks; voxels of the scan are copied or set, never changed.

Writes: <out>  the cleaned HU volume (.npy float32, the grid of --hu), with a sidecar like hu.json
        <mask-out>  the voxels set to -1000 HU (.npy bool, the scan grid), with a sidecar of kind removal_mask
Prints: one JSON line {out, mask, set_voxels, removed_mm3 (matter above --air-hu that was set), removed: [{mm3, centre_zyx,
  max_hu}] (each removed piece of --min-report-mm3 or more, largest first), bone_voxels_removed (voxels at threshold set to
  air), removed_bone: [{mm3, centre_zyx, max_hu, distance_mm}] (each bone component set to air, its distance to the knee),
  kept_far_bone: [{mm3, centre_zyx, max_hu, distance_mm}] (bone kept beyond --near-mm of the knee), knee_mm3}
Example: python clean_scan.py --hu hu.npy --threshold-hu scan-settings.json --out hu-clean.npy --mask-out removed.npy
Exits 2 with one sentence on bad input, before writing anything.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import sidecar
from scipy import ndimage as ndi

AIR_HU = -1000.0
F = 2  # coarsening factor per axis
CONN26 = np.ones((3, 3, 3), bool)
RIM_MM = 0.15  # mm: the reconstruction's bright rim lies this close to the outside of its circle


def coarsen(hu, threshold):
    """Mean HU and 'any voxel at threshold' of each FxFxF block, read a slab at a time (the scan never sits in memory twice)."""
    shape = tuple(-(-s // F) for s in hu.shape)
    mean = np.empty(shape, np.float32)
    bone = np.empty(shape, bool)
    for k in range(shape[0]):
        slab = np.asarray(hu[k * F:(k + 1) * F], np.float32)
        pad = [(0, F - slab.shape[0]), (0, shape[1] * F - slab.shape[1]), (0, shape[2] * F - slab.shape[2])]
        slab = np.pad(slab, pad, mode='edge').reshape(F, shape[1], F, shape[2], F)
        mean[k] = slab.mean((0, 2, 4))
        bone[k] = (slab >= threshold).any((0, 2, 4))
    return mean, bone


def within(mask, mm, sp):
    """Voxels within `mm` of `mask`."""
    return ndi.distance_transform_edt(~mask, sampling=sp) <= mm


def specimen(mean, bone, sp, a, keep_points):
    """The coarse specimen region, the bone labels, the knee's label, each bone label's distance to the knee, and what is above air."""
    lab, n = ndi.label(bone, CONN26)
    if n == 0:
        sidecar.fail(f'no voxel reaches {a.threshold_hu} HU, so there is no bone to find the specimen by: check --threshold-hu')
    ids = np.arange(1, n + 1)
    sizes = ndi.sum_labels(bone, lab, ids)
    knee = int(ids[np.argmax(sizes)])
    to_knee = ndi.distance_transform_edt(lab != knee, sampling=sp)
    dist = ndi.minimum(to_knee, lab, ids)
    del to_knee
    # Outside the reconstruction's circle every voxel is exactly -1000 (raw 0); inside, a 2x2x2 block of exact -1000 is rare
    # and lone, so the large pieces are the outside.
    exact, _ = ndi.label(mean == AIR_HU)
    big = np.bincount(exact.ravel()) * np.prod(sp) >= 0.01
    big[0] = False
    outfield = big[exact]
    del exact
    edge = within(outfield, a.edge_mm, sp) if outfield.any() else np.zeros_like(bone)
    rim = within(outfield, RIM_MM, sp) if outfield.any() else np.zeros_like(bone)
    # Bone at threshold that is not leg: the holder's rod (wholly in the field's edge, along at least half the scan's length)
    # and the reconstruction's bright rim (wholly within RIM_MM of the outside). Leg bone near the edge is a compact piece.
    long = np.array([b[0].stop - b[0].start >= lab.shape[0] / 2 for b in ndi.find_objects(lab)])
    rod = ((np.asarray(ndi.minimum(edge, lab, ids)) == 1) & long) | (np.asarray(ndi.minimum(rim, lab, ids)) == 1)
    del rim
    keep_ids = set()
    for p in keep_points:
        c = tuple(min(i // F, s - 1) for i, s in zip(p, lab.shape))
        if lab[c] == 0:
            sidecar.fail(f'--keep {",".join(map(str, p))} is not on bone at {a.threshold_hu} HU: give a voxel of the piece to keep')
        keep_ids.add(int(lab[c]))
    rod &= ~np.isin(ids, list(keep_ids))
    seeds_ids = set(ids[(np.asarray(dist) <= a.near_mm) & ~rod].tolist()) | keep_ids
    seeds = np.isin(lab, list(seeds_ids))

    above_air = (ndi.gaussian_filter(mean, a.smooth_mm / np.asarray(sp)) > a.air_hu) | bone
    matter = above_air & ~edge | (above_air & within(seeds, a.margin_mm, sp))  # the holder tube's wall runs along the edge
    core = ndi.distance_transform_edt(matter, sampling=sp) > a.neck_mm
    core_lab, _ = ndi.label(core, CONN26)
    joined = np.unique(core_lab[within(seeds, a.neck_mm + max(sp), sp) & core])
    core = np.isin(core_lab, joined[joined > 0])
    del core_lab
    region = (within(core, a.neck_mm + max(sp), sp) & matter) | (within(seeds, a.margin_mm, sp) & matter) | seeds
    region |= bone & ~np.isin(lab, ids[rod])  # every other bone stays whole, joined to the specimen or not
    return region, lab, knee, np.asarray(dist), above_air


def main(a):
    hu = np.load(a.hu, mmap_mode='r')
    header = Path(a.hu).with_suffix('.json')
    if not header.exists():
        sidecar.fail(f'{header} is missing: pass the hu.npy that scan-intake wrote, with its hu.json beside it')
    if hu.ndim != 3:
        sidecar.fail(f'{a.hu} has {hu.ndim} dimensions; a scan is a 3D volume')
    for p in a.keep:
        if any(not 0 <= i < s for i, s in zip(p, hu.shape)):
            sidecar.fail(f'--keep {",".join(map(str, p))} is outside the scan {list(hu.shape)}')
    sp = np.asarray(sidecar.grid(header)['spacing_zyx_mm'], float) * F
    vox_mm3 = float(np.prod(sp)) / F ** 3

    mean, bone = coarsen(hu, a.threshold_hu)
    region, lab, knee, dist, above_air = specimen(mean, bone, sp, a, a.keep)
    del mean
    gone, n_gone = ndi.label(above_air & ~region, CONN26)
    del above_air

    out = np.lib.format.open_memmap(a.out, 'w+', np.float32, hu.shape)
    mask = np.lib.format.open_memmap(a.mask_out, 'w+', bool, hu.shape)
    pieces, kept, cut = Tally(n_gone), Tally(int(lab.max())), Tally(int(lab.max()))
    iy = np.arange(hu.shape[1]) // F
    ix = np.arange(hu.shape[2]) // F
    for z in range(hu.shape[0]):
        s = np.asarray(hu[z], np.float32)
        keep = region[z // F][np.ix_(iy, ix)]
        out[z] = np.where(keep, s, AIR_HU)
        mask[z] = ~keep
        b = s >= a.threshold_hu
        bone_id = lab[z // F][np.ix_(iy, ix)]
        pieces.add(z, s, np.where(keep, 0, gone[z // F][np.ix_(iy, ix)]))
        kept.add(z, s, np.where(keep & b, bone_id, 0))
        cut.add(z, s, np.where(~keep & b, bone_id, 0))
    set_voxels = int(np.count_nonzero(mask))
    out.flush()
    mask.flush()
    del out, mask

    params = {'threshold_hu': a.threshold_hu, 'air_hu': a.air_hu, 'near_mm': a.near_mm, 'neck_mm': a.neck_mm,
              'margin_mm': a.margin_mm, 'edge_mm': a.edge_mm, 'smooth_mm': a.smooth_mm, 'keep_zyx': [list(p) for p in a.keep]}
    sidecar.write(a.out, like=header, inputs=[a.hu], params=params)
    side = sidecar.write(a.mask_out, like=header, inputs=[a.hu], params=params)
    side.write_text(json.dumps({**json.loads(side.read_text()), 'kind': 'removal_mask',
                                'meaning': 'true where clean_scan.py set the voxel to -1000 HU'}, indent=1) + '\n')

    removed = [pieces.entry(i, vox_mm3) for i in pieces.ids() if pieces.n[i] * vox_mm3 >= a.min_report_mm3]
    removed_bone = [{**cut.entry(i, vox_mm3), 'distance_mm': round(float(dist[i - 1]), 3)} for i in cut.ids()]
    far = [{**kept.entry(i, vox_mm3), 'distance_mm': round(float(dist[i - 1]), 3)} for i in kept.ids()
           if kept.n[i] * vox_mm3 >= a.min_report_mm3 and dist[i - 1] > a.near_mm]
    sidecar.emit(out=a.out, mask=a.mask_out, set_voxels=set_voxels, removed_mm3=round(pieces.n.sum() * vox_mm3, 4),
                 removed=sorted(removed, key=lambda r: -r['mm3']), bone_voxels_removed=int(cut.n.sum()),
                 removed_bone=sorted(removed_bone, key=lambda r: -r['mm3']),
                 kept_far_bone=sorted(far, key=lambda r: -r['mm3']), knee_mm3=round(kept.n[knee] * vox_mm3, 4))


class Tally:
    """Voxel count, centre and max HU per label, summed over the slices of the scan."""

    def __init__(self, n):
        self.n = np.zeros(n + 1, np.int64)
        self.sum = np.zeros((n + 1, 3))
        self.max = np.full(n + 1, -np.inf)

    def add(self, z, hu_slice, labels):
        yy, xx = np.nonzero(labels)
        ids = labels[yy, xx]
        self.n += np.bincount(ids, minlength=self.n.size)
        np.add.at(self.sum, ids, np.c_[np.full(yy.size, z), yy, xx])
        np.maximum.at(self.max, ids, hu_slice[yy, xx])

    def ids(self):
        return np.flatnonzero(self.n[1:]) + 1

    def entry(self, i, vox_mm3):
        return {'mm3': round(float(self.n[i] * vox_mm3), 4), 'centre_zyx': [int(c) for c in self.sum[i] / self.n[i]],
                'max_hu': round(float(self.max[i]))}


def point_arg(s):
    try:
        p = tuple(int(v) for v in s.split(','))
    except ValueError:
        p = ()
    if len(p) != 3:
        raise argparse.ArgumentTypeError(f'{s!r} is not z,y,x voxel indices')
    return p


if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--hu', type=sidecar.existing, required=True, help='hu.npy of the scan, with its hu.json beside it')
    ap.add_argument('--threshold-hu', type=sidecar.threshold_arg, required=True,
                    help='the scan\'s segmentation threshold: its scan-settings.json, or a number in HU')
    ap.add_argument('--out', required=True, help='cleaned HU .npy to write')
    ap.add_argument('--mask-out', required=True, help='removal mask .npy to write')
    ap.add_argument('--keep', type=point_arg, action='append', default=[], metavar='Z,Y,X',
                    help='a voxel of a bone piece to keep whatever its distance from the knee (repeatable)')
    ap.add_argument('--near-mm', type=float, default=1.0, help='mm: bone components this close to the knee stay')
    ap.add_argument('--neck-mm', type=float, default=0.25,
                    help='mm: matter joined to the specimen only through a contact thinner than twice this is cut off')
    ap.add_argument('--margin-mm', type=float, default=0.2, help='mm: matter this close to kept bone always stays')
    ap.add_argument('--edge-mm', type=float, default=0.5,
                    help='mm: matter this close to the edge of the reconstructed field (and not near kept bone) is holder')
    ap.add_argument('--air-hu', type=float, default=-400, help='HU: smoothed matter above this is not air')
    ap.add_argument('--smooth-mm', type=float, default=0.04, help='mm: Gaussian sigma of the smoothing --air-hu is applied to')
    ap.add_argument('--min-report-mm3', type=float, default=0.01, help='mm3: smaller removed pieces without bone, and smaller kept far bone, are not listed')
    a = ap.parse_args()
    for p in (a.out, a.mask_out):
        if not p.endswith('.npy'):
            ap.error(f'{p} must be a .npy path')
    paths = [Path(p).resolve() for p in (a.hu, a.out, a.mask_out)]
    if len(set(paths)) < 3:  # writing the output opens it 'w+', which zero-fills the scan it is reading
        sidecar.fail('--out, --mask-out and --hu must be three different files: write hu-clean.npy, then move it over hu.npy')
    main(a)
