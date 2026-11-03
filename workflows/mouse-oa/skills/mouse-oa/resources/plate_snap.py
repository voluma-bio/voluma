"""Move traced growth-plate faces onto the plate, and say where it is unsure.

What it does. On each coronal section it searches the two faces together (proximal and distal, one W per U column): a dynamic programme
over U whose state is the pair of offsets of the faces from your curves, each within +-`BAND` voxels. A column scores the plate-ness at the
faces' centre (a dark valley between brighter bone, or the dense line of a closed plate), a bone-to-plate edge under the proximal face and a
plate-to-bone edge under the distal one, a thickness near your curves' median, and closeness to your curves; the faces stay inside
`off_tibia_margin_um` of the tibia and may not cross, so one face cannot slide onto the edge the other belongs to. A move never goes silent: the spans
where the plate contrast is low or a face reached the edge of its band are listed, and every stretch where either face moved farther than
`CAPTURE_VOXELS`. Where it is unsure it keeps your curves: on every such stretch both faces have your curve as it was (one choice for the pair, or the
faces could cross), blended into the snapped one over `RAMP` columns each side so no step joins them. `--snap-unsure` keeps the snapped points there.

When to run it. After you traced the faces, or after a researcher drew or redrew a curve, and before iioc.py or metaphysis_roi.py. Open the
`qc-snap-<V>.jpg` of every section: white dash-dot is the curve that went in, the output (proximal solid, distal dashed) is cyan where your curve was kept, and otherwise red where the
contrast is low, yellow in between, green where it is high. Keep your own judgement over the snap's.
If a researcher redrew one face, pass `--face` with that face and the other, as it stands, only limits the separation.

Limits. It captures a face at most `CAPTURE_VOXELS` (about 10, 0.1 mm) from the plate; a face farther off locks onto the next layer, so trust the flags.
With `--face` the held face pulls less: a snapped face within about 5 voxels of the plate snaps back, one that is 10 off often does not.
It does not extend the ends of a curve or add sections, and a gap in a curve (points farther apart than `max_gap_um`) stays untouched.
It was tuned on 10.5 um voxels (the band, the thicknesses and the contrast scales are in voxels) and refuses a grid more than 10% off that.

Reads the entry `plate-faces` of the spec (`off_tibia_margin_um`, `max_gap_um`, and `max_jump_um`, `jump_overlap_um`), the grid from the sidecar of tibia-hu.npy.
Writes: in <out>,
  annotations.json  your annotations with `growth_plate_curves` and `growth_plate_distal_curves` replaced by the snapped curves on the snapped sections (the
                    same U extent, a point every 5 columns or `max_gap_um`, whichever is closer); every other key, section and grid_id copied
  plate-snap.json  the result record: per section the rough curves that went in, per snapped face the mean and max move (um) of the output, the mean
                   confidence, `columns_kept_input` per face, `moved_beyond_capture` (true when `moved_far` is not empty), `moved_far` (stretches where a face
                   moved more than the capture range, listed for each snapped face with its largest move there) and `low_confidence`: [{"u": [first, last], "why": ..., "move_um": {face: {"median",
                   "max"}}}], the move being what the snap wanted inside that span; each span and `moved_far` entry has `kept_input`: true unless `--snap-unsure`
  qc-snap-<V>.jpg  one image per snapped section, rough against the output
Prints: the result record {out, values, annotations, qc, sections}
Example: python plate_snap.py --spec protocol.json --hu-aligned tibia-hu.npy --mask tibia-mask.npy --annotations annotations.json --out snap/ [--sections 34,46] [--face distal] [--snap-unsure]
Exits 2 with one sentence on bad input, before writing anything; and when the snapped curves break a rule (`refuse_off_tibia`, `refuse_gaps`,
`refuse_jumps`, or the faces crossing) that your curves met: the sentence says the snap caused it.
"""

import contextlib
import io
import json
import sys
import tempfile
from itertools import pairwise
from pathlib import Path

import numpy as np
import sidecar
import viewlib as vl
from annotations import load_annotations, refuse_gaps, refuse_jumps, refuse_off_tibia, tibia_margin
from envelope import footprint
from scipy import ndimage as ndi
from skimage.feature import hessian_matrix, hessian_matrix_eigvals

SPEC_ID = 'plate-faces'
KEYS = {'proximal': 'growth_plate_curves', 'distal': 'growth_plate_distal_curves'}
CAPTURE_VOXELS = 10  # a face this far from the plate snaps back (median error 2.5 voxels on 14 sections of one scan); farther, it may lock onto another layer
BAND = 15  # voxels: how far a face may move from your curve (the search's band)
STEP = 2  # largest change of a face's offset between neighbouring columns
STRIDE = 5  # columns between output points
SIGMA = 2.0  # Gaussian scale of the Hessian, voxels
SIGMA_EDGE = 1.5  # Gaussian scale of the face edge filter, voxels
HESS_HU = 1000.0  # HU per voxel^2 at SIGMA that counts as a full valley
EDGE_HU = 500.0  # HU per voxel that counts as a full edge
TWO_HU = 1500.0  # HU: brightness of both sides over the plate that counts as 1
TWO_EXP = 0.5  # weight of the two-sided brightness in the plate-ness
TWO_NEAR, TWO_FAR = 2, 12  # voxels: where the two sides are looked for (a plate is 10 to 20 voxels thick)
TWO_DIRS = 8  # orientations of the two-sided test
RIDGE = 0.5  # plate-ness of a bright ridge (a closed plate), as a fraction of a full valley
A_PLATE, A_EDGE, A_THICK, A_DEV, A_SMOOTH = 4.0, 1.0, 0.3, 1.0, 1.0  # cost weights: no plate, no edge, thickness off, distance from your curve, offset change per column
SIGMA_T = 4.0  # voxels: the thickness prior's scale
T_MAX = 30.0  # voxels: the faces are never farther apart
CTX = 7.0  # confidence: bright context at this distance either side of the centre, voxels
CONF_HU = 3000.0  # confidence: contrast (HU) that counts as 1
CONF_LOW = 0.2  # a confidence below this is low
MIN_SPAN = 8  # columns: a shorter low-confidence stretch is not listed
MIN_FAR = 3  # columns: a shorter stretch that moved past the capture range is not listed
TUNED_UM = 10.5  # the voxel size the settings above were tuned on
MIN_SEP = 2  # voxels: the faces are never closer (the search's limit)
RAMP = 10  # columns: over this many columns beside a kept input stretch the output blends from your curve to the snapped one


def two_sided(img):
    """Per voxel, over TWO_DIRS orientations: how much brighter the dimmer of the two sides is than the voxel, a side being the brightest voxel
    TWO_NEAR..TWO_FAR away along the orientation's normal. A dark band between two bright faces scores high; the dark side of a bone wall or
    the inside of a marrow cavity (bright on one side only) scores low."""
    ts = np.arange(TWO_NEAR, TWO_FAR + 1)
    n_r, n_c = img.shape
    m = TWO_FAR + 1
    pad = np.pad(img, m, mode='edge')

    def side_max(dr, dc):
        out = np.full(img.shape, -np.inf, np.float32)
        for t in ts:
            r, c = round(t * dr), round(t * dc)
            out = np.maximum(out, pad[m + r : m + r + n_r, m + c : m + c + n_c])
        return out

    best = np.full(img.shape, -np.inf, np.float32)
    for a in np.arange(TWO_DIRS) * np.pi / TWO_DIRS:
        dr, dc = np.sin(a), np.cos(a)
        best = np.maximum(best, np.minimum(side_max(dr, dc), side_max(-dr, -dc)) - img)
    return best


def plateness(sec):
    """(plate-ness in [0, 1], smoothed section): a dark valley between brighter bone (Hessian), gated by bright on both sides, or a dense ridge."""
    img = ndi.gaussian_filter(sec, 1.0)
    l1, l2 = hessian_matrix_eigvals(hessian_matrix(sec, sigma=SIGMA, order='rc', use_gaussian_derivatives=True))
    valley = np.clip(l1 * SIGMA**2 / HESS_HU, 0, 1)
    ridge = np.clip(-l2 * SIGMA**2 / HESS_HU, 0, 1)
    two = np.clip(two_sided(img) / TWO_HU, 0, 1)
    return np.maximum(valley ** (1 - TWO_EXP) * two**TWO_EXP, RIDGE * ridge), img


def confidence(path, img):
    """Plate contrast along `path` ([[w, u], ...]) per point, in [0, 1]: along the local normal, the larger of the dark valley (the dimmer of the two
    sides' brightest voxels minus the path's intensity) and the dense line (the path's intensity minus the brighter of the two sides' dimmest
    voxels), over CONF_HU. A path on a flat stretch or a one-sided edge scores 0."""
    t = np.gradient(path, axis=0)
    t = np.stack([ndi.gaussian_filter1d(t[:, i], 3, mode='nearest') for i in (0, 1)], 1)
    nrm = np.stack([-t[:, 1], t[:, 0]], 1) / np.maximum(np.hypot(*t.T), 1e-9)[:, None]

    def at(q):
        return ndi.map_coordinates(img, q.T, order=1, mode='nearest')

    c = at(path)
    hi, lo = [], []
    for s in (-1, 1):
        side = [at(path + s * d * nrm) for d in np.arange(3, CTX + 1)]  # the bone face: the plate's thickness varies, so not one exact offset
        hi.append(np.max(side, axis=0))
        lo.append(np.min(side, axis=0))
    return np.clip(np.maximum(np.minimum(*hi) - c, c - np.maximum(*lo)) / CONF_HU, 0, 1)


def face_rows(points, n_u, max_gap):
    """A face's [[w, u], ...] -> W per U column, interpolated between points at most `max_gap` columns apart, NaN elsewhere."""
    p = np.asarray(sorted(points, key=lambda q: q[1]), float)
    w = np.full(n_u, np.nan)
    for (w0, u0), (w1, u1) in pairwise(p):
        if u1 - u0 <= max_gap:
            c = np.arange(max(int(np.ceil(u0)), 0), min(int(np.floor(u1)), n_u - 1) + 1)
            w[c] = np.interp(c, [u0, u1], [w0, w1])
    return w


def runs_of(idx):
    """Runs of consecutive integers in the sorted array `idx`."""
    return np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1) if len(idx) else []


def chain(cost_fn, n_col):
    """Cheapest chain of offset pairs (a, b) in [-BAND, BAND]^2 over n_col columns, `cost_fn(i)` the (2 BAND + 1)^2 state costs of column i
    (inf = forbidden); None if every chain is forbidden."""
    n = 2 * BAND + 1
    shifts = [(di, dj) for di in range(-STEP, STEP + 1) for dj in range(-STEP, STEP + 1)]
    back = np.zeros((n_col, n, n), np.uint8)
    cur = cost_fn(0)
    for c in range(1, n_col):
        pad = np.pad(cur, STEP, constant_values=np.inf)
        best, arg = np.full((n, n), np.inf), np.zeros((n, n), np.uint8)
        for k, (di, dj) in enumerate(shifts):
            cand = pad[STEP + di : STEP + di + n, STEP + dj : STEP + dj + n] + A_SMOOTH * (di**2 + dj**2)
            better = cand < best
            best[better], arg[better] = cand[better], k
        back[c] = arg
        cur = best + cost_fn(c)
    flat = int(np.argmin(cur))
    if not np.isfinite(cur.flat[flat]):
        return None
    i, j = divmod(flat, n)
    path = [(i, j)]
    for c in range(n_col - 1, 0, -1):
        di, dj = shifts[back[c, i, j]]
        i, j = i + di, j + dj
        path.append((i, j))
    return np.array(path[::-1]) - BAND


def snap_faces(sec, bone, prox, dist, margin, max_gap, held=None):
    """Snap one section's faces, `prox` and `dist` being [[w, u], ...]; `held` names a face ('proximal' or 'distal') that stays where it is.
    Returns the snapped W per column of each face (NaN where the faces share no run), the confidence per column, and `edge`, the bool per column
    where a moving face is at the band's edge."""
    sec, bone = np.asarray(sec, np.float32), np.asarray(bone, bool)
    n_w, n_u = sec.shape
    plate, img = plateness(sec)
    pw, dw = (face_rows(f, n_u, max_gap) for f in (prox, dist))
    near_bone = ndi.distance_transform_edt(~bone)
    g = ndi.gaussian_filter1d(sec, SIGMA_EDGE, axis=0, order=1, mode='nearest')  # dI/dW
    pe, de = (np.clip(s * g / EDGE_HU, 0, 1) for s in (-1, 1))  # bone above, plate below / plate above, bone below
    off = np.arange(-BAND, BAND + 1, dtype=float)
    A, B = np.meshgrid(off, off, indexing='ij')
    fixed = (A != 0) if held == 'proximal' else (B != 0) if held == 'distal' else np.zeros_like(A, bool)
    dev = A_DEV * (A**2 + B**2) / BAND**2

    def at(arr, r, c):
        return ndi.map_coordinates(arr, [np.clip(r, 0, n_w - 1), np.full_like(r, c)], order=1, mode='nearest')

    def off_tibia(r, c):  # annotations.off_tibia reads a point at its nearest voxel: either voxel a rounded W can land on must be within the margin
        r = np.clip(r, 0, n_w - 1)
        return np.maximum(near_bone[np.floor(r).astype(int), c], near_bone[np.ceil(r).astype(int), c]) > margin

    out_p, out_d, edge = np.full(n_u, np.nan), np.full(n_u, np.nan), np.zeros(n_u, bool)
    for run in runs_of(np.flatnonzero(~np.isnan(pw + dw))):
        t_run = float(np.clip(np.median(dw[run] - pw[run]), MIN_SEP, T_MAX))  # the run's own thickness: one column's error does not move the prior

        def cost(i, run=run, t_run=t_run):
            u = run[i]
            wp, wd = pw[u] + A, dw[u] + B
            t = wd - wp
            c = (A_PLATE * (1 - at(plate, (wp + wd) / 2, u)) + A_EDGE * ((1 - at(pe, wp, u)) + (1 - at(de, wd, u)))
                 + A_THICK * ((t - t_run) / SIGMA_T) ** 2 + dev)
            bad = fixed | (t < MIN_SEP) | (t > T_MAX) | (wp < 0) | (wd > n_w - 1) | off_tibia(wp, u) | off_tibia(wd, u)
            return np.where(bad, np.inf, c)

        path = chain(cost, len(run))
        if path is None:  # nothing inside the limits (the held face is off the tibia, say): leave the curves, and say so
            out_p[run], out_d[run], edge[run] = pw[run], dw[run], True
            continue
        out_p[run], out_d[run] = pw[run] + path[:, 0], dw[run] + path[:, 1]
        moving = path[:, [1]] if held == 'proximal' else path[:, [0]] if held == 'distal' else path
        edge[run] = (np.abs(moving) >= BAND).any(1)
    conf = np.zeros(n_u)
    for run in runs_of(np.flatnonzero(~np.isnan(out_p))):
        conf[run] = confidence(np.stack([(out_p[run] + out_d[run]) / 2, run.astype(float)], 1), img)
    return out_p, out_d, conf, edge


def blend_kept(snapped, rough, keep):
    """`snapped` W per column with your curve `rough` put back on the `keep` columns and blended in linearly over RAMP columns beside them, so
    no step joins the two. Returns (final W, alpha per column: 1 = your curve)."""
    if not keep.any():
        return snapped, np.zeros(len(snapped))
    alpha = np.clip(1 - ndi.distance_transform_edt(~keep) / (RAMP + 1), 0, 1)
    return np.where(alpha > 0, alpha * rough + (1 - alpha) * snapped, snapped), alpha


def snapped_points(points, w, stride, kept):
    """A face's points with its snapped stretches (`w` per column, NaN elsewhere) in place of the points inside them: a point every `stride`
    columns and at each stretch's ends; the points past the stretches, and the gaps, stay as they were. On the `kept` columns (your curve
    as it was) the points stay and no new ones are added, except at the ends of each kept stretch."""
    p = sorted(points, key=lambda q: q[1])
    first, last = p[0], p[-1]
    new = []
    for run in runs_of(np.flatnonzero(~np.isnan(w))):
        p = [q for q in p if not run[0] - 1 < q[1] < run[-1] + 1 or kept[min(max(round(q[1]), 0), len(w) - 1)]]
        have = {q[1] for q in p}
        cols = {u for u in (*run[::stride], run[0], run[-1]) if not kept[u]} | {r[i] for r in runs_of(run[kept[run]]) for i in (0, -1)}
        new += [[round(float(w[u]), 2), int(u)] for u in sorted(cols) if u not in have]
    out = sorted(p + new, key=lambda q: q[1])
    have = {q[1] for q in out}
    for q, col in ((first, np.ceil(first[1])), (last, np.floor(last[1]))):  # a fractional end is the curve's end: keep it, at the snapped height beside it
        if q[1] not in have and 0 <= col < len(w) and not np.isnan(w[int(col)]):
            out.append([round(float(w[int(col)]), 2), q[1]])
    return sorted(out, key=lambda q: q[1])


def spans(flag, min_len):
    return [(int(r[0]), int(r[-1])) for r in runs_of(np.flatnonzero(flag)) if len(r) >= min_len]


def check_image(out, hu, v, window, rough, snapped, conf, kept, vox):
    """qc-snap-<V>.jpg: the section framed on the curves, the curve that went in white dash-dot, proximal solid and distal dashed, the snapped faces coloured by confidence, the columns
    where your curve was put back in cyan."""
    cols = np.flatnonzero(~np.isnan(snapped[0]))
    heights = np.concatenate([x[:, 0] for x in rough] + [s[cols] for s in snapped])
    crop = (max(int(heights.min()) - 25, 0), max(cols[0] - 25, 0), min(int(heights.max()) + 26, hu.shape[0]), min(cols[-1] + 26, hu.shape[2]))
    x = np.arange(hu.shape[2])
    curves = [(r[:, 1], r[:, 0], 'white', '-.') for r in rough]
    for s, k, style in zip(snapped, kept, ('-', '--'), strict=True):  # proximal solid, distal dashed
        for lo, hi, colour in ((0, CONF_LOW, 'red'), (CONF_LOW, 0.5, 'yellow'), (0.5, 1.01, 'lime')):
            curves.append((x, np.where((conf >= lo) & (conf < hi) & ~k, s, np.nan), colour, style))
        curves.append((x, np.where(k, s, np.nan), 'cyan', style))
    title = f'V={v} white = yours; proximal solid, distal dashed; cyan = kept'
    return vl.slice_sheet(out / f'qc-snap-{v}.jpg', hu, [], 1, [v], window, crops=[crop], curves=[curves], titles=[title], axis_names=('W', 'V', 'U'), cols=1, voxel_mm=vox)


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--spec', type=sidecar.existing, required=True, help=f"the workflow's protocol.json: the entry {SPEC_ID} gives the margin and the spacing rules")
    ap.add_argument('--hu-aligned', type=sidecar.existing, required=True, help='tibia-hu.npy from tibia_frame.py')
    ap.add_argument('--mask', type=sidecar.existing, required=True, help='tibia-mask.npy from tibia_frame.py')
    ap.add_argument('--annotations', type=sidecar.existing, required=True, help='annotations JSON on the aligned grid')
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--sections', metavar='V,V,...', help='V indices of the sections to snap (default: every section with both faces)')
    ap.add_argument('--face', choices=('proximal', 'distal', 'both'), default='both', help='the face(s) to snap; the other stays as it is and only limits the separation')
    ap.add_argument('--snap-unsure', action='store_true', help='keep the snapped points on the low-confidence and moved-far stretches (default: your curve is put back there)')
    ap.add_argument('--window', type=vl.window_arg, metavar='lo,hi', help='QC display window in HU, or the workflow\'s anatomy.json (default: from the scan)')
    a = ap.parse_args()
    side = sidecar.sidecar_path(a.hu_aligned)
    if not side.exists():
        sidecar.fail(f'{side} (the sidecar of tibia-hu.npy, which names its grid) is missing: pass the tibia-hu.npy tibia_frame.py wrote')
    grid = sidecar.grid(side)
    vox = grid['spacing_zyx_mm'][0]
    if any(abs(s * 1000 / TUNED_UM - 1) > 0.1 for s in grid['spacing_zyx_mm']):
        sidecar.fail(f'the grid spacing {grid["spacing_zyx_mm"]} mm is more than 10% off {TUNED_UM} um: the snap settings are in voxels tuned at {TUNED_UM} um')
    hu = np.load(a.hu_aligned, mmap_mode='r')
    tib = np.load(a.mask).astype(bool)
    if tib.shape != hu.shape or list(hu.shape) != list(grid['shape']):
        sidecar.fail(f'tibia-hu.npy {hu.shape} and tibia-mask.npy {tib.shape} must be one grid: pass the files tibia_frame.py wrote together')
    ann = load_annotations(a.annotations, grid)
    for k in KEYS.values():
        if k in ann and (ann[k].get('axis') != 1 or ann[k].get('height', 'row') != 'row'):
            sidecar.fail(f'"{k}" must be traced on coronal sections of the aligned stack ("axis": 1, "height": "row", a point is [row = W, column = U])')
    traced = {f: ann.get(k, {}).get('slices', {}) for f, k in KEYS.items()}
    both = sorted(int(v) for v in set(traced['proximal']) & set(traced['distal']))
    if a.sections:
        try:
            todo = list(dict.fromkeys(int(x) for x in a.sections.split(',')))
        except ValueError:
            sidecar.fail(f'--sections must be V indices separated by commas, got {a.sections!r}')
        missing = [v for v in todo if v not in both]
        if missing:
            sidecar.fail(f'--sections {missing[0]} has no curve for both faces: name V indices from {both}')
    else:
        todo = both
    if not todo:
        sidecar.fail('no section has both faces traced: trace the proximal and distal face on the sections first')
    held = None if a.face == 'both' else 'distal' if a.face == 'proximal' else 'proximal'
    margin = tibia_margin(a.spec, vox)
    max_gap = sidecar.protocol(a.spec, SPEC_ID, 'max_gap_um')['max_gap_um'] / 1000 / vox
    stride = max(1, min(STRIDE, int(max_gap)))
    out = Path(a.out)
    window = a.window or vl.auto_window(hu[:, hu.shape[1] // 2, :])
    um = vox * 1000
    new = json.loads(json.dumps(ann))
    snapped_faces = [f for f in KEYS if f != held]
    sections, skipped, qc = {}, {}, []
    for v in todo:
        rough = {f: traced[f][str(v)] for f in KEYS}
        sec, bone = np.asarray(hu[:, v, :], np.float32), tib[:, v, :]
        wp, wd, conf, edge = snap_faces(sec, bone, rough['proximal'], rough['distal'], margin, max_gap, held)
        snapped = {'proximal': wp, 'distal': wd}
        cols = np.flatnonzero(~np.isnan(wp))
        if not len(cols):
            skipped[str(v)] = f'the faces share no stretch with points at most {max_gap * um:.0f} um apart'
            continue
        rows = {f: face_rows(rough[f], hu.shape[2], max_gap) for f in KEYS}
        move = {f: np.abs(snapped[f] - rows[f]) for f in snapped_faces}  # what the snap wanted, voxels per column
        low = [(s, 'low plate contrast') for s in spans((conf < CONF_LOW) & ~np.isnan(wp), MIN_SPAN)] + [(s, "a face at the search band's edge") for s in spans(edge, MIN_SPAN)]
        far = spans(np.any([m > CAPTURE_VOXELS for m in move.values()], axis=0), MIN_FAR)
        # one stretch choice for the pair: the search moved the faces together, so a face kept alone could cross its partner
        keep = np.zeros(hu.shape[2], bool)
        if not a.snap_unsure:
            for s, *_ in (*low, *((s,) for s in far)):
                keep[s[0] : s[1] + 1] = True
        kept = {}
        for f in snapped_faces:
            kept[f] = keep & ~np.isnan(snapped[f])
            snapped[f], _ = blend_kept(snapped[f], rows[f], kept[f])
        final = {f: np.abs(snapped[f] - rows[f]) for f in snapped_faces}
        sections[str(v)] = {
            'rough': rough,
            'mean_move_um': {f: round(float(np.nanmean(m)) * um, 1) for f, m in final.items()},
            'max_move_um': {f: round(float(np.nanmax(m)) * um, 1) for f, m in final.items()},
            'mean_confidence': round(float(conf[cols].mean()), 3),
            'moved_beyond_capture': bool(far),
            'columns_kept_input': {f: int(k.sum()) for f, k in kept.items()},
            'moved_far': [{'u': list(s), 'face': f, 'max_move_um': round(float(np.nanmax(move[f][s[0] : s[1] + 1])) * um, 1), 'kept_input': not a.snap_unsure}
                          for s in far for f in snapped_faces],
            'low_confidence': sorted(
                ({'u': list(s), 'why': why, 'kept_input': not a.snap_unsure,
                  'move_um': {f: {'median': round(float(np.median(m[s[0] : s[1] + 1])) * um, 1),
                                  'max': round(float(np.max(m[s[0] : s[1] + 1])) * um, 1)} for f, m in move.items()}}
                 for s, why in low), key=lambda e: e['u']),
        }
        for f in snapped_faces:
            new[KEYS[f]]['slices'][str(v)] = snapped_points(rough[f], snapped[f], stride, kept[f])
        # the faces as downstream reads them (the written points, interpolated): a snap that turns them across each other is refused
        written = {f: face_rows(new[KEYS[f]]['slices'][str(v)] if f in snapped_faces else rough[f], hu.shape[2], max_gap) for f in KEYS}
        with np.errstate(invalid='ignore'):
            crossed = np.flatnonzero((written['distal'] - written['proximal'] <= 0) & (rows['distal'] - rows['proximal'] > 0))
        if len(crossed):
            sidecar.fail(f'the snap would put the faces on V={v} across each other (at U={crossed[0]}), where yours are not: '
                         f'this is the snap, not your tracing; leave V={v} out with --sections, or snap one face with --face')
        qc.append((v, [np.asarray(rough[f], float) for f in KEYS], [snapped[f] for f in KEYS], conf, [kept.get(f, np.zeros(hu.shape[2], bool)) for f in KEYS]))
    if not sections:
        sidecar.fail(f'no section could be snapped: {"; ".join(f"V={v}: {why}" for v, why in skipped.items())}')
    # the snapped curves obey every rule your curves obeyed, and the schema every later script reads; nothing is written before this passes
    on_bone = footprint(tib)
    for key in KEYS.values():
        for refuse, arg in ((refuse_off_tibia, tib), (refuse_gaps, tib), (refuse_jumps, on_bone)):
            if passes(refuse, ann, key, arg, a.spec, vox) and not passes(refuse, new, key, arg, a.spec, vox):
                print('The snap, not your tracing, broke this rule: your curves met it.', file=sys.stderr)
                refuse(new, key, arg, a.spec, vox)
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, 'annotations.json').write_text(json.dumps(new) + '\n')
        load_annotations(Path(tmp, 'annotations.json'), grid)
    out.mkdir(parents=True, exist_ok=True)
    ann_path = out / 'annotations.json'
    ann_path.write_text(json.dumps(new) + '\n')
    images = [check_image(out, hu, v, window, rough, snapped, conf, kept, vox) for v, rough, snapped, conf, kept in qc]
    far = [v for v, s in sections.items() if s['moved_beyond_capture']]
    low_spans = sum(len(s['low_confidence']) for s in sections.values())
    values = {
        'snap-sections': sidecar.value(len(sections), 'count', 'coronal sections whose faces were snapped', kind='diagnostic'),
        'snap-sections-moved-beyond-capture': sidecar.value(
            len(far), 'count', f'snapped sections where a face moved more than {CAPTURE_VOXELS} voxels: the snap may have locked onto another layer', kind='diagnostic'),
        'snap-low-confidence-spans': sidecar.value(
            low_spans, 'count', 'stretches where the plate contrast is low or a face reached the edge of its search band: look at each', kind='diagnostic'),
    }
    sidecar.emit_values(
        out / 'plate-snap.json',
        values,
        {'grid_id': grid['grid_id'], 'snapped': snapped_faces, 'capture_range_voxels': CAPTURE_VOXELS, 'sections': sections, 'skipped': skipped},
        annotations=str(ann_path),
        qc=images,
        sections_moved_beyond_capture=far,
    )


def passes(refuse, ann, *args):
    """Whether `refuse` (one of annotations.py's refuse_*, which exits with a sentence when it refuses) accepts `ann`."""
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            refuse(ann, *args)
    except SystemExit:
        return False
    return True


if __name__ == '__main__':
    main()
