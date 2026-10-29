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
  --labels L.npy [--names 1=femur,.. | anatomy.json]   label volume: outlines on slices, colours in 3D (hidden: bone is ivory)
  --mask NAME=M.npy      bool volume on any registered grid: outline on slices, translucent surface in 3D
  --face NAME=F.npy      2D array of a frame's axis-0 index over its axes 1, 2 (NaN = none; iioc's growth-plate face): a line
  --points NAME=P.json   named points, each with a grid_id (what pick.py writes): markers and names; sphere in 3D
  --ruler A,B            line between two named points with its length in mm
  --bone-hu HU           bone surface from HU when there are no labels
Changes, applied in this order:
  --plane K:axis=J | K:normal=z,y,x[:up=z,y,x] | K:contains=A,B | K:frame=frame.json:axis=J    pane K (0-2); vectors in mm;
        `contains` cuts along the line through two named points (reslice along a bone); `up` is the screen-up direction
  --center NAME|z,y,x    NAME is a point, a label name or a mask; z,y,x are scan voxel indices
  --move axisK+N | paneK-N[mm]   step the crosshair N voxels along scan axis K, or along pane K's normal (voxels, or mm with `mm`)
  --rotate az,el         turn the 3D camera by degrees      --zoom Z   slice panes' field of view = whole scan / Z (3D always fits the bone)
"""
import argparse
import hashlib
import json
import math
import re
import sys
import time
from pathlib import Path

import matplotlib.patheffects as pe
import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path, so every directory a script imports from is added here.
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'microct-core/resources')]
try:
    import frame as fr
    import viewlib as vl
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects <workflows>/microct-analysis/skills/<skill>/resources/ with '
             '<workflows>/microct-analysis/skills/microct-core/resources/sidecar.py beside it')

sl, plt = vl.sidecar, vl.plt
PANE_COLOURS = ['#ff3b30', '#34c759', '#4f8dff']  # pane 0, 1, 2: its border, its plane in 3D, its line in the other panes
IVORY, POINT_COLOUR, RULER_COLOUR = '#e8dcc0', '#ffd60a', '#00e5ff'
OVERLAY = ['#ff9f0a', '#bf5af2', '#b6f23c', '#ff4fd8', '#1fa89a', '#c8864b']  # masks, then faces, in the order they were added
ML, MT, MR, MB = 46, 26, 6, 34  # margins around a pane: tick labels left and bottom, title on top
ISOTROPIC_TOL = 0.01
MESH_TARGET = 200  # voxels along the longest axis of a surface's grid: a 3D pane has 800 px, and 2M triangles take 5 s to draw
MIN_VOXELS = 50  # smaller pieces are not drawn in 3D
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
        if self.sp.max() / self.sp.min() - 1 > ISOTROPIC_TOL:
            sl.fail(f'voxels are not isotropic ({self.sp.tolist()} mm), so a frame is not a rigid motion in mm: resample the scan '
                    'first, or draw only layers on the scan grid')
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
    if 'axis' in toks and 'frame' not in toks:
        j = int(toks['axis'])
        s['panes'][k] = make_pane(*AXIS_PANES[j], axis=j)
    elif 'frame' in toks:
        f = fr.load(toks['frame'])
        j = int(toks.get('axis', 0))
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
        az, el = (float(x) for x in a.rotate.split(','))
        cam = s['camera']
        cam['azimuth'] = (cam['azimuth'] + az) % 360
        cam['elevation'] = max(-89.0, min(89.0, cam['elevation'] + el))
    if a.zoom:
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
            labels = [f'{t:+.{max(0, -math.floor(math.log10(step)))}f}' for t in ticks]
            name = 'mm from the crosshair'
        if which == 'y':
            ax.set_yticks(pos, labels, fontsize=8, color='#bbbbbb')
            ax.set_ylabel(name, fontsize=7, color='#bbbbbb', labelpad=1)
        else:
            ax.set_xticks(pos, labels, fontsize=8, color='#bbbbbb')
            ax.set_xlabel(name, fontsize=7, color='#bbbbbb', labelpad=1)
    ax.tick_params(length=3, color='#888888', pad=2)


# ---- meshes ---------------------------------------------------------------------------------------------------------

class Meshes:
    """Surfaces in mm (x, y, z) of the scan, cached as .vtp files under `cache_dir` keyed by path, mtime, step and what was cut."""

    def __init__(self, cache_dir):
        self.dir = Path(cache_dir)

    def cached(self, key, build):
        import pyvista as pv
        f = self.dir / (hashlib.sha1(json.dumps(key, default=str).encode()).hexdigest()[:20] + '.vtp')
        if f.exists():
            return pv.read(f)
        mesh = build()
        if mesh.n_points:
            mesh = mesh.compute_normals(split_vertices=False)  # drawing computes them otherwise, on every call
        self.dir.mkdir(parents=True, exist_ok=True)
        mesh.save(f)
        return mesh

    def of_mask(self, scene, path, select, kind):
        """Surface of `select(volume at step)` for the array at `path`, mapped through its frame onto the scan."""
        s = scene.s
        vol, _, to_scan = scene.open(path)
        step = s['mesh_step'] or max(1, round(max(vol.shape) / MESH_TARGET))
        st = Path(path).stat()
        key = (str(path), st.st_mtime_ns, step, kind, scene.gid)

        def build():
            import pyvista as pv
            from skimage.measure import marching_cubes
            small = select(np.asarray(vol[::step, ::step, ::step]))
            if small.sum() < MIN_VOXELS:
                return pv.PolyData()
            v, f, _, _ = marching_cubes(np.pad(small, 1).astype(np.float32), 0.5)
            mm = to_scan((v - 1) * step) * scene.sp
            faces = np.hstack([np.full((len(f), 1), 3), f]).astype(np.int64).ravel()
            return pv.PolyData(mm[:, ::-1].copy(), faces).smooth(n_iter=20)
        return self.cached(key, build)

    def of_face(self, scene, path):
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
        return self.cached(key, build)


def bone_mesh(s, scene, meshes):
    if s['labels']:
        return meshes.of_mask(scene, s['labels'], lambda a: a > 0, 'bone')
    if s['bone_hu'] is None:
        sl.fail('the 3D pane needs a bone surface: pass --labels or --bone-hu (the HU above which a voxel is bone)')
    thr = s['bone_hu']
    return meshes.of_mask(scene, s['scan']['hu'], lambda a: a > thr, f'hu>{thr}')


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
        lab, _, _ = scene.open(s['labels'])
        for k in sorted(int(x) for x in np.unique(lab[::4, ::4, ::4]) if x):
            m = meshes.of_mask(scene, s['labels'], lambda a, k=k: a == k, f'label{k}')
            if m.n_points:
                p.add_mesh(m, color=vl.colour(k), smooth_shading=True, opacity=0.5 if overlays else 1.0)
    else:
        bone = bone_mesh(s, scene, meshes)
        p.add_mesh(bone, color=IVORY, smooth_shading=True, opacity=0.25 if overlays else 1.0)
    for name in (n for n in s['masks'] if n in shown):
        m = meshes.of_mask(scene, s['masks'][name], lambda a: a > 0, 'mask')
        if m.n_points:
            p.add_mesh(m, color=overlay_colour(s, name), smooth_shading=True, opacity=0.85)
    for name in (n for n in s['faces'] if n in shown):
        m = meshes.of_face(scene, s['faces'][name])
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

def outline(ax, arr, colour, lw=1.2, alpha=0.15):
    ax.contour(arr.astype(float), levels=[0.5], colors=[colour], linewidths=lw)
    ax.imshow(np.ma.masked_where(~arr, arr), cmap=matplotlib_cmap(colour), alpha=alpha, interpolation='nearest')


def matplotlib_cmap(colour):
    from matplotlib.colors import ListedColormap
    return ListedColormap([colour])


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
        for lv in np.unique(lab[lab > 0]):
            outline(ax, lab == lv, vl.colour(lv))
    for name in (n for n in s['masks'] if n in shown):
        vol, to_index, _ = scene.open(s['masks'][name])
        m = cut(vol, to_index, 0) > 0
        if m.any():
            outline(ax, m, overlay_colour(s, name))
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


def legend_lines(s, scene):
    shown = set(s['shown'])
    out = []
    if s['labels'] and 'labels' in shown:
        lab, _, _ = scene.open(s['labels'])
        out += [(vl.colour(int(i)), f'{i} {s["names"].get(str(int(i)), "(unnamed)")}') for i in np.unique(lab[::4, ::4, ::4]) if i]
    out += [(overlay_colour(s, n), n) for n in s['masks'] if n in shown]
    out += [(overlay_colour(s, n), n + ' (face)') for n in s['faces'] if n in shown]
    return out


# ---- render ---------------------------------------------------------------------------------------------------------

def render(state, out):
    """Draw `state` (a dict as in view.json) to the JPEG `out`; write `<out>.view.json` and return it. Refuses to overwrite either."""
    out = Path(out)
    view_path = out.with_suffix('.view.json')
    for f in (out, view_path):
        if f.exists():
            sl.fail(f'{f} exists and an earlier view is never rewritten: choose another --out')
    out.parent.mkdir(parents=True, exist_ok=True)
    s = json.loads(json.dumps(state))
    t = {}
    t0 = time.perf_counter()
    scene = Scene(s)
    if not s['window']:
        s['window'] = list(vl.auto_window(scene.hu[scene.shape[0] // 2]))
    P = s['pane_px']
    cw, ch = P + ML + MR, P + MT + MB
    W, H = 2 * cw, 2 * ch
    if max(W, H) > sl.MAX_IMAGE_PX:
        sl.fail(f'panes of {P} px make a {W}x{H} image, over {sl.MAX_IMAGE_PX} px: use --pane-px {(sl.MAX_IMAGE_PX - 2 * (ML + MR)) // 2} or less')
    geoms = [pane_geometry(s, scene, k) for k in range(3)]
    t['open'] = time.perf_counter() - t0

    t0 = time.perf_counter()
    meshes = Meshes(out.parent / '.quad-view-cache')
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
            ax.imshow(img3d)
            ax.set_xticks([])
            ax.set_yticks([])
            colour = '#888888'
            title = f'3D: azimuth {s["camera"]["azimuth"]:.0f}, elevation {s["camera"]["elevation"]:.0f}'
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
            for n, (c, label) in enumerate(legend_lines(s, scene)):
                text(ax, 8, P - 10 - 14 * n, label, c, size=8)
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
    view_path.write_text(json.dumps(view, indent=1, default=float) + '\n')
    return view


def summary(view):
    s = view['state']
    return {'image': view['image'], 'view': str(Path(view['image']).with_suffix('.view.json')),
            'crosshair_zyx': [round(v, 1) for v in s['center_zyx']], 'zoom': s['zoom'], 'camera': s['camera'],
            'panes': [p['name'] for p in view['panes']], 'shown': s['shown'], 'window_hu': s['window'],
            'timings_s': view['timings_s'], 'jpeg_kib': round(Path(view['image']).stat().st_size / 1024)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', required=True)
    ap.add_argument('--from', dest='from_', help='the view.json of an earlier image: start from its state')
    ap.add_argument('--hu', help='hu.npy of the scan (first call)')
    ap.add_argument('--window', help='lo,hi in HU')
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
    argv = sys.argv[1:]
    for i, tok in enumerate(argv[:-1]):  # `--rotate 0,-30` would be read as a flag followed by another flag
        if tok == '--rotate':
            argv[i:i + 2] = [f'--rotate={argv[i + 1]}']
    a = ap.parse_args(argv)
    if bool(a.from_) == bool(a.hu):
        sl.fail('pass --hu hu.npy for a first view, or --from <earlier>.view.json to change one (not both)')
    s = json.loads(Path(a.from_).read_text())['state'] if a.from_ else new_state(a)
    add_layers(s, a)
    apply_changes(s, Scene(s), a)
    sl.emit(**summary(render(s, a.out)))


if __name__ == '__main__':
    main()
