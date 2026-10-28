"""6-view 3D sheet of a labels volume, one colour per label: the best check for "does one label cover two bones?" and
for small fragments merged into a big bone.

  python render_surfaces.py --labels labels.npy --out sheet.jpg [--frame frame.json] [--names 1=femur,2=tibia]
        [--step 3] [--header hu.json]

Six views, 60 degrees apart, around the long axis of the limb (with `--frame`: the line from bone B's shaft to bone A's,
and the first view looks along the oriented stack's normal; without it: scan axis 0 points down and the first view looks
along axis 2). Surfaces are drawn from a copy downsampled by `--step` (default: so the longest axis is ~300 voxels), for
display only; never measure from them. The renders are of the array's axes, not the world's: left and right are not
asserted. Needs pyvista with an off-screen VTK (vtk-osmesa in the sandbox).

  python render_surfaces.py --labels labels.npy --out view.jpg --azimuth 120 [--size 1000]
      One big view with a 100 px grid instead of the sheet, for picking a point on the surface. Also writes
      `view.camera.json` ({"image", "camera": {position, focal_point, view_up, view_angle}} in scan voxel indices z,y,x),
      the camera `regions-and-landmarks/pick.py` needs to turn a pixel into a voxel.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import viewlib as vl
from skimage.measure import marching_cubes

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
    """One off-screen render; returns the image and the camera in mesh coordinates (mm, x,y,z)."""
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
    cam = {'position': list(p.camera.position), 'focal_point': list(p.camera.focal_point), 'view_up': list(p.camera.up),
               'view_angle': float(p.camera.view_angle)}
    p.close()
    return img, cam


def camera_zyx(cam, spacing):
    """Camera vectors from mesh coordinates (mm, x,y,z) to scan voxel indices z,y,x. view_up is a direction, so it is
    scaled the same way (pick.py rescales it by the spacing again)."""
    sp = np.array(spacing)
    return {k: (np.array(v)[::-1] / sp).tolist() if k != 'view_angle' else v for k, v in cam.items()}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--labels', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--frame')
    ap.add_argument('--header', help='hu.json for the spacing (default: the labels sidecar)')
    ap.add_argument('--names')
    ap.add_argument('--step', type=int)
    ap.add_argument('--azimuth', type=float, help='one big view at this azimuth (degrees) instead of the sheet')
    ap.add_argument('--size', type=int, default=1000, help='side of the single view in px')
    a = ap.parse_args()
    labels = np.load(a.labels, mmap_mode='r')
    sp = sl.grid(a.header or str(sl.sidecar_path(a.labels)))['spacing_zyx_mm']
    step = a.step or max(1, round(max(labels.shape) / 300))
    lab = np.asarray(labels[::step, ::step, ::step])
    present = [int(v) for v in np.unique(lab[lab > 0])]
    if not present:
        sl.fail('the labels volume is empty: nothing to render')
    ms = meshes(lab, [s * step for s in sp], present)
    frame = vl.load_frame(a.frame) if a.frame else None
    look, up = view_vectors(frame)
    if a.azimuth is not None:
        img, cam = render_view(ms, look, up, a.azimuth, a.size)
        fig = vl.fig_for(a.size, a.size)
        ax = fig.add_axes([0, 0, 1, 1])
        ax.imshow(img)
        for v in range(0, a.size, 100):
            ax.axvline(v, color=vl.GRID_COLOR, lw=0.4, alpha=0.6)
            ax.axhline(v, color=vl.GRID_COLOR, lw=0.4, alpha=0.6)
            ax.text(v + 2, 12, str(v), color=vl.GRID_COLOR, fontsize=8)
            ax.text(2, v - 3, str(v), color=vl.GRID_COLOR, fontsize=8)
        ax.set_axis_off()
        sl.save_image(fig, a.out)
        cam_path = Path(a.out).with_suffix('.camera.json')
        cam_path.write_text(json.dumps({'image': a.out, 'camera': camera_zyx(cam, sp)}) + '\n')
        sl.emit(image=a.out, camera=str(cam_path), labels_drawn=sorted(ms), step=step)
        raise SystemExit
    tiles = [render_view(ms, look, up, k * 60, TILE)[0] for k in range(6)]
    names = vl.parse_names(a.names)
    fig = vl.fig_for(3 * TILE, 2 * TILE)
    for k, t in enumerate(tiles):
        ax = fig.add_axes([(k % 3) / 3, 1 - (k // 3 + 1) / 2, 1 / 3, 1 / 2])
        ax.imshow(t)
        ax.set_axis_off()
        ax.text(8, 24, f'{k * 60} deg', color='w', fontsize=9)
    fig.text(0.005, 0.005, '  '.join(f'{lv}={names.get(lv, "")}' for lv in ms), color='w', va='bottom', fontsize=9,
             bbox={'fc': 'k', 'ec': 'none', 'alpha': 0.6})
    sl.save_image(fig, a.out)
    sl.emit(image=a.out, labels_drawn=sorted(ms), step=step, triangles=int(sum(m.n_faces for m in ms.values())))
