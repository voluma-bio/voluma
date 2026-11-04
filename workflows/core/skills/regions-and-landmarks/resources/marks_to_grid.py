"""A researcher's mark (mm on the image it was drawn on) onto a grid: a section's curve, or a seed in an outline.

A mark arrives in mm, (x, y, z), as your delivery prints it: "drawn on tibia-grid v1 ... at (2.11, 1.81, 2.13)–(2.38, 1.81, 2.11)– ... mm".
`--world` takes that line as it is: it reads the bracketed triples after whichever of " at " and " to " comes last (a moved
mark, "from (...) to (...) mm", gives its new place), so numbers in the tag, the version or the length are not read as points.
The review's mm are not the scan's world mm: they are voxel index (x, y, z) times spacing on the image the mark was drawn on, from
that image's voxel 0, unrotated (the review places every image so; `packages/harness/src/agents/tools/report-output.ts`
`detailFromSidecar`). So `--drawn-on` is the header of that image, the output the delivery names after "drawn on" (its sidecar,
the `.json` beside its `.npy`, from `/run/outputs.yaml`): its spacing turns the mm into that image's voxels. `--grid` is the
header of the grid you work on: the scan's `hu.json`, or a frame's `frame.json` (an aligned stack such as the tibia's
`tibia-frame.json`). When both are the same grid (same `grid_id`), that is all; when not (drawn on the scan, worked on the tibia
grid), both headers need `affine_xyz_to_world_mm`, which carries the voxels from one grid to the other through the scan's world
mm: then pass the drawn-on grid's `hu.json` or `frame.json` rather than an array sidecar.

Two modes, give exactly one:

`--curve`: the mark is a line or path drawn along a face on one section, and becomes that section's curve in the curve schema
(`regions-and-landmarks`): {"axis": A, "height": "row", "slices": {"<s>": [[row, col], ...]}}, where A is `--axis` (default
1, V on the tibia grid, so a point is [W, U]) and <s> the section it lies on. The points keep the order drawn; a point that does not
advance along the section (a hand wavering on a steep stretch) is dropped. Refused: a mark whose points lie more than
`--max-off-section` voxels apart along A (drawn across sections: ask for it on one section of that grid); a mark that turns
back along the section more than a few voxels (an outline drawn around the plate, a path that doubles back), since a curve has
one row per column; points outside the grid. With `--into annotations.json --key <curve key>` the mark is spliced into that section of a copy of
the file, written to `--out`: the section's points within the mark's column range are replaced, those beyond its ends kept,
and every other key and section stays as it was (the file's `grid_id` must be this grid's). `--key` is the curve the mark corrects; the
script cannot tell which, since a correction can land nearer another curve than its own. `moved_vox` is the median row change
over the columns the old and new curve share (how far the mark moves that curve); `vox_from_key` gives the same for every curve
key on that section. Without `--into`, `--out` gets the curve alone, with the grid's `grid_id`. Check the result on that section's
view as you would your own trace, and trace the neighbouring sections to meet it.

`--seed --labels labels.npy`: the mark is an outline drawn around a piece that does not belong to the region (an ossicle on the
plateau, a patella fragment). It prints a seed: a labelled voxel inside the outline, on the outline's plane, as far from the
outline's edge as it can be, in the apart piece of at least 50 voxels the outline takes in most of (else the part it takes in most of): smaller
specks are listed but never chosen. `apart` is true when the
26-connected part of the label under the seed is not that label's largest; `pieces` lists each part the outline takes in.
`--labels` must be on `--grid`. A piece apart: `relabel.py --at <seed>` moves that part whole. A piece joined to the bone
(`apart` false): `relabel.py` would move the whole bone, so split it with `classic_segment.py --within <label> --seeds`, a seed
for the bone and this one for the piece (`segmentation-check`).

Writes: <out>  --curve only: the annotations copy, or the curve alone
Prints: one JSON line: --curve {grid_id, axis, section, points, cols_replaced, kept_points, moved_vox, vox_from_key, off_section_vox, out};
        --seed {grid_id, seed_zyx, label, apart, piece_voxels, pieces: [{label, apart, piece_voxels, inside_voxels}], off_plane_vox}
Example: python marks_to_grid.py --curve --world "at (2.11, 1.81, 2.13)–(2.38, 1.81, 2.11)–(2.64, 1.81, 2.10) mm" --drawn-on tibia-frame.json --grid tibia-frame.json --into annotations.json --key growth_plate_curves --out annotations-marked.json
         python marks_to_grid.py --seed --world "(...)–(...)–(...)" --drawn-on hu.json --grid hu.json --labels labels.npy
Exits 2 with one sentence on bad input, before writing anything.
"""
import json
import re
from pathlib import Path

import numpy as np
import sidecar
from matplotlib.path import Path as Polygon
from scipy import ndimage as ndi

NUMBER = r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?'
TRIPLE = re.compile(rf'\(\s*({NUMBER})\s*,\s*({NUMBER})\s*,\s*({NUMBER})\s*\)')
TURN_BACK_VOX = 5.0  # how far a path may step back along the section before it counts as turning back (hand tremor on a steep step)
MIN_PIECE_VOX = 50  # an apart part smaller than this is noise, never the piece an outline is drawn around
SPLICE_MARGIN_VOX = 1.0  # old points this close to the mark's ends are replaced too, so the seam has no near-duplicate column


def world_points(text):
    """The (x, y, z) mm triples in `text`, in order, after whichever of ' at ' and ' to ' comes last: the tag comes before both."""
    cut = max(text.rfind(' at '), text.rfind(' to '))
    if cut >= 0:
        text = text[cut + 4:]
    found = TRIPLE.findall(text)
    if not found:
        sidecar.fail('--world holds no (x, y, z) point: pass the mark\'s points as your delivery prints them, "(2.11, 1.81, 2.13)–..."')
    return np.array(found, float)


def to_grid(xyz, drawn_on, header):
    """The review's mm (x, y, z) on the image `drawn_on` describes -> fractional voxel indices (z, y, x) of the grid `header` describes."""
    d = sidecar.grid(drawn_on)
    g = sidecar.grid(header)
    zyx = xyz[:, ::-1] / np.asarray(d['spacing_zyx_mm'], float)
    if d['grid_id'] == g['grid_id']:
        return g, zyx
    for path, h in ((drawn_on, d), (header, g)):
        if 'affine_xyz_to_world_mm' not in h:
            sidecar.fail(f'{path} has no affine_xyz_to_world_mm, and the mark was drawn on grid {d["grid_id"]}, not {g["grid_id"]}: pass '
                         'the hu.json that scan-intake wrote, or the frame.json of the stack, for both --drawn-on and --grid')
    world = np.asarray(d['affine_xyz_to_world_mm'], float) @ np.c_[zyx[:, ::-1], np.ones(len(zyx))].T
    idx = (np.linalg.inv(np.asarray(g['affine_xyz_to_world_mm'], float)) @ world).T[:, :3]
    return g, idx[:, ::-1]


def inside_grid(zyx, shape, what):
    shape = np.asarray(shape)
    out = np.any((zyx < -0.5) | (zyx > shape - 0.5), axis=1)
    if out.any():
        bad = np.round(zyx[out][0], 1).tolist()
        sidecar.fail(f'{out.sum()} point(s) of the mark fall outside the grid {what} (first at index {bad}, shape {shape.tolist()}): '
                     'the mark was drawn on another part of the scan, or this is the wrong grid')


def distance(pts, curve_pts):
    """Median row distance from the mark's points to a section's curve, over the columns both cover; None if they share none."""
    c = sorted(curve_pts, key=lambda q: q[1])
    if len(c) < 2:
        return None
    cu, cw = np.array([q[1] for q in c]), np.array([q[0] for q in c])
    mine = [q for q in pts if cu.min() <= q[1] <= cu.max()]
    if not mine:
        return None
    return round(float(np.median([abs(q[0] - np.interp(q[1], cu, cw)) for q in mine])), 1)


def curve(a, g, zyx):
    if 'shape' not in g:
        sidecar.fail(f'{a.grid} has no shape: pass a frame.json or the hu.json that scan-intake wrote')
    inside_grid(zyx, g['shape'], a.grid)
    if len(zyx) < 2:
        sidecar.fail('a curve needs at least two points: the mark has one')
    along = zyx[:, a.axis]
    spread = float(along.max() - along.min())
    if spread > a.max_off_section:
        sidecar.fail(f'the mark runs across sections {along.min():.1f} to {along.max():.1f} along axis {a.axis} of this grid ({spread:.1f} '
                     f'voxels, at most {a.max_off_section:g}): it was drawn on a plane that cuts this grid\'s sections; ask for it drawn on one '
                     'section of this grid, or trace it yourself')
    section = round(float(np.median(along)))
    row_ax, col_ax = [i for i in range(3) if i != a.axis]
    pts = [[round(float(p[row_ax]), 1), round(float(p[col_ax]), 1)] for p in zyx]
    if pts[-1][1] < pts[0][1]:
        pts = pts[::-1]
    cols = np.array([p[1] for p in pts])
    back = np.maximum.accumulate(cols) - cols
    if back.max() > TURN_BACK_VOX:
        i = int(np.argmax(back))
        sidecar.fail(f'the mark turns back along the section (at column {cols[i]:g}, {back[i]:.1f} voxels back): it is an outline drawn '
                     'around the plate or a path that doubles back, and a curve has one row per column; trace that section yourself from '
                     'its image, or ask for a path along the one face')
    ahead = np.r_[True, cols[1:] > np.maximum.accumulate(cols)[:-1]]
    pts = [p for p, keep in zip(pts, ahead) if keep]
    if len(pts) < 2:
        sidecar.fail('the mark spans less than one column of the section: draw it along the face')
    lo, hi = pts[0][1], pts[-1][1]
    kept, moved, distances = 0, None, {}
    if a.into:
        ann = json.loads(Path(a.into).read_text())
        if ann.get('grid_id') != g['grid_id']:
            sidecar.fail(f'{a.into} is on grid {ann.get("grid_id")}, the mark was mapped to {g["grid_id"]} ({a.grid}): pass the header '
                         'of the grid the annotations were traced on')
        old = ann.get(a.key)
        if old is not None and (old.get('axis') != a.axis or old.get('height', 'row') != 'row'):
            sidecar.fail(f'"{a.key}" in {a.into} is traced on axis {old.get("axis")}, not {a.axis}: pass --axis {old.get("axis")}')
        slices = dict((old or {}).get('slices', {}))
        before = sorted(slices.get(str(section), []), key=lambda q: q[1])
        distances = {k: distance(pts, v['slices'][str(section)]) for k, v in ann.items()
                     if isinstance(v, dict) and v.get('axis') == a.axis and str(section) in v.get('slices', {})}
        distances = {k: d for k, d in distances.items() if d is not None}
        moved = distances.get(a.key)
        outside = [q for q in before if q[1] < lo - SPLICE_MARGIN_VOX or q[1] > hi + SPLICE_MARGIN_VOX]
        kept = len(outside)
        slices[str(section)] = sorted(outside + pts, key=lambda q: q[1])
        ann[a.key] = {**(old or {}), 'axis': a.axis, 'height': 'row', 'slices': slices}
        doc = ann
    else:
        doc = {'grid_id': g['grid_id'], 'axis': a.axis, 'height': 'row', 'slices': {str(section): pts}}
    Path(a.out).write_text(json.dumps(doc, indent=1))
    sidecar.emit(grid_id=g['grid_id'], axis=a.axis, section=section, points=pts, cols_replaced=[lo, hi], kept_points=kept,
                 moved_vox=moved, vox_from_key=distances, off_section_vox=round(spread, 2), out=str(a.out))


def seed(a, g, zyx):
    lg = sidecar.grid(sidecar.sidecar_path(a.labels))
    if lg['grid_id'] != g['grid_id']:
        sidecar.fail(f'{a.labels} is on grid {lg["grid_id"]}, not {g["grid_id"]} ({a.grid}): pass the header of the labels\' grid')
    labels = np.load(a.labels, mmap_mode='r')
    inside_grid(zyx, labels.shape, a.labels)
    if len(zyx) < 3:
        sidecar.fail('an outline needs at least three points: the mark has fewer')
    centre = zyx.mean(0)
    *_, vt = np.linalg.svd(zyx - centre)
    e1, e2, normal = vt
    off_plane = float(np.abs((zyx - centre) @ normal).max())
    uv = (zyx - centre) @ np.c_[e1, e2]
    lo, hi = uv.min(0), uv.max(0)
    g1, g2 = np.meshgrid(np.arange(lo[0], hi[0] + 0.5, 0.5), np.arange(lo[1], hi[1] + 0.5, 0.5), indexing='ij')
    lattice = np.c_[g1.ravel(), g2.ravel()]
    lattice = lattice[Polygon(uv).contains_points(lattice)]
    if not len(lattice):
        sidecar.fail('the outline encloses no voxel: draw it around the piece')
    vox = np.clip(np.round(centre + lattice[:, :1] * e1 + lattice[:, 1:] * e2).astype(int), 0, np.array(labels.shape) - 1)
    vox, first = np.unique(vox, axis=0, return_index=True)
    lattice = lattice[first]
    lab = np.asarray(labels[vox[:, 0], vox[:, 1], vox[:, 2]]).astype(int)
    if not (lab != 0).any():
        sidecar.fail('no labelled voxel lies inside the outline on its plane: the piece is unlabelled, or the outline was drawn beside it')
    # Each labelled voxel inside: its 26-connected part, whether that part is the label's largest, and its size.
    part_of = np.zeros(len(vox), int)
    apart = np.zeros(len(vox), bool)
    size_of = {}
    for label in np.unique(lab[lab != 0]):
        parts, _ = ndi.label(np.asarray(labels) == label, np.ones((3, 3, 3)))
        sizes = np.bincount(parts.ravel())
        main = int(np.argmax(sizes[1:])) + 1
        on = lab == label
        ids = parts[vox[on, 0], vox[on, 1], vox[on, 2]]
        part_of[on] = ids
        apart[on] = ids != main
        for k in np.unique(ids):
            size_of[(int(label), int(k))] = int(sizes[k])
    ring = np.r_[uv, uv[:1]]
    seg_a, d = ring[:-1], ring[1:] - ring[:-1]

    def edge_distance(p):
        t = np.clip(((p - seg_a) * d).sum(1) / np.maximum((d * d).sum(1), 1e-12), 0, 1)
        return float(np.min(np.linalg.norm(seg_a + t[:, None] * d - p, axis=1)))

    pieces = []
    for label, k in sorted({(int(lab[i]), int(part_of[i])) for i in np.flatnonzero(lab != 0)}):
        on = (lab == label) & (part_of == k)
        pieces.append({'label': label, 'apart': bool(apart[on][0]), 'piece_voxels': size_of[(label, k)], 'inside_voxels': int(on.sum()),
                       'part': k})
    # The seed's piece: the apart piece the outline takes in most of, else the part it takes in most of.
    target = max(pieces, key=lambda p: (p['apart'] and p['piece_voxels'] >= MIN_PIECE_VOX, p['inside_voxels']))
    pool = np.flatnonzero((lab == target['label']) & (part_of == target.pop('part')))
    for p in pieces:
        p.pop('part', None)
    best = pool[np.argmax([edge_distance(lattice[i]) for i in pool])]
    sidecar.emit(grid_id=g['grid_id'], seed_zyx=vox[best].tolist(), label=int(lab[best]), apart=bool(apart[best]),
                 piece_voxels=size_of[(int(lab[best]), int(part_of[best]))], pieces=pieces, off_plane_vox=round(off_plane, 2))


def main():
    ap = sidecar.parser(__doc__)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--curve', action='store_true', help='the mark is a line or path along a face on one section: write it as that section\'s curve')
    mode.add_argument('--seed', action='store_true', help='the mark is an outline around a piece: print a labelled voxel inside it')
    ap.add_argument('--world', required=True, help='the mark\'s points in mm, as your delivery prints them')
    ap.add_argument('--drawn-on', type=sidecar.existing, required=True,
                    help='header of the image the mark was drawn on (the output after "drawn on" in the delivery): its sidecar, hu.json or frame.json')
    ap.add_argument('--grid', type=sidecar.existing, required=True, help='header of the grid to map onto: hu.json or a frame.json')
    ap.add_argument('--axis', type=int, choices=(0, 1, 2), default=1, help='--curve: the array axis the sections are cut across (default 1)')
    ap.add_argument('--max-off-section', type=float, default=2.0, help='--curve: how far apart along --axis the mark\'s points may lie, voxels')
    ap.add_argument('--into', type=sidecar.existing, help='--curve: annotations.json to copy with the mark spliced into its section')
    ap.add_argument('--key', help='--curve with --into: the curve key of the face the mark lies on, e.g. growth_plate_curves')
    ap.add_argument('--out', help='--curve: the file to write')
    ap.add_argument('--labels', type=sidecar.existing, help='--seed: labels.npy on --grid, with its sidecar')
    a = ap.parse_args()
    if a.curve and not a.out:
        sidecar.fail('--curve writes a file: give --out')
    if a.curve and bool(a.into) != bool(a.key):
        sidecar.fail('--into and --key go together: the annotations file and the curve key of the face the mark lies on')
    if a.seed and not a.labels:
        sidecar.fail('--seed needs --labels, the labels the piece is in')
    g, zyx = to_grid(world_points(a.world), a.drawn_on, a.grid)
    (curve if a.curve else seed)(a, g, zyx)


if __name__ == '__main__':
    main()
