"""Snap a pick made on a pane of a quad view to the bone, as voxel indices on the scan grid, and draw it.

  surface   a pixel on the 3D pane: cast the pane's camera ray into the mask, snap to the first surface voxel it meets
            (or, if the ray misses, the surface voxel nearest the ray)
  slice     a pixel on a slice pane, axis-aligned or oblique: snap by `center`, `nearest`, `edge_min`, `edge_max` or `exact`

Pixels are those of the quad view image (`visual-check/resources/quad_view.py`); its `.view.json` holds each pane's rectangle,
pixel -> voxel map and camera. Writes points.json (zyx voxel indices on the grid of --grid, snap distance in mm) and
pick-check.jpg: the pick (red x) and where it snapped (green circle) drawn on the pane. Look at pick-check.jpg before you keep
the points. Input schema: ../SKILL.md.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/;
# only missing directories are added, so a script imported by another leaves the importer's order alone.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [d for d in (str(HERE), str(SKILLS / 'microct-core/resources'), str(SKILLS / 'visual-check/resources')) if d not in sys.path]
try:
    import viewlib as vl
except ModuleNotFoundError as e:
    print(f'{e}: a skill this script imports is missing; it expects <workflows>/core/skills/<skill>/resources/, or '
          '<workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it', file=sys.stderr)
    sys.exit(2)

sidecar = vl.sidecar
plt = vl.plt


def surface_voxels(mask):
    return mask & ~ndi.binary_erosion(mask)


def snap_to_surface(view, mask, tree, surf_idx, col, row):
    sp = view.sp
    d = view.ray(col, row)
    step = float(sp.min()) * 0.5
    far = float(np.linalg.norm(np.array(mask.shape) * sp)) * 2
    t = np.arange(0, far, step)
    pts_zyx = ((view.pos[None, :] + t[:, None] * d[None, :])[:, ::-1]) / sp
    idx = np.rint(pts_zyx).astype(int)
    inside = np.all((idx >= 0) & (idx < np.array(mask.shape)), axis=1)
    hit = np.zeros(len(t), bool)
    hit[inside] = mask[tuple(idx[inside].T)]
    if hit.any():
        first = int(np.argmax(hit))
        dist, j = tree.query(pts_zyx[first] * sp)
        return surf_idx[j], float(dist), 'ray_hit'
    # Ray misses: the surface voxel closest to the ray, in front of the camera.
    p_xyz = surf_idx[:, ::-1] * sp[::-1] - view.pos
    along = p_xyz @ d
    off = np.linalg.norm(p_xyz - along[:, None] * d[None, :], axis=1)
    off[along <= 0] = np.inf
    j = int(np.argmin(off))
    if not np.isfinite(off[j]):
        sidecar.fail('the mask is behind the camera: check the camera position and focal_point')
    return surf_idx[j], float(off[j]), 'nearest_to_ray'


def snap_in_plane(plane, col, row, mode):
    """Snap the pixel (col, row) of a bool image of the mask on a pane. Returns (row, col, note, on_mask)."""
    on = np.argwhere(plane)
    if mode == 'exact' or len(on) == 0:
        note = 'exact' if mode == 'exact' else 'no mask on this pane: raw pick kept'
        r, c = row, col
    elif mode == 'center':
        r, c = on.mean(axis=0)
        note = 'centroid of the mask on the pane'
    elif mode == 'nearest':
        k = int(np.argmin(((on - [row, col]) ** 2).sum(axis=1)))
        r, c = on[k]
        note = 'nearest mask pixel'
    elif mode in ('edge_min', 'edge_max'):
        c = on[:, 1].min() if mode == 'edge_min' else on[:, 1].max()
        r = np.median(on[on[:, 1] == c][:, 0])
        note = f'{mode[5:]} column of the mask on the pane, at the median row'
    else:
        sidecar.fail(f'unknown snap mode {mode!r}: use exact, center, nearest, edge_min or edge_max')
    ri, ci = round(r), round(c)
    on_mask = bool(plane[ri, ci]) if 0 <= ri < plane.shape[0] and 0 <= ci < plane.shape[1] else False
    return float(r), float(c), note, on_mask


def pane_of(pane, image_px):
    """The pane's rectangle and its pixel (col, row), from a pixel (col, row) read off the whole quad image."""
    x0, y0, x1, y1 = pane['rect']
    col, row = image_px[0] - x0, image_px[1] - y0
    if not (0 <= col < x1 - x0 and 0 <= row < y1 - y0):
        sidecar.fail(f'pixel {list(image_px)} is outside this pane, which spans x {x0}-{x1 - 1}, y {y0}-{y1 - 1} of the image')
    return col, row


def load_mask(a):
    if a.mask:
        m = np.load(a.mask, mmap_mode='r')
        if m.dtype != bool:
            sidecar.fail(f'{a.mask} is {m.dtype}, not bool: pass --labels with --ids for a label volume')
        return np.asarray(m), [a.mask]
    if not a.labels or not a.ids:
        sidecar.fail('pass --mask bone.npy (bool), or --labels labels.npy with --ids 1 2 ...')
    return np.isin(np.load(a.labels, mmap_mode='r'), a.ids), [a.labels]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--picks', required=True, help='JSON of the picks and the view; schema in SKILL.md')
    ap.add_argument('--mask', help='bool .npy of the structure to snap to')
    ap.add_argument('--labels', help='label .npy, with --ids')
    ap.add_argument('--ids', type=int, nargs='+')
    ap.add_argument('--grid', required=True, help='hu.json or a sidecar of the grid the mask is on')
    ap.add_argument('--out', required=True, help='output directory')
    a = ap.parse_args()
    spec = json.loads(Path(a.picks).read_text())
    g = sidecar.grid(a.grid)
    sp = np.asarray(g['spacing_zyx_mm'], float)
    mask, inputs = load_mask(a)
    if not mask.any():
        sidecar.fail('the mask is empty: nothing to snap to')
    view = json.loads(Path(spec['view']).read_text())
    if view['state']['scan']['grid_id'] != g['grid_id']:
        sidecar.fail(f'{spec["view"]} was drawn on another grid than {a.grid}: the mask and the view must share the scan grid')
    from PIL import Image

    inputs += [spec['view'], view['image']]
    img = Image.open(view['image']).convert('RGB')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    mode = spec.get('mode')
    results = []
    if mode == 'surface':
        pane = view['3d']
        crop = img.crop(pane['rect'])
        cam = vl.View(pane['camera'], crop.size, sp)
        box = tuple(slice(max(b.start - 1, 0), b.stop + 1) for b in ndi.find_objects(mask.astype(np.uint8))[0])
        surf = np.argwhere(surface_voxels(mask[box])) + [b.start for b in box]
        tree = cKDTree(surf * sp)
        fig = plt.figure(figsize=(crop.size[0] / 100, crop.size[1] / 100))
        ax = fig.add_axes((0, 0, 1, 1))
        ax.imshow(crop)
        for p in spec['picks']:
            col, row = pane_of(pane, p['pixel'])
            zyx, dist, how = snap_to_surface(cam, mask, tree, surf, col, row)
            results.append({'name': p['name'], 'zyx': [int(v) for v in zyx], 'snap_distance_mm': dist, 'method': how,
                            'pick_pixel': p['pixel']})
            draw(ax, p['name'], (col, row), cam.project(zyx))
    elif mode == 'slice':
        k = spec['pane']
        pane = view['panes'][k]
        crop = img.crop(pane['rect'])
        o, dr, dc = (np.asarray(pane[key], float) for key in ('origin_zyx', 'd_row_zyx', 'd_col_zyx'))
        n = crop.size[0]
        r, c = np.mgrid[0:n, 0:n]
        at = lambda row, col: o + row * dr + col * dc  # scan voxel indices of a pane pixel
        plane = ndi.map_coordinates(mask.view(np.uint8), np.moveaxis(at(r[..., None], c[..., None]), -1, 0), order=0) > 0
        fig = plt.figure(figsize=(n / 100, n / 100))
        ax = fig.add_axes((0, 0, 1, 1))
        ax.imshow(crop)
        ax.contour(plane, levels=[0.5], colors='cyan', linewidths=0.8)
        for p in spec['picks']:
            col, row = pane_of(pane, p['pixel'])
            rs, cs, note, on_mask = snap_in_plane(plane, col, row, p.get('snap', 'nearest'))
            zyx = at(rs, cs)
            results.append({'name': p['name'], 'zyx': [round(float(v), 2) for v in zyx],
                            'snap_distance_mm': float(np.linalg.norm((zyx - at(row, col)) * sp)), 'method': note,
                            'on_mask': on_mask, 'pick_pixel': p['pixel'], 'pane': k})
            draw(ax, p['name'], (col, row), (cs, rs))
    else:
        sidecar.fail('the picks JSON needs "mode": "surface" or "slice"')
    fig_path = out / 'pick-check.jpg'
    sidecar.save_image(fig, fig_path)
    plt.close(fig)
    (out / 'points.json').write_text(
        json.dumps(
            {
                'points': results,
                'grid_id': g['grid_id'],
                'spacing_zyx_mm': g['spacing_zyx_mm'],
                'mode': mode,
                'inputs': {str(p): sidecar.sha256_file(p) for p in inputs + [a.picks, a.grid]},
            },
            indent=1,
        )
        + '\n'
    )
    sidecar.emit(
        points=str(out / 'points.json'),
        check=str(fig_path),
        snapped=[{'name': r['name'], 'zyx': r['zyx'], 'snap_distance_mm': round(r['snap_distance_mm'], 4)} for r in results],
    )


def draw(ax, name, pick, snapped):
    ax.plot(*pick, 'x', color='red', ms=12, mew=2)
    if snapped is not None:
        ax.plot(*snapped, 'o', mfc='none', mec='lime', ms=14, mew=2)
    ax.annotate(name, pick, color='yellow', fontsize=12, xytext=(8, -8), textcoords='offset points')


if __name__ == '__main__':
    main()
