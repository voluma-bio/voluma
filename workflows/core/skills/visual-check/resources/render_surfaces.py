"""6-view 3D sheet of a labels volume, one colour per label, to check one label does not cover two bones.

Also shows small fragments merged into a big bone. Six views, 60 degrees apart, around the long axis of the limb (with
`--frame`: the line from bone B's shaft to bone A's, and the first view looks along the oriented stack's normal; without
it: scan axis 0 points down and the first view looks along axis 2). Surfaces are drawn from a copy downsampled by
`--step` and cached in `.mesh-cache/` beside `--out`, for display only; never measure from them. The renders are of the
array's axes, not the world's: left and right are not asserted. Needs pyvista with an off-screen VTK (vtk-osmesa in the
sandbox).

Writes: <out>  the JPEG sheet (3 x 2 views, a legend of the labels present); .mesh-cache/ beside it
Prints: one JSON line {image, labels_drawn, step, triangles}
Example: python render_surfaces.py --labels labels.npy --out sheet.jpg --frame frame.json --names anatomy.json
Exits 2 with one sentence on bad input, before writing anything.
"""
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/;
# only missing directories are added, so a script imported by another leaves the importer's order alone.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [d for d in (str(HERE), str(SKILLS / 'microct-core/resources')) if d not in sys.path]
try:
    import frame as fr
    import viewlib as vl
except ModuleNotFoundError as e:
    print(f'{e}: a skill this script imports is missing; it expects <workflows>/core/skills/<skill>/resources/, or '
          '<workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it', file=sys.stderr)
    sys.exit(2)

sl = vl.sidecar
TILE = 640


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
    ap = sl.parser(__doc__)
    ap.add_argument('--labels', required=True, help='label volume .npy')
    ap.add_argument('--out', required=True, help='the image to write (.jpg)')
    ap.add_argument('--frame', help='frame.json from orient_joint.py: orients the views by the bones')
    ap.add_argument('--header', help='hu.json for the spacing (default: the labels sidecar)')
    ap.add_argument('--names', help='label names, 1=femur,2=tibia or an anatomy.json')
    ap.add_argument('--step', type=int, help='downsampling step in voxels (default: the longest axis / 300, rounded, at least 1)')
    a = ap.parse_args()
    labels = np.load(a.labels, mmap_mode='r')
    sp = sl.grid(a.header or str(sl.sidecar_path(a.labels)))['spacing_zyx_mm']
    step = a.step or max(1, round(max(labels.shape) / 300))
    cache = vl.Meshes(Path(a.out).parent / '.mesh-cache')
    present = cache.label_ids(a.labels, labels, step)
    if not present:
        sl.fail('the labels volume is empty: nothing to render')
    ms = {lv: cache.surface(a.labels, labels, lambda x, lv=lv: x == lv, f'label{lv}', sp, step=step) for lv in present}
    ms = {lv: m for lv, m in ms.items() if m.n_points}
    frame = fr.load(a.frame) if a.frame else None
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
