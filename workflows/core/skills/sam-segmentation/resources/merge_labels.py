"""Merge a small-structure request into the big-bone labels; a contested voxel goes to the nearer side.

`segment_sam` rejects duplicate labels, so a structure in several 3D pieces was sent with one temporary label per piece
(61 and 62 for the two pieces of label 6). `--map temp:final` renames each; several temps may map to one final label, and
`temp:0` drops one. The two volumes must be on the same grid (map the small request to the scan grid with `to_scan.py` first).

One rule: a voxel only one request claims keeps that label. A voxel both claim (small label L over big label B) goes
to whichever of L's own voxels (claimed by the small request alone) or B's own voxels (claimed by the big request alone)
is nearer, measured in mm; a tie stays with B, and a pair with no small own voxels stays with B. Distances are exact:
B's own voxels are searched only as far as the farthest contested voxel is from L's own. So the cut falls midway between
the two requests' own voxels, and no contested voxel goes to a third label or to background. Neither request
wins by default: big bones winning gave a third of each OA7-1L sesamoid to the femur, and small structures
winning gave a leaking small piece 0.3 mm3 of OA6-1RK's patella (`.context/evidence.md`, sam-segmentation). Each
contested voxel is counted in the output by big label and by where it went, and `big_lost` totals what each big label
gave away against its size, so a leak shows: a small label with a large contested count against its volume, or a big
label that lost much, is a To check item. A big label with no own voxels is lost whole to the small side, which
`big_lost` shows. Refused, before anything is written: a small temp label that takes more than `--max-big-share` of a big
label's voxels after the nearest rule (that track followed the bone: on OA6-2RK a "small structure" track took 31% of SAM's
tibia, splitting it midway), a temp or final label that is also a label in `--big`, a label in `--small` that `--map` does not
mention, volumes of different shape or grid id.

Writes: <out>  the merged labels (.npy, the grid of --big), with its sidecar (the map)
Prints: one JSON line {labels, merged: {temp label: {final, voxels, contested: {big label: {to_small, to_big}}}}, big_lost: {big label: {voxels, of}}, volume_mm3: {label id: volume of the result}}
Example: python merge_labels.py --big labels_big.npy --small small_trimmed.npy --map 61:6 62:6 5:5 --out labels_merged.npy
Exits 2 with one sentence on bad input, before writing anything.
"""

import numpy as np
import sidecar
from scipy import ndimage

# Share of a big label a temp takes after the nearest rule. OA6-2RK rehearsal (4df02afe), bone-clipped tracks on the scan grid:
# real small structures take at most 2.8% of any big bone (temp 63, label 6's piece, of the tibia; OA6-1RK's temp 63, which held
# 17% of the patella, takes almost none of it: patella Dice 0.942 against 0.941 when big wins, core/.context/evidence.md); the
# two tracks that followed a bone take 31% of the tibia and 19% of the fibula (temp 64) and 42% of the fibula (temp 65)
MAX_BIG_SHARE = 0.10


def distance_at(own, points, spacing):
    """mm from each voxel in `points` (index arrays into `own`) to the nearest voxel of `own`. The feature transform alone takes
    12 bytes per voxel where scipy's distance transform takes about 48 (8.7 GB on a track that followed OA6-2RK's tibia); the
    distance is then the one scipy computes from it, at the points only."""
    ft = ndimage.distance_transform_edt(~own, sampling=spacing, return_distances=False, return_indices=True)
    d = (ft[(slice(None), *points)] - np.array(points)).astype(np.float64)
    del ft
    d *= np.asarray(spacing, np.float64)[:, None]
    return np.sqrt(np.add.reduce(d * d, axis=0))


if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--big', type=sidecar.existing, required=True, help='scan-grid labels of the big bones (clipped)')
    ap.add_argument('--small', type=sidecar.existing, required=True, help='scan-grid labels of the small request (trimmed, mapped back)')
    ap.add_argument('--map', nargs='+', required=True, metavar='temp:final', help='temporary label : label it goes back to (0 drops it)')
    ap.add_argument('--out', required=True, help='merged labels .npy to write')
    ap.add_argument('--max-big-share', type=float, default=MAX_BIG_SHARE,
                    help='a small temp label that takes more than this share of a big label\'s voxels after the nearest rule is refused')
    a = ap.parse_args()
    try:
        mapping = {int(t): int(f) for t, f in (m.split(':') for m in a.map)}
    except ValueError:
        sidecar.fail(f'--map takes temp:final integer pairs such as 61:6 62:6, got {a.map}')
    big = np.load(a.big)
    small = np.load(a.small)
    if big.shape != small.shape:
        sidecar.fail(f'{a.big} {big.shape} and {a.small} {small.shape} are on different grids: map the small request to the scan grid first')
    g_big, g_small = sidecar.grid(sidecar.sidecar_path(a.big)), sidecar.grid(sidecar.sidecar_path(a.small))
    if g_big['grid_id'] != g_small['grid_id']:
        sidecar.fail('the two volumes have different grid ids: both must be on the scan grid')
    big_ids, big_sizes = np.unique(big, return_counts=True)
    clash = sorted(set(mapping) & {int(i) for i in big_ids})
    if clash:
        sidecar.fail(f'temporary labels {clash} are already labels in {a.big}: choose temporary labels the big bones do not use')
    taken = sorted({f for f in mapping.values() if f > 0} & {int(i) for i in big_ids if i > 0})
    if taken:
        sidecar.fail(f'final labels {taken} are already labels in {a.big}: a small structure goes back under a label the big bones do not use')
    present = {int(i) for i in np.unique(small) if i > 0}
    stray = sorted(present - set(mapping))
    if stray:
        sidecar.fail(f'{a.small} holds labels {stray} that --map does not mention: map each to its final label (or to 0 to drop it)')
    spacing = g_big['spacing_zyx_mm']
    claiming = [t for t, label in mapping.items() if label > 0]
    sizes = dict(zip(big_ids.tolist(), big_sizes.tolist()))
    boxes = ndimage.find_objects(small)
    out = big.copy()
    report = {temp: {'final': label, 'voxels': int((small == temp).sum()), 'contested': {}} for temp, label in mapping.items()}
    lost = {}
    for label in sorted({mapping[t] for t in claiming}):
        temps = [t for t in claiming if mapping[t] == label and t in present]
        if not temps:
            continue
        lo = [min(boxes[t - 1][k].start for t in temps) for k in range(3)]
        hi = [max(boxes[t - 1][k].stop for t in temps) for k in range(3)]
        box = tuple(slice(l, h) for l, h in zip(lo, hi))
        sm, b = small[box], big[box]
        mine = np.isin(sm, temps)
        own_small = mine & (b == 0)
        out[box][own_small] = label
        contested = [(int(bl), np.nonzero(mine & (b == bl))) for bl in np.unique(b[mine & (b > 0)])]
        # the label's box holds all its own voxels, so the small side's distance is exact inside it
        d_small = [distance_at(own_small, at, spacing) for _, at in contested] if own_small.any() else None
        for (big_label, at), d_s in zip(contested, d_small or [None] * len(contested), strict=True):
            to_small = np.zeros(len(at[0]), bool)
            if d_s is not None:
                # a big own voxel farther than the farthest contested voxel's small distance cannot win a contest
                reach = [int(np.ceil(d_s.max() / sp)) + 1 for sp in spacing]
                crop = tuple(slice(max(0, l + int(i.min()) - r), l + int(i.max()) + 1 + r) for l, i, r in zip(lo, at, reach))
                own_big = (big[crop] == big_label) & ~np.isin(small[crop], claiming)
                if own_big.any():
                    to_small = d_s < distance_at(own_big, tuple(l + i - c.start for l, i, c in zip(lo, at, crop)), spacing)
                else:
                    to_small[:] = True
                out[tuple(l + i[to_small] for l, i in zip(lo, at))] = label
            lost[big_label] = lost.get(big_label, 0) + int(to_small.sum())
            v = sm[at]
            for temp in temps:
                n_temp = v == temp
                if n_temp.any():
                    report[temp]['contested'][big_label] = {'to_small': int((n_temp & to_small).sum()), 'to_big': int((n_temp & ~to_small).sum())}
    big_lost = {b: {'voxels': v, 'of': sizes[b]} for b, v in sorted(lost.items())}
    taken = {}  # (final label, big label) -> voxels taken, summed over the temps: a track sent as two temps is one track
    for temp, r in report.items():
        for b, c in r['contested'].items():
            taken.setdefault((r['final'], b), []).append((temp, c['to_small']))
    followed = [(temps, b, sum(n for _, n in temps)) for (_, b), temps in sorted(taken.items())
                if sum(n for _, n in temps) > a.max_big_share * sizes[b]]
    if followed:
        # the temps that carry the take (a quarter of it or more), not every temp that touched the bone
        drop = ' '.join(f'{t}:0' for t in sorted({t for temps, _, n in followed for t, m in temps if m * 4 >= n}))
        said = '; '.join(f'temps of label {next(r["final"] for t, _ in temps for r in [report[t]])} take {n} of big label {b}\'s {sizes[b]} '
                         f'voxels ({n / sizes[b]:.0%}: ' + ', '.join(f'{t} {m / sizes[b]:.1%}' for t, m in temps) + ')'
                         for temps, b, n in followed)
        sidecar.fail(f'{said} after the nearest rule: a small-structure track that takes more than {a.max_big_share:.0%} of a big bone '
                     f'followed that bone, not a small structure. Drop the track(s) that carry it ({drop} in --map) and redo that structure: a new segment_sam '
                     'request with a tight box on the piece itself (snap_boxes.py), negative points on the big bone inside the box, and '
                     'direction or otherFrames where it drifts; or write your own cleanup of the track (keep what lies across the joint '
                     'space from the bone, drop what overlaps its label) and show it on a crop sheet. Never label the bare threshold '
                     'candidate instead (sam-segmentation, "When a track fails"). The bone the big track missed is then unlabelled bone '
                     'fused to it, for segmentation-check')
    vox = float(np.prod(spacing))
    np.save(a.out, out)
    sidecar.write(a.out, like=sidecar.sidecar_path(a.big), inputs=[a.big, a.small], params={'map': {str(k): v for k, v in mapping.items()}})
    ids, counts = np.unique(out, return_counts=True)
    sidecar.emit(labels=a.out, merged=report, big_lost=big_lost, volume_mm3={int(i): round(float(c) * vox, 4) for i, c in zip(ids, counts) if i > 0})
