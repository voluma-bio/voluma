"""Four panes of one place: a 3D view and three slices through one crosshair, the review screen's layout, driven call by call.

  python quad_view.py --hu hu.npy --labels labels.npy --names anatomy.json --out /scratch/v1.jpg
  python quad_view.py --from /scratch/v1.view.json --center tibia --move axis0+5 --out /scratch/v2.jpg
  python quad_view.py --from v2.view.json --rotate 40,0 --plane 1:contains=shaft_a,shaft_b --out v3.jpg

Every pane is a plane through the crosshair, sampled in mm with `viewlib.sample_plane`, each layer from its own grid through
its frame (the `grid_id` in its sidecar; register frames with `--frame frame.json`). Top left: 3D. The slice panes are the
scan's axis 0, 1 and 2 until `--plane` changes one. Pane titles name the scan axis and index (`axis 0 = 412`); ticks are voxel
indices on axis-aligned panes and mm from the crosshair on the others. Panes are centred on the crosshair: `--center` and
`--move` choose what you look at, `--zoom` how closely. The image is for looking, not measuring.

Each call writes `<out>.view.json` beside the image: the full state (scan voxels and mm), each pane's pixel rectangle and
pixel -> zyx map, and the 3D camera. It never rewrites an earlier view: the next call is `--from a.view.json` plus changes. Writes
only beside `--out` (the image, its view.json, a mesh cache in `.quad-view-cache/`); inputs may be read-only.

Layers (each added layer is shown; `--show` / `--hide NAME` toggles any layer, plus `labels`, `ruler` and `planes`):
  --hu hu.npy            the scan (first call; later calls take it from --from)
  --labels L.npy [--names 1=femur,.. | anatomy.json]   label volume: outlines on slices, colours in 3D (hidden: bone is ivory)
  --mask NAME=M.npy      bool volume on any registered grid: outline on slices, translucent surface in 3D (repeatable)
  --face NAME=F.npy      2D array of a frame's axis-0 index over its axes 1, 2 (NaN = none; iioc's growth-plate face): a line
  --points NAME=P.json   a named set of points, each with a grid_id (what pick.py writes): markers and names; sphere in 3D.
                         NAME is the layer `--show` / `--hide` toggles; the points keep the names inside the file
  --ruler A,B            line between two named points with its length in mm
  --frame frame.json     register the frame of a grid that is not the scan's (repeatable)
  --bone-hu HU           bone surface from HU when there are no labels
  --window lo,hi         display window in HU (default: the scan's bone range); write a negative low end as is: --window -500,6000
  --pane-px N            pixels per pane side (default 800; at most 940)      --mesh-step N   voxels per surface grid step
Changes, applied in this order:
  --plane K:axis=J | K:normal=z,y,x[:up=z,y,x] | K:contains=A,B | K:frame=frame.json[:axis=J]    pane K (0-2), J (0-2);
        vectors in mm; `contains` cuts along the line through two named points (reslice along a bone); `up` is the screen-up
        direction; a frame pane needs an isotropic scan (repeatable)
  --center NAME|z,y,x    NAME is a point, a label name or a mask; z,y,x are scan voxel indices
  --move axisK+N | paneK-N[mm]   step the crosshair N voxels along scan axis K, or along pane K's normal (voxels, or mm with `mm`; repeatable)
  --rotate az,el         turn the 3D camera by degrees, e.g. --rotate 60,0 or --rotate 0,-30
  --zoom Z               slice panes' field of view = whole scan / Z, Z > 0 (3D always fits the bone)
  --show NAME / --hide NAME   toggle a layer by name (repeatable)
The crosshair is a whole voxel on every scan axis that has an axis-aligned pane, so a pane named `axis 0 = N` is slice N.
Bad input is refused with one sentence and exit 2 before anything is written.
"""
import argparse
import json
import math
import os
import re
import sys
import time
from pathlib import Path

import matplotlib.patheffects as pe
import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the skills are found by walking up to the directory that holds core/skills/.
SKILLS = next((p / 'core/skills' for p in HERE.parents if (p / 'core/skills/microct-core').is_dir()), HERE)
sys.path[:0] = [str(HERE), str(SKILLS / 'microct-core/resources')]
try:
    import frame as fr
    import viewlib as vl
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects core/skills/microct-core/resources/ in a directory above it '
             '(<workflows>/core/skills/<skill>/resources/, or <workflows>/<workflow>/skills/<skill>/resources/ with <workflows>/core/ beside it)')

sl, plt = vl.sidecar, vl.plt
PANE_COLOURS = ['#ff3b30', '#34c759', '#4f8dff']  # pane 0, 1, 2: its border, its plane in 3D, its line in the other panes
IVORY, POINT_COLOUR, RULER_COLOUR = '#e8dcc0', '#ffd60a', '#00e5ff'
OVERLAY = ['#ff9f0a', '#bf5af2', '#b6f23c', '#ff4fd8', '#1fa89a', '#c8864b']  # masks, then faces, in the order they were added
ML, MT, MR, MB = 46, 26, 6, 34  # margins around a pane: tick labels left and bottom, title on top
ISOTROPIC_TOL = 0.01
TOL_PX = 3  # a point this close to a slice (in pixels) is drawn on it
E = np.eye(3)
# (normal, screen-up) of the scan-axis panes. Screen-right is -cross(up, normal) in zyx (a zyx cross has the opposite
# handedness); z points up in panes 1, 2 and in 3D, so the femur-high scan has the femur above the tibia.
AXIS_PANES = [(E[0], E[1]), (-E[1], E[0]), (E[2], E[0])]


def overlay_colour(s, name):
    """A colour per mask or face that stays with it whether or not its neighbours are shown."""
    return OVERLAY[(list(s['masks']) + list(s['faces'])).index(name) % len(OVERLAY)]


# ---- state ----------------------------------------------------------------------------------------------------------

def make_pane(normal, up=None, axis=None, frame=None):
    """A pane dict: unit `normal`, screen-`up` (made perpendicular to it) and screen-`right`, in mm space (z, y, x)."""
    n = vl.unit(np.asarray(normal, float))
    if up is None:  # a fixed rule, so the pane never spins between calls: scan axis 0 up, or axis 1 when looking along 0
        up = E[0] if abs(n[0]) < 0.9 else E[1]
    up = np.asarray(up, float)
    up = up - (up @ n) * n
    if np.linalg.norm(up) < 1e-6:
        sl.fail('the up vector is parallel to the plane normal: give an up vector that lies in the plane')
    up = vl.unit(up)
    right = -np.cross(up, n)
    return {'normal': n.tolist(), 'up': up.tolist(), 'right': right.tolist(), 'axis': axis, 'frame': frame}


def new_state(a):
    hu = Path(a.hu).resolve()
    g = sl.grid(sl.sidecar_path(hu))
    shape = np.load(hu, mmap_mode='r').shape
    return {'version': 1, 'scan': {'hu': str(hu), 'grid_id': g['grid_id'], 'spacing_zyx_mm': g['spacing_zyx_mm'],
                                   'shape': list(shape)},
            'frames': [], 'labels': None, 'names': {}, 'masks': {}, 'faces': {}, 'points': {}, 'ruler': None,
            'bone_hu': None, 'shown': ['planes'], 'window': None, 'center_zyx': [(n - 1) / 2 for n in shape], 'zoom': 1.0,
            'panes': [make_pane(n, up, axis=k) for k, (n, up) in enumerate(AXIS_PANES)],
            'camera': {'azimuth': 35.0, 'elevation': 20.0}, 'pane_px': 800, 'mesh_step': None}


def named_paths(items, what):
    out = {}
    for it in items or []:
        name, eq, path = it.partition('=')
        if not eq or not name:
            sl.fail(f'--{what} {it!r}: write NAME=path')
        out[name] = str(Path(path).resolve())
    return out


def add_layers(s, a):
    for key, items in (('masks', a.mask), ('faces', a.face), ('points', a.points)):
        new = named_paths(items, {'masks': 'mask', 'faces': 'face', 'points': 'points'}[key])
        s[key].update(new)
        s['shown'] += [n for n in new if n not in s['shown']]
    if a.labels:
        s['labels'] = str(Path(a.labels).resolve())
        s['shown'] += [] if 'labels' in s['shown'] else ['labels']
    if a.names:
        s['names'] = {str(k): v for k, v in vl.parse_names(a.names).items()}
    s['frames'] += [str(Path(f).resolve()) for f in a.frame or [] if str(Path(f).resolve()) not in s['frames']]
    if a.ruler:
        s['ruler'] = a.ruler.split(',')
        s['shown'] += [] if 'ruler' in s['shown'] else ['ruler']
    for key, val in (('bone_hu', a.bone_hu), ('pane_px', a.pane_px), ('mesh_step', a.mesh_step)):
        if val is not None:
            s[key] = val
    if a.window:
        s['window'] = list(vl.parse_window(a.window))


def require_isotropic(sp, why):
    """A frame is a rigid motion in voxel indices: in mm only when the voxels are cubes."""
    if sp.max() / sp.min() - 1 > ISOTROPIC_TOL:
        sl.fail(f'voxels are not isotropic ({sp.tolist()} mm), so {why}: resample the scan first, or use only axis panes and '
                'layers on the scan grid')


class Scene:
    """The state's inputs opened: memmapped volumes with the maps from mm to their own index space, and the points."""

    def __init__(self, s):
        self.s = s
        self.sp = np.array(s['scan']['spacing_zyx_mm'], float)
        self.shape = s['scan']['shape']
        self.gid = s['scan']['grid_id']
        self.frames = {}
        for p in s['frames']:
            f = fr.load(p)
            self.frames[f['grid_id']] = f
        self.hu = np.load(s['scan']['hu'], mmap_mode='r')
        self.points, self.visible = {}, {}
        for name, p in s['points'].items():
            pts = {k: np.array(v, float) for k, v in sl.load_points(p, self.gid).items()}
            if self.points.keys() & pts.keys():
                sl.fail(f'point set {name!r} reuses a point name from another set: rename it so a name means one point')
            self.points.update(pts)
            if name in s['shown']:
                self.visible.update(pts)
        for name in s['ruler'] or []:
            if name not in self.points:
                sl.fail(f'ruler point {name!r} is not in any --points file (have: {", ".join(sorted(self.points)) or "none"})')

    def open(self, path):
        """(volume, to_index, to_scan): `to_index` maps mm points (..., 3) to the volume's index space, `to_scan` its
        indices to scan voxel indices."""
        vol = np.load(path, mmap_mode='r')
        if vol.dtype == bool:
            vol = vol.view(np.uint8)
        gid = sl.grid(sl.sidecar_path(path))['grid_id']
        if gid == self.gid:
            return vol, lambda p: p / self.sp, lambda p: p
        f = self.frames.get(gid)
        if f is None:
            sl.fail(f'{path} is on grid {gid[:12]}..., which is not the scan\'s and has no frame: pass its frame.json with --frame')
        require_isotropic(self.sp, f'{path} on a frame is not a rigid motion in mm')
        return vol, lambda p: fr.from_scan_points(p / self.sp, f), lambda p: fr.to_scan_points(p, f)

    def centre_of(self, name):
        s = self.s
        if name in self.points:
            return self.points[name]
        if s['labels']:
            ids = [int(k) for k, v in s['names'].items() if v == name]
            if ids:
                lab, _, to_scan = self.open(s['labels'])
                idx = np.argwhere(lab[::2, ::2, ::2] == ids[0]) * 2.0
                if len(idx):
                    return to_scan(idx.mean(axis=0))
                sl.fail(f'label {name!r} (id {ids[0]}) has no voxels')
        if name in s['masks']:
            m, _, to_scan = self.open(s['masks'][name])
            idx = np.argwhere(m)
            if len(idx):
                return to_scan(idx.mean(axis=0))
            sl.fail(f'mask {name!r} is empty')
        known = sorted(self.points) + sorted(s['names'].values()) + sorted(s['masks'])
        sl.fail(f'--center {name!r} is not a point, label or mask name or z,y,x (have: {", ".join(known) or "none"})')


def parse_axis(txt, spec):
    if txt not in ('0', '1', '2'):
        sl.fail(f'--plane {spec!r}: axis must be 0, 1 or 2')
    return int(txt)


def need_file(path, what):
    if not Path(path).is_file():
        sl.fail(f'{what} {str(path)!r} is not a file')


def parse_vec(txt, what):
    try:
        v = [float(x) for x in txt.split(',')]
        assert len(v) == 3
    except (ValueError, AssertionError):
        sl.fail(f'{what} {txt!r} is not three numbers z,y,x')
    return v


def apply_plane(s, scene, spec):
    k, _, rest = spec.partition(':')
    if k not in ('0', '1', '2'):
        sl.fail(f'--plane {spec!r}: start with the pane number 0, 1 or 2')
    k = int(k)
    toks = dict(t.partition('=')[::2] for t in rest.split(':') if t)
    old = s['panes'][k]
    j = parse_axis(toks['axis'], spec) if 'axis' in toks else 0
    if 'axis' in toks and 'frame' not in toks:
        s['panes'][k] = make_pane(*AXIS_PANES[j], axis=j)
    elif 'frame' in toks:
        need_file(toks['frame'], f'--plane {spec!r}: frame file')
        require_isotropic(scene.sp, f'a frame pane ({spec!r}) would not be a slice of the frame')
        f = fr.load(toks['frame'])
        R = np.array(f['R_zyx'])
        s['panes'][k] = make_pane(R[j], R[0] if j else R[1], frame={'path': str(Path(toks['frame']).resolve()), 'axis': j})
        if str(Path(toks['frame']).resolve()) not in s['frames']:
            s['frames'].append(str(Path(toks['frame']).resolve()))
    elif 'contains' in toks:
        names = toks['contains'].split(',')
        if len(names) != 2 or any(n not in scene.points for n in names):
            sl.fail(f'contains={toks["contains"]}: name two points from --points (have: {", ".join(sorted(scene.points)) or "none"})')
        up = vl.unit((scene.points[names[1]] - scene.points[names[0]]) * scene.sp)
        n = np.array(old['normal'])
        n = n - (n @ up) * up
        if np.linalg.norm(n) < 0.2:  # the old plane was nearly along the line: use its other axis
            n = np.array(old['right'])
            n = n - (n @ up) * up
        s['panes'][k] = make_pane(n, up)
    elif 'normal' in toks:
        s['panes'][k] = make_pane(parse_vec(toks['normal'], 'normal'), parse_vec(toks['up'], 'up') if 'up' in toks else None)
    else:
        sl.fail(f'--plane {spec!r}: give axis=J, normal=z,y,x, contains=A,B or frame=path:axis=J')


def apply_changes(s, scene, a):
    for spec in a.plane or []:
        apply_plane(s, scene, spec)
    if a.center:
        c = parse_vec(a.center, 'center') if re.fullmatch(r'[-\d.eE]+,[-\d.eE]+,[-\d.eE]+', a.center) else scene.centre_of(a.center)
        s['center_zyx'] = [float(v) for v in c]
    for mv in a.move or []:
        m = re.fullmatch(r'(axis|pane)([012])([+-][\d.]+)(mm)?', mv)
        if not m:
            sl.fail(f'--move {mv!r}: write axis0+5 (voxels along scan axis 0) or pane1-0.1mm (along pane 1\'s normal)')
        kind, k, amount, mm = m.group(1), int(m.group(2)), float(m.group(3)), m.group(4)
        centre = np.array(s['center_zyx'])
        if kind == 'axis':
            centre[k] += amount / scene.sp[k] if mm else amount
        else:
            step_mm = amount if mm else amount * scene.sp.mean()
            centre = centre + np.array(s['panes'][k]['normal']) * step_mm / scene.sp
        s['center_zyx'] = centre.tolist()
    if a.rotate:
        az, el = a.rotate
        cam = s['camera']
        cam['azimuth'] = (cam['azimuth'] + az) % 360
        cam['elevation'] = max(-89.0, min(89.0, cam['elevation'] + el))
    if a.zoom is not None:
        s['zoom'] = a.zoom
    known = {'labels', 'ruler', 'planes', *s['masks'], *s['faces'], *s['points']}
    for names, on in ((a.show, True), (a.hide, False)):
        for n in names or []:
            if n not in known:
                sl.fail(f'--{"show" if on else "hide"} {n!r}: layers are {", ".join(sorted(known))}')
            s['shown'] = [x for x in s['shown'] if x != n] + ([n] if on else [])
    for key, need in (('labels', 'labels'), ('ruler', 'ruler')):
        if key in s['shown'] and not s[need]:
            s['shown'].remove(key)
    for pane in s['panes']:  # a pane named `axis K = N` is slice N, not a blend of two
        if pane['axis'] is not None:
            s['center_zyx'][pane['axis']] = float(np.rint(s['center_zyx'][pane['axis']]))
    c = s['center_zyx']
    if any(not 0 <= v < n for v, n in zip(c, s['scan']['shape'])):
        sl.fail(f'the crosshair {np.round(c, 1).tolist()} is outside the scan {s["scan"]["shape"]}: move it back')


# ---- geometry -------------------------------------------------------------------------------------------------------

def pane_geometry(s, scene, k):
    """What a slice pane is: centre (mm), row direction u, column direction v, pixel size, and the pixel -> scan voxel map."""
    pane = s['panes'][k]
    P = s['pane_px']
    fov = float((np.array(scene.shape) * scene.sp).max()) / s['zoom']
    px = fov / P
    centre = np.array(s['center_zyx']) * scene.sp
    u, v = -np.array(pane['up']), np.array(pane['right'])
    return {'centre_mm': centre, 'u': u, 'v': v, 'n': np.array(pane['normal']), 'px': px, 'fov_mm': fov,
            'origin_zyx': (centre - (P - 1) / 2 * px * (u + v)) / scene.sp,
            'd_row_zyx': u * px / scene.sp, 'd_col_zyx': v * px / scene.sp}


def pane_title(s, scene, k):
    pane, c = s['panes'][k], np.array(s['center_zyx'])
    if pane['axis'] is not None:
        j = pane['axis']
        return f'axis {j} = {c[j]:.0f}'
    if pane['frame']:
        f = scene.frames[fr.load(pane['frame']['path'])['grid_id']]
        j = pane['frame']['axis']
        return f'frame {f["grid_id"][:6]} axis {j} = {fr.from_scan_points(c, f)[j]:.0f}'
    n = np.array(pane['normal'])
    return 'oblique, normal ' + ','.join(f'{x:.2f}' for x in n)


def nice_ticks(lo, hi, want=6):
    span = abs(hi - lo)
    raw = span / want
    step = min((m * 10 ** math.floor(math.log10(raw)) for m in (1, 2, 5, 10, 20) if m * 10 ** math.floor(math.log10(raw)) >= raw),
               default=raw)
    first = math.ceil(min(lo, hi) / step) * step
    return [first + i * step for i in range(int((max(lo, hi) - first) / step) + 1)], step


def set_ticks(ax, s, scene, k, g):
    """Ticks along rows (y axis) and columns (x axis): voxel indices on scan-axis panes, mm from the crosshair otherwise."""
    P = s['pane_px']
    c = np.array(s['center_zyx'])
    pane = s['panes'][k]
    mid = (P - 1) / 2
    for which, vec in (('y', g['u']), ('x', g['v'])):
        scan_axis = int(np.argmax(np.abs(vec)))
        if pane['axis'] is not None and abs(vec[scan_axis]) > 0.999:
            sign = vec[scan_axis]
            half = mid * g['px'] / scene.sp[scan_axis]
            ticks, _ = nice_ticks(c[scan_axis] - half, c[scan_axis] + half)
            pos = [mid + (t - c[scan_axis]) * scene.sp[scan_axis] / g['px'] / sign for t in ticks]
            labels = [f'{t:.0f}' for t in ticks]
            name = f'axis {scan_axis} (voxel index)'
        else:
            half = mid * g['px']
            ticks, step = nice_ticks(-half, half)
            pos = [mid + t / g['px'] for t in ticks]
            # rows run along u = -up, so a row tick reads minus its distance: the mm labels increase upward, like the voxel ones
            labels = [f'{(t if which == "x" else -t) + 0.0:+.{max(0, -math.floor(math.log10(step)))}f}' for t in ticks]
            name = 'mm from the crosshair'
        if which == 'y':
            ax.set_yticks(pos, labels, fontsize=8, color='#bbbbbb')
            ax.set_ylabel(name, fontsize=7, color='#bbbbbb', labelpad=1)
        else:
            ax.set_xticks(pos, labels, fontsize=8, color='#bbbbbb')
            ax.set_xlabel(name, fontsize=7, color='#bbbbbb', labelpad=1)
    ax.tick_params(length=3, color='#888888', pad=2)


# ---- meshes ---------------------------------------------------------------------------------------------------------

def of_face(meshes, scene, path):
    """Surface of a frame's face array (axis-0 index over axes 1, 2), mapped onto the scan."""
    key = (str(path), Path(path).stat().st_mtime_ns, 'face', scene.gid)

    def build():
        import pyvista as pv
        face = np.load(path).astype(float)
        _, _, to_scan = scene.open(path)
        n0, n1 = face.shape
        r, c = np.mgrid[0:n0, 0:n1]
        pts = to_scan(np.stack([face, r, c], axis=-1)).reshape(-1, 3) * scene.sp
        ok = np.isfinite(face)
        quad = ok[:-1, :-1] & ok[1:, :-1] & ok[:-1, 1:] & ok[1:, 1:]
        i = (r[:-1, :-1] * n1 + c[:-1, :-1])[quad]
        faces = np.stack([np.full_like(i, 4), i, i + n1, i + n1 + 1, i + 1], axis=1).ravel()
        return pv.PolyData(np.nan_to_num(pts)[:, ::-1].copy(), faces)
    return meshes.cached(key, build)


def surface(meshes, scene, path, select, kind):
    """Cached surface of `select(volume)` for the array at `path`, on its own grid mapped onto the scan."""
    vol, _, to_scan = scene.open(path)
    return meshes.surface(path, vol, select, kind, scene.sp, to_scan, scene.s['mesh_step'], scene.gid)


def label_ids(meshes, scene):
    """Label ids that have a surface: those present in the downsampled volume the surfaces are cut from."""
    vol, _, _ = scene.open(scene.s['labels'])
    return meshes.label_ids(scene.s['labels'], vol, scene.s['mesh_step'])


def bone_mesh(s, scene, meshes):
    if s['labels']:
        return surface(meshes, scene, s['labels'], lambda a: a > 0, 'bone')
    if s['bone_hu'] is None:
        sl.fail('the 3D pane needs a bone surface: pass --labels or --bone-hu (the HU above which a voxel is bone)')
    thr = s['bone_hu']
    return surface(meshes, scene, s['scan']['hu'], lambda a: a > thr, f'hu>{thr}')


# ---- 3D pane --------------------------------------------------------------------------------------------------------

def camera_for(s, scene, bounds):
    """Camera (mm, x,y,z) looking at the crosshair from the state's azimuth and elevation, scan axis 0 up."""
    focal = (np.array(s['center_zyx']) * scene.sp)[::-1]
    corners = np.array([[x, y, z] for x in bounds[0:2] for y in bounds[2:4] for z in bounds[4:6]])
    radius = float(np.linalg.norm(corners - focal, axis=1).max())
    az, el = (math.radians(s['camera'][k]) for k in ('azimuth', 'elevation'))
    toward = np.array([math.cos(el) * math.sin(az), -math.cos(el) * math.cos(az), math.sin(el)])  # x, y, z
    dist = radius * 2.4
    return {'position': (focal + dist * toward).tolist(), 'focal_point': focal.tolist(), 'view_up': [0.0, 0.0, 1.0],
            'view_angle': 30.0}


def render_3d(s, scene, meshes, geoms):
    """The 3D pane image and its camera (mm, x,y,z). Returns (image, camera, scene bounds)."""
    import pyvista as pv
    pv.OFF_SCREEN = True
    P = s['pane_px']
    shown = set(s['shown'])
    p = pv.Plotter(off_screen=True, window_size=(P, P))
    p.set_background('black')
    overlays = [n for n in list(s['masks']) + list(s['faces']) if n in shown]
    ext = scene.sp[::-1] * scene.shape[::-1]
    bounds = [0, ext[0], 0, ext[1], 0, ext[2]]
    if 'labels' in shown and s['labels']:
        for k in label_ids(meshes, scene):
            m = surface(meshes, scene, s['labels'], lambda a, k=k: a == k, f'label{k}')
            if m.n_points:
                p.add_mesh(m, color=vl.colour(k), smooth_shading=True, opacity=0.5 if overlays else 1.0)
    else:
        bone = bone_mesh(s, scene, meshes)
        p.add_mesh(bone, color=IVORY, smooth_shading=True, opacity=0.25 if overlays else 1.0)
    for name in (n for n in s['masks'] if n in shown):
        m = surface(meshes, scene, s['masks'][name], lambda a: a > 0, 'mask')
        if m.n_points:
            p.add_mesh(m, color=overlay_colour(s, name), smooth_shading=True, opacity=0.85)
    for name in (n for n in s['faces'] if n in shown):
        m = of_face(meshes, scene, s['faces'][name])
        if m.n_points:
            p.add_mesh(m, color=overlay_colour(s, name), opacity=0.7)
    diag = float(np.linalg.norm(np.array(bounds[1::2]) - np.array(bounds[0::2])))
    if 'planes' in shown:
        for k, g in enumerate(geoms):
            h = g['fov_mm'] / 2
            ring = [g['centre_mm'] + a * h * g['u'] + b * h * g['v'] for a, b in ((-1, -1), (-1, 1), (1, 1), (1, -1), (-1, -1))]
            p.add_mesh(pv.lines_from_points(np.array(ring)[:, ::-1]), color=PANE_COLOURS[k], line_width=3)
    for zyx in scene.visible.values():
        p.add_mesh(pv.Sphere(radius=diag * 0.008, center=(zyx * scene.sp)[::-1]), color=POINT_COLOUR)
    if s['ruler'] and 'ruler' in shown:
        a, b = (scene.points[n] * scene.sp for n in s['ruler'])
        p.add_mesh(pv.Line(a[::-1], b[::-1]), color=RULER_COLOUR, line_width=4)
    cam = camera_for(s, scene, bounds)
    p.camera.position, p.camera.focal_point, p.camera.up, p.camera.view_angle = (
        cam['position'], cam['focal_point'], cam['view_up'], cam['view_angle'])
    p.reset_camera_clipping_range()
    img = p.screenshot(return_img=True)
    p.close()
    return img, cam


# ---- slice panes ----------------------------------------------------------------------------------------------------

def text(ax, x, y, s, colour, size=9, **kw):
    t = ax.text(x, y, s, color=colour, fontsize=size, clip_on=True, **kw)  # clipped: a label must not spill into the next pane
    t.set_path_effects([pe.withStroke(linewidth=2.5, foreground='black')])
    return t


def draw_slice(ax, s, scene, k, g):
    P = s['pane_px']
    shown = set(s['shown'])
    sp = scene.sp
    lo, hi = s['window']
    cut = lambda vol, to_index, order: vl.sample_plane(vol, to_index, g['centre_mm'], g['u'], g['v'], g['px'], (P, P), order, 0)
    ax.imshow(vl.sample_plane(scene.hu, lambda p: p / sp, g['centre_mm'], g['u'], g['v'], g['px'], (P, P), 1, lo), cmap='gray',
              vmin=lo, vmax=hi, interpolation='nearest')
    if s['labels'] and 'labels' in shown:
        vol, to_index, _ = scene.open(s['labels'])
        lab = cut(vol, to_index, 0).astype(np.int32)
        vl.draw_labels(ax, lab, alpha=0.15)
    for name in (n for n in s['masks'] if n in shown):
        vol, to_index, _ = scene.open(s['masks'][name])
        m = cut(vol, to_index, 0) > 0
        if m.any():
            vl.draw_mask(ax, m, overlay_colour(s, name), alpha=0.15)
    for name in (n for n in s['faces'] if n in shown):
        face = np.load(s['faces'][name]).astype(float)
        _, to_index, _ = scene.open(s['faces'][name])
        idx = to_index(fr.plane_points(g['centre_mm'], g['u'], g['v'], g['px'], (P, P)))
        h = ndi.map_coordinates(face, [idx[..., 1], idx[..., 2]], order=1, mode='constant', cval=np.nan)
        d = np.ma.masked_invalid(idx[..., 0] - h)
        if d.count() and d.min() < 0 < d.max():
            ax.contour(d, levels=[0], colors=[overlay_colour(s, name)], linewidths=2)
    mid = (P - 1) / 2
    for j, gj in enumerate(s['panes'][:3]):  # the line where pane j's plane crosses this one
        if j == k:
            continue
        d = np.cross(g['n'], gj['normal'])
        if np.linalg.norm(d) < 1e-6:
            continue
        dc, dr = d @ g['v'], d @ g['u']
        norm = math.hypot(dc, dr)
        ax.plot([mid - dc / norm * P, mid + dc / norm * P], [mid - dr / norm * P, mid + dr / norm * P], color=PANE_COLOURS[j],
                lw=1.0, alpha=0.85)
    to_px = lambda zyx: ((zyx * sp - g['centre_mm']) @ g['v'] / g['px'] + mid, (zyx * sp - g['centre_mm']) @ g['u'] / g['px'] + mid)
    depth = lambda zyx: (zyx * sp - g['centre_mm']) @ g['n']
    for pn, zyx in scene.visible.items():
        if abs(depth(zyx)) <= TOL_PX * g['px']:
            x, y = to_px(zyx)
            if 0 <= x < P and 0 <= y < P:
                ax.plot([x], [y], marker='+', color=POINT_COLOUR, ms=13, mew=2)
                text(ax, x + 8, y - 6, pn, POINT_COLOUR)
    if s['ruler'] and 'ruler' in shown:
        a, b = (scene.points[n] for n in s['ruler'])
        (xa, ya), (xb, yb) = to_px(a), to_px(b)
        inside = abs(depth(a)) <= TOL_PX * g['px'] and abs(depth(b)) <= TOL_PX * g['px']
        ax.plot([xa, xb], [ya, yb], color=RULER_COLOUR, lw=1.5, ls='-' if inside else ':')
        length = float(np.linalg.norm((a - b) * sp))
        text(ax, (xa + xb) / 2 + 6, (ya + yb) / 2 - 6, f'{length:.3f} mm' + ('' if inside else ' (not in this plane)'), RULER_COLOUR)
    ax.set_xlim(-0.5, P - 0.5)
    ax.set_ylim(P - 0.5, -0.5)
    set_ticks(ax, s, scene, k, g)


def legend_lines(s, scene, meshes):
    shown = set(s['shown'])
    out = []
    if s['labels'] and 'labels' in shown:
        out += [(vl.colour(i), f'{i} {s["names"].get(str(i), "(unnamed)")}') for i in label_ids(meshes, scene)]
    out += [(overlay_colour(s, n), n) for n in s['masks'] if n in shown]
    out += [(overlay_colour(s, n), n + ' (face)') for n in s['faces'] if n in shown]
    return out


def draw_3d_pane(ax, s, scene, meshes, img3d, cam):
    """The rendered 3D image with the point names, the ruler length and the legend written over it."""
    P = s['pane_px']
    ax.imshow(img3d)
    ax.set_xticks([])
    ax.set_yticks([])
    view = vl.View(vl.camera_zyx(cam, scene.sp), (P, P), scene.sp)
    for pn, zyx in scene.visible.items():
        xy = view.project(zyx)
        if xy and 0 <= xy[0] < P and 0 <= xy[1] < P:
            text(ax, xy[0] + 8, xy[1] - 6, pn, POINT_COLOUR)
    if s['ruler'] and 'ruler' in s['shown']:
        a, b = (scene.points[n] for n in s['ruler'])
        xa, xb = view.project(a), view.project(b)
        if xa and xb:
            length = float(np.linalg.norm((a - b) * scene.sp))
            text(ax, (xa[0] + xb[0]) / 2 + 6, (xa[1] + xb[1]) / 2 - 6, f'{length:.3f} mm', RULER_COLOUR)
    for n, (c, label) in enumerate(legend_lines(s, scene, meshes)):
        text(ax, 8, P - 10 - 14 * n, label, c, size=8)


# ---- render ---------------------------------------------------------------------------------------------------------

def check_out(out):
    """Refuse an --out that cannot be written, before any work: a .jpg path, no earlier view in the way, a writable directory."""
    if out.suffix.lower() not in ('.jpg', '.jpeg'):
        sl.fail(f'--out {str(out)!r}: end the name in .jpg')
    for f in (out, out.with_suffix('.view.json')):
        if f.exists():
            sl.fail(f'{f} exists and an earlier view is never rewritten: choose another --out')
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        sl.fail(f'--out {str(out)!r}: cannot create {out.parent}: {e.strerror}')
    if not os.access(out.parent, os.W_OK | os.X_OK):
        sl.fail(f'--out {str(out)!r}: {out.parent} is not writable: write the views to a directory you can write to')


def render(state, out):
    """Draw `state` (a dict as in view.json) to the JPEG `out`; write `<out>.view.json` and return it."""
    out = Path(out)
    s = json.loads(json.dumps(state))
    P = s['pane_px']
    cw, ch = P + ML + MR, P + MT + MB
    W, H = 2 * cw, 2 * ch
    if max(W, H) > sl.MAX_IMAGE_PX:
        sl.fail(f'panes of {P} px make a {W}x{H} image, over {sl.MAX_IMAGE_PX} px: use --pane-px '
                f'{(sl.MAX_IMAGE_PX - 2 * max(ML + MR, MT + MB)) // 2} or less')
    check_out(out)
    t = {}
    t0 = time.perf_counter()
    scene = Scene(s)
    if not s['window']:
        s['window'] = list(vl.auto_window(scene.hu[scene.shape[0] // 2]))
    geoms = [pane_geometry(s, scene, k) for k in range(3)]
    t['open'] = time.perf_counter() - t0

    t0 = time.perf_counter()
    meshes = vl.Meshes(out.parent / '.quad-view-cache')
    img3d, cam = render_3d(s, scene, meshes, geoms)
    t['3d'] = time.perf_counter() - t0

    t0 = time.perf_counter()
    fig = vl.fig_for(W, H, max_px=10 ** 6)
    rects = []
    for cell in range(4):  # cell 0 is the 3D pane, cells 1-3 are panes 0-2
        x0, y0 = (cell % 2) * cw + ML, (cell // 2) * ch + MT
        rects.append([x0, y0, x0 + P, y0 + P])
        ax = fig.add_axes([x0 / W, 1 - (y0 + P) / H, P / W, P / H])
        ax.set_facecolor('black')
        if cell == 0:
            draw_3d_pane(ax, s, scene, meshes, img3d, cam)
            colour = '#888888'
            title = f'3D: azimuth {s["camera"]["azimuth"]:.0f}, elevation {s["camera"]["elevation"]:.0f}'
        else:
            k = cell - 1
            draw_slice(ax, s, scene, k, geoms[k])
            colour = PANE_COLOURS[k]
            title = pane_title(s, scene, k)
        for sp_ in ax.spines.values():
            sp_.set_edgecolor(colour)
            sp_.set_linewidth(1.5)
        fig.text((x0 + P / 2) / W, 1 - (y0 - 6) / H, title, color=colour, ha='center', va='bottom', fontsize=10)
    t['slices'] = time.perf_counter() - t0

    t0 = time.perf_counter()
    sl.save_image(fig, out)
    plt.close(fig)
    t['save'] = time.perf_counter() - t0

    panes = []
    for k, g in enumerate(geoms):
        panes.append({'name': pane_title(s, scene, k), 'rect': rects[k + 1], 'normal': s['panes'][k]['normal'],
                      'px_mm': g['px'], 'origin_zyx': g['origin_zyx'].tolist(), 'd_row_zyx': g['d_row_zyx'].tolist(),
                      'd_col_zyx': g['d_col_zyx'].tolist()})
    view = {'image': str(out), 'state': s, 'timings_s': {k: round(v, 2) for k, v in t.items()},
            'panes': panes, '3d': {'rect': rects[0], 'camera': vl.camera_zyx(cam, scene.sp)},
            'note': 'a pane pixel (X, Y) of the image is at zyx = origin_zyx + (Y - rect[1]) * d_row_zyx + (X - rect[0]) * '
                    'd_col_zyx, in scan voxel indices; the camera is in scan voxel indices too (viewlib.View)'}
    out.with_suffix('.view.json').write_text(json.dumps(view, indent=1, default=float) + '\n')
    return view


def summary(view):
    s = view['state']
    return {'image': view['image'], 'view': str(Path(view['image']).with_suffix('.view.json')),
            'crosshair_zyx': [round(v, 1) for v in s['center_zyx']], 'zoom': s['zoom'], 'camera': s['camera'],
            'panes': [p['name'] for p in view['panes']], 'shown': s['shown'], 'window_hu': s['window'],
            'timings_s': view['timings_s'], 'jpeg_kib': round(Path(view['image']).stat().st_size / 1024)}


# ---- command line ---------------------------------------------------------------------------------------------------

def numbers(txt, n, what):
    try:
        v = [float(x) for x in txt.split(',')]
        assert len(v) == n and all(math.isfinite(x) for x in v)
    except (ValueError, AssertionError):
        sl.fail(f'{what} {txt!r}: write {n} numbers separated by commas')
    return v


def parse_args(argv):
    """Parse and check every option, so a bad one is refused in one sentence before any work: ranges, syntax, files."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False)
    ap.add_argument('--out', required=True)
    ap.add_argument('--from', dest='from_')
    ap.add_argument('--hu')
    ap.add_argument('--window')
    ap.add_argument('--labels')
    ap.add_argument('--names')
    ap.add_argument('--mask', action='append')
    ap.add_argument('--face', action='append')
    ap.add_argument('--points', action='append')
    ap.add_argument('--frame', action='append')
    ap.add_argument('--ruler')
    ap.add_argument('--bone-hu', type=float)
    ap.add_argument('--pane-px', type=int)
    ap.add_argument('--mesh-step', type=int)
    ap.add_argument('--plane', action='append')
    ap.add_argument('--center')
    ap.add_argument('--move', action='append')
    ap.add_argument('--rotate')
    ap.add_argument('--zoom', type=float)
    ap.add_argument('--show', action='append')
    ap.add_argument('--hide', action='append')
    takes_value = {o for act in ap._actions if act.nargs != 0 for o in act.option_strings}
    joined, i = [], 0
    while i < len(argv):  # `--window -500,6000` would be read as a flag followed by another flag: join them as --window=-500,6000
        if argv[i] in takes_value and i + 1 < len(argv):
            joined.append(f'{argv[i]}={argv[i + 1]}')
            i += 2
        else:
            joined.append(argv[i])
            i += 1
    a = ap.parse_args(joined)
    if bool(a.from_) == bool(a.hu):
        sl.fail('pass --hu hu.npy for a first view, or --from <earlier>.view.json to change one (not both)')
    for opt, path in [('--from', a.from_), ('--hu', a.hu), ('--labels', a.labels), ('--names', a.names if a.names and a.names.endswith('.json') else None),
                      *[('--frame', f) for f in a.frame or []],
                      *[(f'--{o}', i.partition('=')[2]) for o in ('mask', 'face', 'points') for i in getattr(a, o) or [] if '=' in i]]:
        if path:
            need_file(path, f'{opt}')
    if a.window:
        lo, hi = numbers(a.window, 2, '--window')
        if lo >= hi:
            sl.fail(f'--window {a.window!r}: the low end must be below the high end')
    if a.rotate:
        a.rotate = numbers(a.rotate, 2, '--rotate (azimuth,elevation in degrees)')
    if a.zoom is not None and not a.zoom > 0:
        sl.fail(f'--zoom {a.zoom}: write a number above 0')
    for opt, v in (('--pane-px', a.pane_px), ('--mesh-step', a.mesh_step)):
        if v is not None and v < 1:
            sl.fail(f'{opt} {v}: write a whole number of 1 or more')
    if a.ruler and len(a.ruler.split(',')) != 2:
        sl.fail(f'--ruler {a.ruler!r}: write two point names, A,B')
    return a


def main():
    a = parse_args(sys.argv[1:])
    if a.from_:
        try:
            s = json.loads(Path(a.from_).read_text())['state']
        except (ValueError, KeyError, TypeError):
            sl.fail(f'--from {a.from_!r} is not a view.json written by quad_view.py')
    else:
        s = new_state(a)
    add_layers(s, a)
    for path in [s['scan']['hu'], s['labels'], *s['masks'].values(), *s['faces'].values(), *s['frames']]:
        if path:
            need_file(path, 'the view\'s input file')
    apply_changes(s, Scene(s), a)
    sl.emit(**summary(render(s, a.out)))


if __name__ == '__main__':
    main()
