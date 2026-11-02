"""Propose the tibial growth plate's two faces in 3D from the densities, and flag where they cannot be trusted.

The plate is a thin sheet of lower density between denser bone, found as a valley of the smoothed HU along W (the
second derivative along W after a Gaussian) and followed by a dynamic-programming search over the whole aligned grid, once
along U and once along V. Each face is the half-depth edge of that valley. This is a proposal, never a trace: it follows
the plate well where the plate exists and is wrong in two known ways, so you look at it section by section, keep what sits
on the plate and retrace the rest. It jumps up into dark epiphyseal marrow spaces, and where the plate is eroded it still
draws a convincing sheet on the wrong structure. A column is flagged when the two searches disagree, the centre changes
height faster than a plate can along U or V, the centre is more than `flag_min_dip_hu` brighter than its shallower shoulder (a plate is darker than the bone beside it), or a face
lies farther than `face_reach_um` from the centre (every threshold is in the spec, entry `plate-faces`). Flags test what the
script delivers: the centre and both faces. A flagged stretch gets no curve points, and `iioc.py` and `metaphysis_roi.py`
refuse it until you trace it: your points inside it, from its first to its last column, at most `max_gap_um` apart. Where the plate
is eroded the trace follows the remaining bone and you also mark the stretch eroded, with a reason.

`plate-annotations.json` is JSON in the annotations schema: "grid_id", `growth_plate_curves` (annotation A, for iioc.py) and
`growth_plate_distal_curves` (annotation C, for metaphysis_roi.py), one curve per proposed section, many points each, none in a
flagged stretch. Copy both keys into your annotations.json. The flagged stretches are in `plate-faces.json` (`stretches`:
{"<V>": [{"u": [first U, last U], "why": [tests that fired]}]}); `iioc.py` and `metaphysis_roi.py` read them from there
(`--plate-faces <out>`), never from your annotations, and stop naming the section and U range of any you leave untraced:
  - trace every flagged stretch: add your points to the section's curve in both curve keys, from the stretch's first to its last
    column, at most `max_gap_um` apart (a stretch inside a curve is bridged by a straight line between its neighbouring points,
    so a gap is wrong geometry, not a hole);
  - where the plate is destroyed, the points follow the remaining bone, and you also list the stretch in your annotations as
    `plate_eroded`: {"<V>": [{"u": [first U, last U], "eroded": "<why>"}]}, the section and U range exactly as `stretches` has them.
    The mark never replaces the points. `metaphysis_roi.py` then accepts the distal face at or above the proximal one there, and
    both scripts report the eroded stretches and their share of the plate. If the faces cross onto a neighbouring section,
    trace that section's remaining bone so they meet there too; a mark names only flagged stretches.
Retrace any stretch that sits off the plate even if it is not flagged. Edit the curves, not the surface, so what the later
scripts cut is what you traced.

Writes: in <out>, on the aligned grid (array axes W,V,U), each .npy with its sidecar:
  plate-centre.npy  W index of the plate's centre per (V,U), float32, NaN where the tibia has no search band
  plate-flagged.npy  2D bool per (V,U): where the centre is not to be trusted
  plate-annotations.json  the proposed curves (annotation A and C), with no points in flagged stretches
  plate-faces.json  the result record: counts and the flagged stretches (`stretches`) and the grid_id
  qc-plate-<n>.jpg  coronal sections framed on the plate, every proposed section unless --sections names others: orange proximal
                    face, cyan distal face, white centre; a red tick under each flagged column of the centre, where the faces have no line
Prints: the result record {out, values, annotations, centre, flagged, stretches, qc (the images)}
Example: python plate_faces.py --spec protocol.json --window anatomy.json --hu-aligned tibia-hu.npy --mask tibia-mask.npy --out plate/
Exits 2 with one sentence on bad input, before writing anything.
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
    'dip_smooth_um', 'median_um', 'flag_disagree_um', 'flag_slope', 'flag_min_dip_hu', 'flag_pad_um', 'flag_min_area_um2',
    'section_step_um', 'point_step_um', 'qc_panels',
)
OUTSIDE = 1e4  # DP cost outside the search band: larger than any path through it


def dp_height_field(cost, axis, max_step, penalty):
    """Min-cost W per (V, U): a path through cost (W,V,U) along `axis` (1 = V, 2 = U) that moves at most max_step in W per column,
    each unit of move costing `penalty`; every other column is searched at once."""
    c = np.moveaxis(cost, axis, 1)  # (W, N, other)
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
    return path.T.astype(np.float32) if axis == 2 else path.astype(np.float32)


def centre_passes(h, tib, sp, vox):
    """The centre by the two searches (along U, along V) and where the tibia has a search band: the valley is the voxels
    where the smoothed second derivative along W is positive and the smoothed HU inside the plate window. The cost is that
    second derivative in HU/um^2, the step penalty is per um of height change."""
    vox_um = vox * 1000
    sigma = [s / vox_um for s in sp['smooth_sigma_um']]
    d2 = ndi.gaussian_filter(h, sigma, order=(2, 0, 0), mode='nearest') / vox_um**2
    smooth = ndi.gaussian_filter(h, sigma, mode='nearest')
    first = np.where(tib.any(0), tib.argmax(0), -1)  # the articular surface: first tibia voxel along W
    w = np.arange(h.shape[0])[:, None, None]
    start, end = (first + round(sp[k] / vox_um) for k in ('search_start_um', 'search_end_um'))
    band = tib & (first[None] >= 0) & (w >= start[None]) & (w <= end[None])
    valley = band & (d2 > 0) & (smooth > sp['valley_hu'][0]) & (smooth < sp['valley_hu'][1])
    cost = np.where(valley, -d2, np.where(band, 0, OUTSIDE)).astype(np.float32)
    passes = [dp_height_field(cost, axis, round(sp['dp_max_slope']), sp['dp_step_penalty_per_um'] * vox_um) for axis in (2, 1)]
    return passes, band.any(0)


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


def flag_columns(cu, cv, centre, dip, far, ok, sp, vox, med):
    """Per (V, U): where the proposal is not to be trusted, and which tests fired. Flags: the passes disagree, the centre is
    steeper than a plate along U or V, it is denser than its shallower shoulder (dip below `flag_min_dip_hu`), or a face is far from it. Blobs of flags are joined by a closing of `flag_pad_um`, specks dropped."""
    why = {
        'passes disagree': ndi.median_filter(np.abs(cu - cv), size=med, mode='nearest') > sp['flag_disagree_um'] / 1000 / vox,
        'steeper than a plate': slope(centre, med // 2 + 1) > sp['flag_slope'],
        'centre denser than its shoulder': dip < sp['flag_min_dip_hu'],
        'face far from the centre': far,
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
    (cu, cv), ok = centre_passes(h, tib, sp, vox)
    med = round(sp['median_um'] / 1000 / vox) | 1
    centre = ndi.median_filter(((cu + cv) / 2).astype(np.float32), size=med, mode='nearest')  # the two searches averaged; the median drops their wiggles
    s = ndi.gaussian_filter(h, [x / 1000 / vox for x in sp['dip_smooth_um']], mode='nearest')
    upper, lower, dip, far = faces_dip_far(s, centre, round(sp['face_reach_um'] / 1000 / vox))
    flagged, why = flag_columns(cu, cv, centre, dip, far, ok, sp, vox, med)
    # the faces are median-smoothed and kept a voxel either side of the centre
    upper, lower = (ndi.median_filter(f.astype(np.float32), size=med, mode='nearest') for f in (upper, lower))
    return centre, np.minimum(upper, centre - 1), np.maximum(lower, centre + 1), flagged, ok, why


def curves(face, ok, flagged, sections, step_u):
    """Annotation curves of `face` (W per V,U) on `sections`, every `step_u` columns, with no point where the column is flagged
    or has no band. A section with fewer than two points is left out."""
    slices = {}
    for v in sections:
        us = np.flatnonzero(ok[v] & ~flagged[v])
        us = us[us % step_u == 0]
        if len(us) >= 2:
            slices[str(v)] = [[round(float(face[v, u]), 1), int(u)] for u in us]
    return {'axis': 1, 'height': 'row', 'slices': slices}


def stretches(flagged, why, sections):
    """The flagged runs of U on each proposed section, as `plate-faces.json` lists them:
    {"<V>": [{"u": [first, last], "why": [tests that fired]}]}."""
    found = {}
    for v in sections:
        runs, n = ndi.label(flagged[v])
        spans = [np.flatnonzero(runs == i)[[0, -1]] for i in range(1, n + 1)]
        if spans:
            found[str(v)] = [{'u': [int(a), int(b)], 'why': [r for r, m in why.items() if m[v, a : b + 1].any()] or ['next to a flagged column']}
                             for a, b in spans]
    return found


def qc_images(out, h, maps, flagged, ok, sections, panels, window, vox):
    """qc-plate-<n>.jpg: `panels` coronal sections per sheet, framed on the plate and the proposed faces; a line breaks where
    the column is flagged, and a red tick under the centre marks it."""
    centre, upper, lower = maps
    names = ('W', 'V', 'U')
    paths = []
    for n, chunk in enumerate(np.array_split(sections, -(-len(sections) // panels))):
        crops, curve_sets = [], []
        for v in chunk:
            us = np.flatnonzero(ok[v])
            u0, u1 = us[0], us[-1] + 1
            w0, w1 = int(np.nanmin(upper[v, u0:u1])) - 30, int(np.nanmax(lower[v, u0:u1])) + 30
            crops.append((max(w0, 0), u0, min(w1, h.shape[0]), u1))
            show = np.where(flagged[v] | ~ok[v], np.nan, 1.0)
            x = np.arange(h.shape[2])
            curve_sets.append([
                (x, upper[v] * show, 'orange'),
                (x, lower[v] * show, 'cyan'),
                (x, np.where(ok[v], centre[v], np.nan), 'white'),
                (x[flagged[v]], centre[v][flagged[v]] + 6, 'red', '|'),
            ])
        titles = [f'V={v}: orange proximal, cyan distal, white centre; red tick = flagged: trace it densely (on the remaining bone, marked eroded, where the plate is gone)' for v in chunk]
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
    centre, upper, lower, flagged, ok, why = propose(h, tib, sp, vox)
    if not ok.any():
        sidecar.fail('the tibia mask has no columns deep enough for the search band: check the mask and the spec')
    vs = np.flatnonzero(ok.any(1))
    step_v = max(1, round(sp['section_step_um'] / 1000 / vox))
    sections = [v for v in sorted(set(range(vs[0], vs[-1] + 1, step_v)) | {int(vs[-1])}) if ok[v].any()]
    qc_v = sections
    if a.sections:
        qc_v = [int(x) for x in a.sections.split(',')]
        bad = [v for v in qc_v if not (0 <= v < h.shape[1] and ok[v].any())]
        if bad:
            sidecar.fail(f'--sections {bad[0]} has no tibia search band: name V indices between {vs[0]} and {vs[-1]} where the tibia is cut')
    step_u = max(1, round(sp['point_step_um'] / 1000 / vox))
    found = stretches(flagged, why, sections)
    ann = {'grid_id': grid['grid_id'],
           'growth_plate_curves': curves(upper, ok, flagged, sections, step_u),
           'growth_plate_distal_curves': curves(lower, ok, flagged, sections, step_u)}
    if len(ann['growth_plate_curves']['slices']) < 2:
        sidecar.fail('fewer than two sections have an unflagged stretch to propose: trace the faces yourself')
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
    qc = qc_images(out, h, (centre, upper, lower), flagged, ok, qc_v, sp['qc_panels'], a.window, vox)
    values = {
        'plate-flagged-fraction': sidecar.value(
            flagged.sum() / ok.sum(), 'fraction', 'share of the tibia\'s (V, U) columns with a search band where the proposed plate is flagged and has no curve points', kind='diagnostic'),
        'plate-proposed-sections': sidecar.value(
            len(ann['growth_plate_curves']['slices']), 'count', f'coronal sections with a proposed curve, every {sp["section_step_um"]:g} um', kind='diagnostic'),
    }
    sidecar.emit_values(
        out / 'plate-faces.json',
        values,
        {'grid_id': grid['grid_id'], 'stretches': found},
        annotations=str(ann_path),
        centre=str(out / 'plate-centre.npy'),
        flagged=str(out / 'plate-flagged.npy'),
        stretches=found,
        qc=qc,
    )


if __name__ == '__main__':
    main()
