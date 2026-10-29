"""6-view 3D sheet of a labels volume, one colour per label: the best check for "does one label cover two bones?" and
for small fragments merged into a big bone.

  python render_surfaces.py --labels labels.npy --out sheet.jpg [--frame frame.json] [--names 1=femur,2=tibia | anatomy.json]
        [--step 3] [--header hu.json]

Six views, 60 degrees apart, around the long axis of the limb (with `--frame`: the line from bone B's shaft to bone A's,
and the first view looks along the oriented stack's normal; without it: scan axis 0 points down and the first view looks
along axis 2). Surfaces are drawn from a copy downsampled by `--step` (default: so the longest axis is ~300 voxels), for
display only; never measure from them. The renders are of the array's axes, not the world's: left and right are not
asserted. Needs pyvista with an off-screen VTK (vtk-osmesa in the sandbox).
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from skimage.measure import marching_cubes

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path, so every directory a script imports from is added here.
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'microct-core/resources')]
try:
    import viewlib as vl
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects <workflows>/microct-analysis/skills/<skill>/resources/ with '
             '<workflows>/microct-analysis/skills/microct-core/resources/sidecar.py beside it')

sl = vl.sidecar
TILE = 640
MIN_VOXELS = 50  # smaller label pieces are not drawn


def meshes(lab, spacing, labels):
    import pyvista as pv
    out = {}
    for lv in labels:
        m = lab == lv
        if m.sum() < MIN_VOXELS:
            continue
        v, f, _, _ = marching_cubes(np.pad(m, 1).astype(np.float32), 0.5, spacing=spacing)
        v = v - np.array(spacing)  # undo the padding offset
        faces = np.hstack([np.full((len(f), 1), 3), f]).astype(np.int64).ravel()
        out[lv] = pv.PolyData(v[:, ::-1].copy(), faces).smooth(n_iter=20)
    return out


def view_vectors(frame):
    """(look-along, up) in mesh x,y,z, which is the array's z,y,x reversed."""
    if frame:
        up = np.array(frame['bone_a_axis_zyx']) - np.array(frame['bone_b_axis_zyx'])
        look = np.array(frame['normal_zyx'])
    else:
        up, look = np.array([-1.0, 0, 0]), np.array([0, 0, 1.0])
    return look[::-1] / np.linalg.norm(look), up[::-1] / np.linalg.norm(up)


def render_view(ms, look, up, azimuth, size):
    """One off-screen render of the meshes, as an image array."""
    import pyvista as pv
    pv.OFF_SCREEN = True
    p = pv.Plotter(off_screen=True, window_size=(size, size))
    p.set_background('black')
    for lv, mesh in ms.items():
        p.add_mesh(mesh, color=vl.colour(lv), smooth_shading=True)
    p.view_vector(tuple(look), viewup=tuple(up))
    p.camera.Azimuth(azimuth)
    p.camera.Elevation(15)
    p.reset_camera()
    img = p.screenshot(return_img=True)
    p.close()
    return img


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--labels', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--frame')
    ap.add_argument('--header', help='hu.json for the spacing (default: the labels sidecar)')
    ap.add_argument('--names', help='1=femur,2=tibia, or the anatomy.json path for every label name')
    ap.add_argument('--step', type=int)
    a = ap.parse_args()
    labels = np.load(a.labels, mmap_mode='r')
    sp = sl.grid(a.header or str(sl.sidecar_path(a.labels)))['spacing_zyx_mm']
    step = a.step or max(1, round(max(labels.shape) / 300))
    lab = np.asarray(labels[::step, ::step, ::step])
    present = [int(v) for v in np.unique(lab[lab > 0])]
    if not present:
        sl.fail('the labels volume is empty: nothing to render')
    ms = meshes(lab, [s * step for s in sp], present)
    frame = vl.fr.load(a.frame) if a.frame else None
    look, up = view_vectors(frame)
    tiles = [render_view(ms, look, up, k * 60, TILE) for k in range(6)]
    names = vl.parse_names(a.names)
    fig = vl.fig_for(3 * TILE, 2 * TILE)
    for k, t in enumerate(tiles):
        ax = fig.add_axes([(k % 3) / 3, 1 - (k // 3 + 1) / 2, 1 / 3, 1 / 2])
        ax.imshow(t)
        ax.set_axis_off()
        ax.text(8, 24, f'{k * 60} deg', color='w', fontsize=9)
    vl.draw_legend(fig, sorted(ms), names, loc='lower left')
    sl.save_image(fig, a.out)
    sl.emit(image=a.out, labels_drawn=sorted(ms), step=step, triangles=int(sum(m.n_faces for m in ms.values())))
