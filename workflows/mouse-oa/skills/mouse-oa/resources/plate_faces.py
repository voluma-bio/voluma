"""Propose the tibial growth plate's two faces in 3D from the densities, only where the search finds the plate.

The plate is a thin sheet of lower density between denser bone, found as a valley of the smoothed HU along W (the
second derivative along W after a Gaussian) and followed along U by a dynamic-programming search, every coronal section at once. Each face is the half-depth edge of that valley. This is a proposal, never a trace: you look at it
section by section, keep what sits on the plate and retrace the rest. It jumps up into dark epiphyseal marrow spaces, and where the plate
is eroded it still draws a convincing sheet on the wrong structure. A column is untrusted when the centre
changes height faster than a plate can along U or V, the centre is more than `flag_min_dip_hu` brighter than its shallower shoulder (a plate is darker than the bone beside it), a face
lies farther than `face_reach_um` from the centre, or the bone surface above it is steeper than `max_surface_slope` (the search band
follows that surface, so on a cortical wall it runs down the wall, not along a plate). Every threshold is in the spec, entry `plate-faces`.

Where it finds the plate. On each section, a run of trusted columns at least `min_run_um` wide counts; runs join a chain across a gap
of at most `bridge_um`, and the longest chain gives the section's span, first to last column. A section with no run has no span and
gets nothing. Inside a span every column that is not trusted is flagged: the proposal has no points there and you trace it. Outside a span the
proposal says nothing and flags nothing, but the plate is still there to be traced: a span is where you can start, not where you stop. The faces
must cover the plate over the whole tibia at plate level (see the rule below), so you read the plate off zoomed coronal views past each span
end and on the sections with no span. The spans, the V range and what ended each span are in
`plate-faces.json` (`covered`) and printed: say in your report where the proposal covered and where you traced beyond it.

`plate-annotations.json` is JSON in the annotations schema: "grid_id", `growth_plate_curves` (annotation A, for iioc.py) and
`growth_plate_distal_curves` (annotation C, for metaphysis_roi.py), one curve per proposed section, many points each, none in a
flagged stretch. Copy both keys into your annotations.json. The flagged stretches are in `plate-faces.json` (`stretches`:
{"<V>": [{"u": [first U, last U], "why": [tests that fired]}]}): where to look hardest and to retrace, by adding your points to the
section's curve in both keys. `iioc.py` and `metaphysis_roi.py` hold the faces to one rule, flagged or not: every (V, U) column where the tibia exists at plate level (the tibia
between the section's lowest and highest curve points, widened by `max_gap_um`) lies within `max_gap_um` of a traced point, along U on a
section and along V between sections, out to the V ends (a surface is linear between points and held constant past them, so an
untraced stretch is a straight bridge, wrong geometry however the plate looks there; columns with no tibia at plate level, such as the
notch between the condyles at the front, are not demanded),
and no point more than `off_tibia_margin_um` off the tibia mask. A flagged stretch needs your points only where it opens a gap wider than
`max_gap_um`; that the points lie on the plate is for you to see, not for the rule. Your points and the proposed ones count alike.
Where the plate is destroyed, mark the U range where it is gone, on every traced section it reaches, in your annotations as `plate_eroded`:
{"<V>": [{"u": [first U, last U], "eroded": "<why>"}]}, integer U. Trace the remaining bone there with both faces: the section's curve
must reach both ends of a marked range, and the mark never replaces points. `metaphysis_roi.py` then accepts the distal face at or
above the proximal one in the marked range (on the rows between two sections that both mark it), and both scripts report the marked
ranges and their share of the plate.
Retrace any stretch that sits off the plate even if it is not flagged. Edit the curves, not the surface, so what the later
scripts cut is what you traced. Both scripts write `qc-faces-<n>.jpg`: the faces as you delivered them, on every traced section.

Writes: in <out>, on the aligned grid (array axes W,V,U), each .npy with its sidecar:
  plate-centre.npy  W index of the plate's centre per (V,U), float32, NaN where the tibia has no search band
  plate-flagged.npy  2D bool per (V,U): where the centre is not to be trusted
  plate-annotations.json  the proposed curves (annotation A and C), with no points in flagged stretches
  plate-faces.json  the result record: counts, the flagged stretches (`stretches`), where the proposal covers (`covered`: the V range
                    and per section its U span and the tests that ended it on each side) and the grid_id
  qc-plate-<n>.jpg  coronal sections framed on each section's span, every proposed section unless --sections names others: orange proximal
                    face, cyan distal face, white centre across the span; a red tick under each flagged column, where the faces have no line
Prints: the result record {out, values, annotations, centre, flagged, stretches, qc (the images)}
Example: python plate_faces.py --spec protocol.json --window anatomy.json --hu-aligned tibia-hu.npy --mask tibia-mask.npy --out plate/
Exits 2 with one sentence on bad input, before writing anything, and when the search finds the plate on fewer than two sections.
"""

import json
from pathlib import Path

import numpy as np
import sidecar
import viewlib as vl
from annotations import load_annotations
from scipy import ndimage as ndi

SPEC_ID = 'plate-faces'  # the spec entry this script reads
SPEC_KEYS = (
    'smooth_sigma_um', 'valley_hu', 'search_start_um', 'search_end_um', 'dp_max_slope', 'dp_step_penalty_per_um', 'face_reach_um',
    'dip_smooth_um', 'median_um', 'flag_slope', 'flag_min_dip_hu', 'flag_pad_um', 'flag_min_area_um2',
    'max_surface_slope', 'min_run_um', 'bridge_um',
    'section_step_um', 'point_step_um', 'qc_panels',
)
OUTSIDE = 1e4  # DP cost outside the search band: larger than any path through it


def dp_height_field(cost, max_step, penalty):
    """Min-cost W per (V, U): a path along U through cost (W,V,U) that moves at most max_step in W per column,
    each unit of move costing `penalty`; every V is searched at once."""
    c = np.moveaxis(cost, 2, 1)  # (W, U, V)
    n_w, n, n_other = c.shape
    acc = c[:, 0, :].copy()
    back = np.zeros((n, n_w, n_other), np.int8)
    for i in range(1, n):
        best, arg = acc.copy(), np.zeros((n_w, n_other), np.int8)
        for d in range(1, max_step + 1):
            for s in (d, -d):
                prev = np.full_like(acc, np.inf)
                if s > 0:
                    prev[s:] = acc[:-s]
                else:
                    prev[:s] = acc[-s:]
                prev += penalty * d
                better = prev < best
                best, arg = np.where(better, prev, best), np.where(better, -s, arg).astype(np.int8)
        acc, back[i] = best + c[:, i, :], arg
    w = acc.argmin(0)
    path = np.zeros((n, n_other), np.int32)
    path[-1] = w
    cols = np.arange(n_other)
    for i in range(n - 1, 0, -1):
        w = w + back[i][w, cols]
        path[i - 1] = w
    return path.T.astype(np.float32)


def centre_pass(h, tib, first, sp, vox):
    """The centre by the search along U and where the tibia has a search band: the valley is the voxels
    where the smoothed second derivative along W is positive and the smoothed HU inside the plate window. The cost is that
    second derivative in HU/um^2, the step penalty is per um of height change."""
    vox_um = vox * 1000
    sigma = [s / vox_um for s in sp['smooth_sigma_um']]
    d2 = ndi.gaussian_filter(h, sigma, order=(2, 0, 0), mode='nearest') / vox_um**2
    smooth = ndi.gaussian_filter(h, sigma, mode='nearest')
    w = np.arange(h.shape[0])[:, None, None]
    start, end = (first + round(sp[k] / vox_um) for k in ('search_start_um', 'search_end_um'))
    band = tib & (first[None] >= 0) & (w >= start[None]) & (w <= end[None])
    valley = band & (d2 > 0) & (smooth > sp['valley_hu'][0]) & (smooth < sp['valley_hu'][1])
    cost = np.where(valley, -d2, np.where(band, 0, OUTSIDE)).astype(np.float32)
    return dp_height_field(cost, round(sp['dp_max_slope']), sp['dp_step_penalty_per_um'] * vox_um), band.any(0)


def faces_dip_far(s, path, reach):
    """At each column's `path` height in s (the scan smoothed along W): the proximal and distal face (half the depth of the
    valley, walked out at least 1 and at most `reach` voxels), the dip (HU of the shallower shoulder minus HU at the path) and
    where either face is `far`: the half depth is not reached before the end of the walk."""
    n_w = s.shape[0]
    c = np.rint(path).astype(int)
    prof = np.take_along_axis(s, np.clip(c[None] + np.arange(-reach, reach + 1)[:, None, None], 0, n_w - 1), axis=0)
    valley = prof[reach]
    shoulders = prof[:reach].max(0), prof[reach + 1 :].max(0)
    ends = []
    for walk, shoulder in ((prof[reach::-1], shoulders[0]), (prof[reach:], shoulders[1])):
        hit = walk >= (valley + (shoulder - valley) / 2)[None]
        ends.append(np.clip(np.where(hit.any(0), hit.argmax(0), reach), 1, reach))
    return c - ends[0], c + ends[1], np.minimum(*shoulders) - valley, np.maximum(*ends) >= reach


def slope(a, k):
    """Largest rise per column of `a` across +-k columns, along U or V."""
    return np.maximum(*(np.abs(np.roll(a, -k, ax) - np.roll(a, k, ax)) / (2 * k) for ax in (0, 1)))


def flag_columns(centre, dip, far, wall, ok, sp, vox, med):
    """Per (V, U): where the proposal is not to be trusted, and which tests fired. Flags: the centre is
    steeper than a plate along U or V, it is denser than its shallower shoulder (dip below `flag_min_dip_hu`), a face is far from it,
    or the tibia's surface above is on a cortical wall. Blobs of flags are joined by a closing of `flag_pad_um`, specks dropped."""
    why = {
        'steeper than a plate': slope(centre, med // 2 + 1) > sp['flag_slope'],
        'centre denser than its shoulder': dip < sp['flag_min_dip_hu'],
        'face far from the centre': far,
        'on a cortical wall': wall,
    }
    pad = round(sp['flag_pad_um'] / 1000 / vox)
    flagged = ndi.binary_closing(np.logical_or.reduce(list(why.values())) & ok, iterations=pad)
    labels = ndi.label(flagged)[0]
    sizes = np.bincount(labels.ravel())
    big = np.flatnonzero(sizes >= sp['flag_min_area_um2'] / (vox * 1000) ** 2)
    flagged = np.isin(labels, big[big > 0]) & ok
    return flagged, why


def propose(h, tib, sp, vox):
    """Centre, faces and flags per (V, U), and the tests that fired."""
    first = np.where(tib.any(0), tib.argmax(0), -1)  # the articular surface: first tibia voxel along W
    path, ok = centre_pass(h, tib, first, sp, vox)
    med = round(sp['median_um'] / 1000 / vox) | 1
    # the search band follows the surface, so on a cortical wall it runs down the wall: a surface that steep is not a plate's roof
    wall = slope(ndi.median_filter(first.astype(np.float32), size=med, mode='nearest'), med // 2 + 1) > sp['max_surface_slope']
    centre = ndi.median_filter(path.astype(np.float32), size=med, mode='nearest')  # the median drops the search's wiggles
    s = ndi.gaussian_filter(h, [x / 1000 / vox for x in sp['dip_smooth_um']], mode='nearest')
    upper, lower, dip, far = faces_dip_far(s, centre, round(sp['face_reach_um'] / 1000 / vox))
    flagged, why = flag_columns(centre, dip, far, wall, ok, sp, vox, med)
    # the faces are median-smoothed and kept a voxel either side of the centre
    upper, lower = (ndi.median_filter(f.astype(np.float32), size=med, mode='nearest') for f in (upper, lower))
    return centre, np.minimum(upper, centre - 1), np.maximum(lower, centre + 1), flagged, ok, why


def runs_of(row):
    """[first, last] of each run of True in a 1D bool array."""
    edges = np.flatnonzero(np.diff(np.r_[0, row.astype(np.int8), 0]))
    return [(a, b - 1) for a, b in zip(edges[::2], edges[1::2], strict=True)]


def covered(trusted, sp, vox):
    """Where the search found the plate: per section V, the U span {V: (first, last)} of its longest chain of trusted runs, and
    `kept`, bool (V, U): the trusted columns inside those spans. A run counts when it is at least `min_run_um` wide, and runs
    join a chain across a gap of at most `bridge_um`; a section with no run has no span, so nothing is proposed there. Inside a
    span, every column that is not kept is for the worker to trace; outside it the proposal says nothing."""
    min_run, bridge = (round(sp[k] / 1000 / vox) for k in ('min_run_um', 'bridge_um'))
    spans, kept = {}, np.zeros_like(trusted)
    for v in np.flatnonzero(trusted.any(1)):
        chains = []
        for a, b in runs_of(trusted[v]):
            if b - a + 1 >= min_run:
                if chains and a - chains[-1][-1][1] - 1 <= bridge:
                    chains[-1].append((a, b))
                else:
                    chains.append([(a, b)])
        if chains:
            best = max(chains, key=lambda c: sum(b - a + 1 for a, b in c))
            spans[int(v)] = (int(best[0][0]), int(best[-1][1]))
            for a, b in best:
                kept[v, a : b + 1] = True
    return spans, kept


def curves(face, kept, sections, step_u):
    """Annotation curves of `face` (W per V,U) on `sections`, every `step_u` columns, at the kept columns only.
    A section with fewer than two points is left out."""
    slices = {}
    for v in sections:
        us = np.flatnonzero(kept[v])
        us = us[us % step_u == 0]
        if len(us) >= 2:
            slices[str(v)] = [[round(float(face[v, u]), 1), int(u)] for u in us]
    return {'axis': 1, 'height': 'row', 'slices': slices}


def stretches(flagged, why, sections):
    """The runs of U to trace on each proposed section, as `plate-faces.json` lists them:
    {"<V>": [{"u": [first, last], "why": [tests that fired]}]}."""
    found = {}
    for v in sections:
        spans = runs_of(flagged[v])
        if spans:
            found[str(v)] = [{'u': [int(a), int(b)], 'why': [r for r, m in why.items() if m[v, a : b + 1].any()] or ['no plate found between the trusted stretches']}
                             for a, b in spans]
    return found


def stopped_by(why, ok, spans, reach):
    """{"<V>": {"first U side": [...], "last U side": [...]}}: what ends each section's span, the tests that fired on its next
    `reach` columns with a search band ("no search band" where there is none, as at the tibia's edge)."""
    out = {}
    for v, (a, b) in spans.items():
        ends = {}
        for side, cols in (('first U side', np.arange(max(a - reach, 0), a)), ('last U side', np.arange(b + 1, min(b + 1 + reach, ok.shape[1])))):
            cols = cols[ok[v, cols]]
            ends[side] = [r for r, m in why.items() if m[v, cols].any()] if len(cols) else ['no search band']
        out[str(v)] = ends
    return out


def qc_images(out, h, maps, kept, flagged, spans, sections, panels, window, vox):
    """qc-plate-<n>.jpg: `panels` coronal sections per sheet, framed on the span the proposal covers; faces are drawn on the
    kept columns, the white centre across the span, and a red tick under it marks each column to trace."""
    centre, upper, lower = maps
    names = ('W', 'V', 'U')
    paths = []
    for n, chunk in enumerate(np.array_split(sections, -(-len(sections) // panels))):
        crops, curve_sets, titles = [], [], []
        x = np.arange(h.shape[2])
        for v in chunk:
            a, b = spans[int(v)]
            seg = slice(a, b + 1)
            w0, w1 = int(np.nanmin(upper[v, seg][kept[v, seg]])) - 30, int(np.nanmax(lower[v, seg][kept[v, seg]])) + 30
            crops.append((max(w0, 0), max(a - 20, 0), min(w1, h.shape[0]), min(b + 21, h.shape[2])))
            show = np.where(kept[v], 1.0, np.nan)
            inside = np.zeros(h.shape[2], bool)
            inside[seg] = True
            curve_sets.append([
                (x, upper[v] * show, 'orange'),
                (x, lower[v] * show, 'cyan'),
                (x, np.where(inside, centre[v], np.nan), 'white'),
                (x[flagged[v]], centre[v][flagged[v]] + 6, 'red', '|'),
            ])
            titles.append(f'V={v}, proposed U {a} to {b}')
        path = out / f'qc-plate-{n + 1}.jpg'
        vl.slice_sheet(path, h, [], 1, [int(v) for v in chunk], window, cols=3, crops=crops, curves=curve_sets, titles=titles,
                       axis_names=names, voxel_mm=vox)
        paths.append(str(path))
    return paths


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--spec', type=sidecar.existing, required=True, help=f"the workflow's protocol.json: the entry {SPEC_ID} gives the search and flag thresholds")
    ap.add_argument('--window', type=vl.window_arg, metavar='lo,hi', required=True, help="QC display window in HU, or the workflow's anatomy.json")
    ap.add_argument('--hu-aligned', type=sidecar.existing, required=True, help='tibia-hu.npy from tibia_frame.py')
    ap.add_argument('--mask', type=sidecar.existing, required=True, help='tibia-mask.npy from tibia_frame.py')
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--sections', metavar='V,V,...', help="V indices of the coronal sections to render (default: every proposed section)")
    a = ap.parse_args()
    sp = sidecar.protocol(a.spec, SPEC_ID, *SPEC_KEYS)
    side = sidecar.sidecar_path(a.hu_aligned)
    if not side.exists():
        sidecar.fail(f'{side} (the sidecar of tibia-hu.npy, which names its grid) is missing: pass the tibia-hu.npy tibia_frame.py wrote')
    grid = sidecar.grid(side)
    vox = grid['spacing_zyx_mm'][0]
    h = np.asarray(np.load(a.hu_aligned, mmap_mode='r'), np.float32)
    tib = np.load(a.mask).astype(bool)
    if tib.shape != h.shape or list(h.shape) != list(grid['shape']):
        sidecar.fail(f'tibia-hu.npy {h.shape} and tibia-mask.npy {tib.shape} must be one grid: pass the files tibia_frame.py wrote together')
    out = Path(a.out)
    centre, upper, lower, raw, ok, why = propose(h, tib, sp, vox)
    if not ok.any():
        sidecar.fail('the tibia mask has no columns deep enough for the search band: check the mask and the spec')
    spans, kept = covered(ok & ~raw, sp, vox)
    flagged = np.zeros_like(raw)  # the columns to trace: inside a span, not kept
    for v, (lo, hi) in spans.items():
        flagged[v, lo : hi + 1] = ~kept[v, lo : hi + 1]
    vs = np.flatnonzero(ok.any(1))
    step_v = max(1, round(sp['section_step_um'] / 1000 / vox))
    sections = [v for v in sorted(set(range(vs[0], vs[-1] + 1, step_v)) | {int(vs[-1])}) if v in spans]
    if len(sections) < 2:
        sidecar.fail('the search found the plate on fewer than two sections: trace the faces yourself, from sections you look at one by one')
    qc_v = sections
    if a.sections:
        qc_v = [int(x) for x in a.sections.split(',')]
        bad = [v for v in qc_v if v not in spans]
        if bad:
            sidecar.fail(f'--sections {bad[0]} has no proposal: name V indices from {sections}')
    step_u = max(1, round(sp['point_step_um'] / 1000 / vox))
    found = stretches(flagged, why, sections)
    ann = {'grid_id': grid['grid_id'],
           'growth_plate_curves': curves(upper, kept, sections, step_u),
           'growth_plate_distal_curves': curves(lower, kept, sections, step_u)}
    stopped = stopped_by(why, ok, {v: spans[v] for v in sections}, round(sp['bridge_um'] / 1000 / vox))
    cover = {'v': [sections[0], sections[-1]], 'sections': {str(v): {'u': list(spans[v]), 'stopped_by': stopped[str(v)]} for v in sections}}
    ann_path = out / 'plate-annotations.json'
    out.mkdir(parents=True, exist_ok=True)
    ann_path.write_text(json.dumps(ann) + '\n')
    load_annotations(ann_path, grid)  # the curves obey the schema every later script reads
    inputs = [a.hu_aligned, a.mask, a.spec]
    params = {'spec': sp}
    arrays = {'plate-centre.npy': np.where(ok, centre, np.nan).astype(np.float32), 'plate-flagged.npy': flagged}
    for name, arr in arrays.items():
        np.save(out / name, arr)
        sidecar.write(out / name, grid_id=grid['grid_id'], spacing_zyx_mm=grid['spacing_zyx_mm'], inputs=inputs, params=params, script='plate_faces.py')
    qc = qc_images(out, h, (centre, upper, lower), kept, flagged, spans, qc_v, sp['qc_panels'], a.window, vox)
    in_span = sum(hi - lo + 1 for lo, hi in spans.values())
    values = {
        'plate-flagged-fraction': sidecar.value(
            flagged.sum() / in_span, 'fraction', 'share of the columns inside the proposed spans that are to be traced: no curve points there', kind='diagnostic'),
        'plate-proposed-fraction': sidecar.value(
            kept.sum() / ok.sum(), 'fraction', 'share of the tibia\'s (V, U) columns with a search band that carry proposed curve points; past the spans the proposal says nothing', kind='diagnostic'),
        'plate-proposed-sections': sidecar.value(
            len(ann['growth_plate_curves']['slices']), 'count', f'coronal sections with a proposed curve, every {sp["section_step_um"]:g} um', kind='diagnostic'),
    }
    sidecar.emit_values(
        out / 'plate-faces.json',
        values,
        {'grid_id': grid['grid_id'], 'stretches': found, 'covered': cover},
        annotations=str(ann_path),
        centre=str(out / 'plate-centre.npy'),
        flagged=str(out / 'plate-flagged.npy'),
        stretches=found,
        covered=cover,
        qc=qc,
    )


if __name__ == '__main__':
    main()
