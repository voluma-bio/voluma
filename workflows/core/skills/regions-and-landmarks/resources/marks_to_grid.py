"""A researcher's mark in world mm onto a grid: a section's curve in annotations, or a seed in an outline.

A mark arrives in world mm, (x, y, z), as the review shows it ("(8.12, 5.03, 129.4)–(8.20, 5.10, 129.4)–..."). `--world` takes
that text as it is, or any list of numbers in threes. `--grid` is the header of the grid you work on: the scan's `hu.json`,
or a frame's `frame.json` (an aligned stack such as the tibia's `tibia-frame.json`). Its `affine_xyz_to_world_mm` maps indices
to the same world mm as the review, so the mark lands on that grid without other maths.

Two modes, give exactly one:

`--curve`: the mark is a line drawn along a section (a path, or a line's two ends), and becomes that section's curve in the
curve schema (`regions-and-landmarks`): {"axis": A, "height": "row", "slices": {"<s>": [[row, col], ...]}}, sorted by column,
where A is `--axis` (default 1, V on the tibia grid, so a point is [W, U]) and <s> the section it lies on. A mark drawn across
sections (its points more than `--max-off-section` apart along A) is refused: draw it on one section of that grid. With `--into
annotations.json --key <curve key>` the curve replaces (or adds) that section in a copy of the file, written to `--out`; every
other key and section stays as it was, and the file's `grid_id` must be this grid's. Without `--into`, `--out` gets the curve
alone, with the grid's `grid_id`. Points outside the grid are refused. The researcher's curve replaces the section's: check it
on that section's view as you would your own trace, and trace the neighbouring sections to meet it.

`--seed --labels labels.npy`: the mark is an outline around a piece that does not belong to the region (an ossicle on the
plateau, a patella fragment). It prints the labelled voxel inside the outline, on the outline's plane, that lies farthest from
the outline's edge, with its label, the voxel count of each label inside the outline, and whether the seed's piece stands
apart: `apart` is true when the 26-connected part of the label under the seed is not the label's largest. `--labels` must be on
`--grid`. A piece apart: `relabel.py --at <seed>` moves that part whole. A piece joined to the bone (`apart` false): `relabel.py`
would move the whole bone, so split it with `classic_segment.py --within <label> --seeds`, a seed for the bone and this one for
the piece (`segmentation-check`).

Writes: <out>  --curve only: the annotations copy, or the curve alone
Prints: one JSON line: --curve {grid_id, axis, section, points, off_section_vox, out}; --seed {grid_id, seed_zyx, label, inside: {label: voxels}, apart, piece_voxels, off_plane_vox}
Example: python marks_to_grid.py --curve --world "(8.1, 5.0, 129.4)–(8.3, 5.1, 129.4)–(8.5, 5.1, 129.5)" --grid tibia-frame.json --into annotations.json --key growth_plate_curves --out annotations-marked.json
         python marks_to_grid.py --seed --world "(...)–(...)–(...)" --grid hu.json --labels labels.npy
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


def world_points(text):
    """The (x, y, z) mm triples in `text`, in order."""
    vals = [float(v) for v in re.findall(NUMBER, text)]
    if len(vals) < 3 or len(vals) % 3:
        sidecar.fail(f'--world holds {len(vals)} numbers: give the mark\'s points in world mm as x, y, z triples, as the review shows them')
    return np.array(vals).reshape(-1, 3)


def to_grid(xyz, header):
    """World mm (x, y, z) -> fractional voxel indices (z, y, x) of the grid `header` describes."""
    g = sidecar.grid(header)
    if 'affine_xyz_to_world_mm' not in g:
        sidecar.fail(f'{header} has no affine_xyz_to_world_mm: pass the hu.json that scan-intake wrote, or the frame.json of the stack')
    inv = np.linalg.inv(np.asarray(g['affine_xyz_to_world_mm'], float))
    idx = (inv @ np.c_[xyz, np.ones(len(xyz))].T).T[:, :3]
    return g, idx[:, ::-1]


def inside_grid(zyx, shape, what):
    shape = np.asarray(shape)
    out = np.any((zyx < -0.5) | (zyx > shape - 0.5), axis=1)
    if out.any():
        bad = np.round(zyx[out][0], 1).tolist()
        sidecar.fail(f'{out.sum()} point(s) of the mark fall outside the grid {what} (first at index {bad}, shape {shape.tolist()}): '
                     'the mark was drawn on another part of the scan, or this is the wrong grid')


def curve(a, g, zyx):
    if 'shape' not in g:
        sidecar.fail(f'{a.grid} has no shape: pass a frame.json or the hu.json that scan-intake wrote')
    inside_grid(zyx, g['shape'], a.grid)
    along = zyx[:, a.axis]
    spread = float(along.max() - along.min())
    if spread > a.max_off_section:
        sidecar.fail(f'the mark runs across sections {along.min():.1f} to {along.max():.1f} along axis {a.axis} of this grid ({spread:.1f} '
                     f'voxels, at most {a.max_off_section:g}): it was drawn on a plane that cuts this grid\'s sections; ask for it drawn on one '
                     'section of this grid, or trace it yourself')
    if len(zyx) < 2:
        sidecar.fail('a curve needs at least two points: the mark has one')
    section = round(float(np.median(along)))
    row_ax, col_ax = [i for i in range(3) if i != a.axis]
    pts = sorted(([round(float(p[row_ax]), 1), round(float(p[col_ax]), 1)] for p in zyx), key=lambda q: q[1])
    spec = {'axis': a.axis, 'height': 'row', 'slices': {str(section): pts}}
    if a.into:
        ann = json.loads(Path(a.into).read_text())
        if ann.get('grid_id') != g['grid_id']:
            sidecar.fail(f'{a.into} is on grid {ann.get("grid_id")}, the mark was mapped to {g["grid_id"]} ({a.grid}): pass the header '
                         'of the grid the annotations were traced on')
        old = ann.get(a.key)
        if old is not None and (old.get('axis') != a.axis or old.get('height', 'row') != 'row'):
            sidecar.fail(f'"{a.key}" in {a.into} is traced on axis {old.get("axis")}, not {a.axis}: pass --axis {old.get("axis")}')
        ann[a.key] = {'axis': a.axis, 'height': 'row', 'slices': {**(old or {}).get('slices', {}), str(section): pts}}
        doc = ann
    else:
        doc = {'grid_id': g['grid_id'], **spec}
    Path(a.out).write_text(json.dumps(doc, indent=1))
    sidecar.emit(grid_id=g['grid_id'], axis=a.axis, section=section, points=pts, off_section_vox=round(spread, 2), out=str(a.out))


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
    poly = Polygon(uv)
    lo, hi = uv.min(0), uv.max(0)
    g1, g2 = np.meshgrid(np.arange(lo[0], hi[0] + 0.5, 0.5), np.arange(lo[1], hi[1] + 0.5, 0.5), indexing='ij')
    lattice = np.c_[g1.ravel(), g2.ravel()]
    keep = poly.contains_points(lattice)
    if not keep.any():
        sidecar.fail('the outline encloses no voxel: draw it around the piece')
    lattice = lattice[keep]
    vox = np.round(centre + lattice[:, :1] * e1 + lattice[:, 1:] * e2).astype(int)
    vox = np.clip(vox, 0, np.array(labels.shape) - 1)
    vox, first = np.unique(vox, axis=0, return_index=True)
    lattice = lattice[first]
    lab = np.asarray(labels[vox[:, 0], vox[:, 1], vox[:, 2]]).astype(int)
    counts = {str(k): int(n) for k, n in zip(*np.unique(lab, return_counts=True)) if k != 0}
    if not counts:
        sidecar.fail('no labelled voxel lies inside the outline on its plane: the piece is unlabelled, or the outline was drawn beside it')
    ring = np.r_[uv, uv[:1]]
    seg_a, seg_b = ring[:-1], ring[1:]

    def edge_distance(p):
        d = seg_b - seg_a
        t = np.clip(((p - seg_a) * d).sum(1) / np.maximum((d * d).sum(1), 1e-12), 0, 1)
        return float(np.min(np.linalg.norm(seg_a + t[:, None] * d - p, axis=1)))

    labelled = np.flatnonzero(lab != 0)
    best = labelled[np.argmax([edge_distance(lattice[i]) for i in labelled])]
    at, label = vox[best], int(lab[best])
    parts, _ = ndi.label(np.asarray(labels) == label, np.ones((3, 3, 3)))
    sizes = np.bincount(parts.ravel())
    piece = int(sizes[parts[tuple(at)]])
    sidecar.emit(grid_id=g['grid_id'], seed_zyx=at.tolist(), label=label, inside=counts, apart=bool(piece < sizes[1:].max()),
                 piece_voxels=piece, off_plane_vox=round(off_plane, 2))


def main():
    ap = sidecar.parser(__doc__)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--curve', action='store_true', help='the mark is a line along one section: write it as that section\'s curve')
    mode.add_argument('--seed', action='store_true', help='the mark is an outline around a piece: print a labelled voxel inside it')
    ap.add_argument('--world', required=True, help='the mark\'s points in world mm, x, y, z each, as the review shows them')
    ap.add_argument('--grid', type=sidecar.existing, required=True, help='header of the grid to map onto: hu.json or a frame.json')
    ap.add_argument('--axis', type=int, choices=(0, 1, 2), default=1, help='--curve: the array axis the sections are cut across (default 1)')
    ap.add_argument('--max-off-section', type=float, default=2.0, help='--curve: how far apart along --axis the mark\'s points may lie, voxels')
    ap.add_argument('--into', type=sidecar.existing, help='--curve: annotations.json to copy with the section replaced')
    ap.add_argument('--key', help='--curve with --into: the curve key the section goes under, e.g. growth_plate_curves')
    ap.add_argument('--out', help='--curve: the file to write')
    ap.add_argument('--labels', type=sidecar.existing, help='--seed: labels.npy on --grid, with its sidecar')
    a = ap.parse_args()
    if a.curve and not a.out:
        sidecar.fail('--curve writes a file: give --out')
    if a.curve and bool(a.into) != bool(a.key):
        sidecar.fail('--into and --key go together: the annotations file and the curve key the section goes under')
    if a.seed and not a.labels:
        sidecar.fail('--seed needs --labels, the labels the piece is in')
    g, zyx = to_grid(world_points(a.world), a.grid)
    (curve if a.curve else seed)(a, g, zyx)


if __name__ == '__main__':
    main()
