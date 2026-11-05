"""Cut the tibial metaphyseal regions under the growth plate: ROI-3 (deck #16-23) and the cortex for Ct.Th.

The growth plate's distal face is the reference surface (one face for the whole run: `cortical` reads this script's output,
it does not trace its own), and it must be traced (`growth_plate_distal_curves`): ROI-3 starts `start_um` below it, and
there is no thickness fallback. A curve point more than `off_tibia_margin_um` (spec, entry plate-faces) off the tibia mask is warned on,
naming the section, and so is a face with a gap over the plate (on a section, two points more than `max_gap_um` of the spec apart where the tibia lies within that below the line between them and anywhere above it; in V, two sections more than that apart over the rows with tibia within that of the face; where the face ends is not tested),
and so is a face that jumps between neighbouring traced sections (a median W change, over the U columns both cover on the tibia's footprint
when they share at least `jump_overlap_um`, of more than `max_jump_um` plus the sections' distance apart). The bone threshold (default: the lab's 2.16/cm in this scan's HU, from hu.json's calibration)
is used here only to estimate the cortex and to build the cortex mask; no label gates it.
ROI-3 is the slab between `start_um` and `start_um + length_um` below that face (measured along W), inside the filled tibial
cross-section, at least `cortex + cortex_clearance_um` from its outer edge. Those, and `cortex_search_factor`, come from the spec
(--spec, protocol.json, the entry `roi-metaphyseal`). The cortex thickness used for that edge is --cortex-mm, else the
depth at which the bone fraction of the outer layers first drops below one half (reported as cortex_estimate_mm), estimated on
the axial slices `start_um` to `start_um + length_um` below the face's deepest point (recorded as cortex_estimate_slices_w and
distal_face_deepest_vuw): ROI-3's own depths at that point, on slices wholly below
the plate, where the outer layers are the wall alone. On the slices ROI-3 spans, a domed plate slopes down the wall and the dense
bone under its face would count as wall, so an estimate made there would be too deep. The cortex mask for Ct.Th is the
bone within `cortex_search_factor` times that depth of the outer edge, below the local distal face and down to 1.3 mm past its
deepest point along W (rounded up to an inclusive slice, clipped to the stack): it can include trabeculae that join the cortex.
It writes regions only: TV, BV and BV/TV of ROI-3 (deck #16-18) and Tb.N/Th/Sp, nodes/ends (deck #19-23) are
`morphometry.py trabecular --output roi-metaphyseal` on roi3-tissue.npy, and Ct.Th is `morphometry.py cortical` on cortex.npy with the distal face as --surface.

--annotations is a JSON file of indices on the aligned grid. It needs "grid_id" (the grid_id of tibia-frame.json; a file without it
or from another grid is refused). This script reads these keys; any other unknown key is refused, and so is a value of the wrong form or an index outside the grid:
  growth_plate_distal_curves  required: the distal face of the growth-plate band (the side facing the shaft), curves (below),
                              traced on the coronal sections of tibia-hu.npy
  plate_eroded                optional: {"<V>": [{"u": [first, last], "eroded": "<why>"}]}, where the plate is gone: any section
                              of the curve, any U range (integers, first <= last). It never replaces points: the section's distal curve
                              must reach both ends of every marked range, or the script warns, naming the section and U range;
                              inside a marked range its points follow the remaining bone
Curves (every traced surface): {"axis": 1, "height": "row", "slices": {"<v>": [[w, u], ...]}}: the coronal section at
V = <v> (array axis 1 of the aligned grid), each point [row, column] = [W, U] read off that section's pixel grid ("height"
is "row" or omitted). A surface is linear in U along a curve (points in any order, constant past the ends) and linear in
V between traced sections (constant past the first and last). A point is [w, u], not [u, w]. At least two sections;
anything but axis 1 and height row is refused.

The script stops when the distal trace does not cover the V range of the proximal one (`--proximal-valid`, from iioc.py,
marks where its proximal face was traced), or when the distal face lies at or above the proximal face (`--proximal-face`)
inside the tibia: the band between them cannot be thinner than nothing. Where both faces are traced that means a point is
wrong; where either is held constant past its curves' ends it means the curves must reach further, and the message says
which face and sections. It also stops on an empty ROI-3, and when the stack holds no tibia `start_um` to
`start_um + length_um` below the distal face's deepest point, the slices the cortex is estimated on.

Eroded ranges. Inside a range marked eroded (on both sections either side of a row along V) the faces may meet or cross: the
check above does not apply, because the plate there is gone and both curves follow the remaining bone. ROI-3 is cut as everywhere
else, `start_um` below the traced distal face, so in an eroded stretch it lies below the remaining bone, not below a plate. The
eroded stretches and the fraction of the tibia's footprint they cover are in the result record (`eroded_stretches`,
`plate-eroded-fraction`): report them, they say how much of ROI-3 is not measured from a plate.

Writes: <out>/roi3-tissue.npy  ROI-3, bool, on the aligned grid, with its sidecar
        <out>/cortex.npy  the cortex mask for Ct.Th, bool, with its sidecar
        <out>/growth-plate-distal-face.npy  W index of the distal face per (V,U), float32, NaN off the tibia's footprint, with its sidecar (a surface object)
        <out>/roi-metaphyseal.npy, cortex-object.npy  the same two masks cropped to their bounding boxes, uint8 (the mask objects)
        <out>/roi3.json  the result record: the parameters used and the cortex estimate (cortex_estimate_mm, cortex_mm_used, cortex_estimate_slices_w, distal_face_deepest_vuw, threshold);
                         `objects` holds roi-metaphyseal, cortex and growth-plate-distal-face
        <out>/qc-roi3.jpg, qc-roi3-axial.jpg  coronal and axial sections: ROI-3 cyan, cortex orange (coronal: the distal face magenta)
        <out>/qc-faces-<n>.jpg  the distal face (magenta) and the proximal one (orange) as delivered, the surfaces this script cut with, on every traced
                         section: the sheets to open every one of
Prints: one JSON line {out, values, objects, qc (the QC images), roi3_tissue, cortex, distal_face, cortex_estimate_mm, roi3_voxels, eroded_stretches}
Example: python metaphysis_roi.py --spec protocol.json --window scan-settings.json --hu-aligned tibia-hu.npy --mask tibia-mask.npy --hu-json hu.json --annotations annotations.json --proximal-face iioc/growth-plate-proximal-face.npy --proximal-valid iioc/growth-plate-proximal-valid.npy --out roi3/
Exits 2 with one sentence on bad input, before writing anything.
"""

from pathlib import Path

import numpy as np
import objects
import sidecar
import viewlib as vl
from annotations import (
    check_gaps,
    check_jumps,
    check_off_tibia,
    eroded_marks,
    load_annotations,
    need,
    traced_surface,
    warn_on,
)
from envelope import close_and_fill, footprint
from face_qc import delivered_faces
from scipy import ndimage as ndi

ROI_ID = 'roi-metaphyseal'  # the spec entry this script reads
CORTEX_SPAN_MM = 1.3  # shaft length past the deepest distal-face point along W: Ct.Th is asked at up to 1 mm


def check_below_proximal(gd, dv, dlo, dhi, prox, pv, tib, vox, eroded):
    """Stop when the distal face is not below the proximal one, inside the tibia over the V range both faces cover, except where `eroded`.

    `dv` and `pv` say where each face comes from traced points; elsewhere it is the nearest trace held constant. A crossing
    between two traced points is a wrong point (retrace lower or higher). A crossing where either face is held constant is
    an unknown, and the cortex mask and Ct.Th read exactly there (the tibia's outer edge), so the message names the face
    and the sections to extend.
    """
    prows = np.flatnonzero(pv.any(axis=1))
    plo, phi = int(prows[0]), int(prows[-1])
    if dlo > plo or dhi < phi:
        sidecar.fail(f'the distal face is traced on sections V={dlo}..{dhi} but the proximal face on V={plo}..{phi}, so the distal '
                     'face is not known over the whole proximal one: '
                     + ' and '.join(f'trace the distal face on a section near V={v} too'
                                    for v, miss in ((plo, dlo > plo), (phi, dhi < phi)) if miss))
    on_bone = footprint(tib)
    vs = np.arange(gd.shape[0])[:, None]
    cross = (gd <= prox) & on_bone & ~eroded & (vs >= max(plo, dlo)) & (vs <= min(phi, dhi))
    bad = cross & pv & dv
    if bad.any():
        vi, ui = np.nonzero(bad)
        sidecar.fail(f'the traced distal face lies at or above the proximal face at {int(bad.sum())} traced (V, U) positions, '
                     f'V={vi.min()}..{vi.max()}, U={ui.min()}..{ui.max()} (worst {float((prox - gd)[bad].max()) * vox * 1000:.0f} um): '
                     'retrace the distal face lower, or the proximal face higher, on sections in that V range; where the plate is gone there, '
                     'mark the U range where the plate is gone in "plate_eroded" (on the traced sections either side, flagged or not) and trace the remaining bone there')
    needs = []
    for name, known in (('distal', dv), ('proximal', pv)):
        held = cross & ~known
        if held.any():
            vi, ui = np.nonzero(held)
            where = f'sections V={vi.min()}..{vi.max()} to U={ui.min()}..{ui.max()}'
            needs.append(f'extend the distal curves on {where}' if name == 'distal'
                         else f'extend the proximal curves on {where} (they are traced for iioc.py: rerun it, then this script)')
    if needs:
        sidecar.fail('the distal face is at or above the proximal face inside the tibia where a face is extrapolated past the end '
                     f'of its curves ({int(cross.sum())} (V, U) positions, worst {float((prox - gd)[cross].max()) * vox * 1000:.0f} um): '
                     + ' and '.join(needs) + ' so that both are traced across the tibia')


def edge_distance(filled, w0, w1):
    """In-plane distance (voxels) of each voxel of the filled cross-section to its outer edge, for slices w0..w1."""
    d = np.zeros(filled.shape, np.float32)
    for w in range(w0, w1):
        d[w] = ndi.distance_transform_edt(filled[w])
    return d


def cortex_depth(bone, dist, max_layers=40):
    """Depth in voxels where the bone fraction of the outer layers first falls below one half, over the slices given: `dist` is the
    in-plane distance to the outer edge, 0 outside the filled cross-section."""
    for k in range(max_layers):
        layer = (dist > k) & (dist <= k + 1)
        if layer.any() and bone[layer].mean() < 0.5:
            return float(k)
    return float(max_layers)


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--spec', type=sidecar.existing, required=True, help="the workflow's protocol.json: the entry roi-metaphyseal gives the slab's start, length and clearance")
    ap.add_argument('--window', type=vl.window_arg, metavar='lo,hi', required=True, help="QC display window in HU, or the scan's scan-settings.json")
    ap.add_argument('--hu-aligned', type=sidecar.existing, required=True, help='tibia-hu.npy from tibia_frame.py')
    ap.add_argument('--mask', type=sidecar.existing, required=True, help='tibia-mask.npy from tibia_frame.py')
    ap.add_argument('--hu-json', type=sidecar.existing, required=True, help='hu.json of the scan: the lab threshold in HU comes from its calibration')
    ap.add_argument('--annotations', type=sidecar.existing, required=True, help='annotations JSON on the aligned grid, described above')
    ap.add_argument('--proximal-face', type=sidecar.existing, required=True, help='growth-plate-proximal-face.npy from iioc.py: the distal face must lie below it')
    ap.add_argument('--proximal-valid', type=sidecar.existing, required=True, help='growth-plate-proximal-valid.npy from iioc.py: where the proximal face was traced')
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--threshold', type=float, help='bone threshold in HU (default: the lab threshold, 2.16/cm, from --hu-json)')
    ap.add_argument('--cortex-mm', type=float, help='mm: cortex thickness for the clearance (default: estimated)')
    a = ap.parse_args()
    p = sidecar.protocol(a.spec, ROI_ID, 'start_um', 'length_um', 'cortex_clearance_um', 'cortex_search_factor')
    g = sidecar.grid(sidecar.sidecar_path(a.mask))
    ann = load_annotations(a.annotations, g)
    vox = g['spacing_zyx_mm'][0]
    h = np.load(a.hu_aligned, mmap_mode='r')
    tib = np.load(a.mask)
    a.threshold = sidecar.bone_threshold_hu(a.hu_json, a.threshold)
    gd_spec = need(
        ann,
        'growth_plate_distal_curves',
        'trace the distal face of the growth-plate band on coronal sections of tibia-hu.npy (the side facing the shaft, '
        'like the proximal face in section A) and run again',
    )
    gd, dv = traced_surface(gd_spec, 'growth_plate_distal_curves', h.shape)
    gd = gd.astype(np.float32)
    prox = np.load(a.proximal_face)
    if prox.shape != gd.shape:
        sidecar.fail(f'--proximal-face is {prox.shape} but the distal face is {gd.shape}: pass the face of the same tibia frame')
    dlo, dhi = (f(int(k) for k in gd_spec['slices']) for f in (min, max))
    warn_on(check_off_tibia(ann, 'growth_plate_distal_curves', tib, a.spec, vox))
    warn_on(check_gaps(ann, 'growth_plate_distal_curves', tib, a.spec, vox))
    on_bone = footprint(tib)
    warn_on(check_jumps(ann, 'growth_plate_distal_curves', on_bone, a.spec, vox))
    eroded, plate = eroded_marks(ann, 'growth_plate_distal_curves', h.shape, on_bone)
    check_below_proximal(gd, dv, dlo, dhi, prox, np.load(a.proximal_valid), tib, vox, eroded)
    w = np.arange(h.shape[0])[:, None, None]
    rel = (w - gd[None]) * vox * 1000  # um below the distal face
    w0 = max(int(np.floor(gd.min())), 0)
    # the cortex is estimated at the slab's depths below the face's deepest point, on slices that hold no plate
    c0, c1 = (int(np.ceil(gd.max() + d / 1000 / vox)) for d in (p['start_um'], p['start_um'] + p['length_um']))
    w1 = min(max(int(np.ceil(gd.max() + CORTEX_SPAN_MM / vox)) + 1, c1), h.shape[0])
    filled = np.zeros(h.shape, bool)
    for k in range(w0, w1):
        filled[k] = close_and_fill(tib[k], vox)
    dist = edge_distance(filled, w0, w1)
    bone_all = np.asarray(h) > a.threshold  # HU alone; `filled` (from the tibia label) only limits where it is looked at
    slab = (rel >= p['start_um']) & (rel < p['start_um'] + p['length_um'])
    v, u = (int(i) for i in np.unravel_index(np.argmax(gd), gd.shape))
    if not filled[c0:c1].any():
        sidecar.fail(f'the distal face reaches W={gd.max():.0f} at V={v}, U={u}, and the stack ({h.shape[0]} slices) holds no tibia '
                     f'{p["start_um"]:g} to {p["start_um"] + p["length_um"]:g} um below that to estimate the cortex on: check the distal curves there, or, if they are right, rebuild tibia_frame.py\'s crop to reach further down the shaft')
    est = cortex_depth(bone_all[c0:c1], dist[c0:c1]) * vox
    cortex_mm = a.cortex_mm if a.cortex_mm is not None else est
    edge = (cortex_mm + p['cortex_clearance_um'] / 1000) / vox
    roi = slab & filled & (dist > edge)
    if not roi.any():
        sidecar.fail('ROI-3 is empty: check the growth-plate surfaces, or lower --cortex-mm')
    below = (rel >= 0) & (w < w1)
    cortex = bone_all & below & filled & (dist <= cortex_mm * p['cortex_search_factor'] / vox)
    meta = {'distal_face': 'traced distal curves', 'cortex_estimate_mm': est, 'cortex_mm_used': cortex_mm,
            'cortex_estimate_slices_w': [c0, min(c1, h.shape[0])], 'distal_face_deepest_vuw': [v, u, round(float(gd.max()), 1)], 'threshold': a.threshold}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    inputs = [a.hu_aligned, a.mask, a.annotations, a.proximal_face, a.proximal_valid, a.spec]
    params = dict(meta, **{k: p[k] for k in ('start_um', 'length_um', 'cortex_clearance_um', 'cortex_search_factor')})
    for name, arr in (('roi3-tissue.npy', roi), ('cortex.npy', cortex)):
        np.save(out / name, arr)
        sidecar.write(out / name, like=g, inputs=inputs, params=params)
    like = sidecar.sidecar_path(a.mask)
    meta = {'inputs': inputs, 'params': params}
    placed = {
        'roi-metaphyseal': objects.mask(out / 'roi-metaphyseal.npy', roi, like=like, **meta),
        'cortex': objects.mask(out / 'cortex-object.npy', cortex, like=like, **meta),
        'growth-plate-distal-face': objects.surface(out / 'growth-plate-distal-face.npy', gd, 0, like=like, where=on_bone, **meta),  # heights along W
    }
    window = a.window
    overlays = [(roi, 'cyan'), (cortex, 'orange')]
    vs = [int(v) for v in np.linspace(*np.flatnonzero(roi.any(axis=(0, 2)))[[0, -1]], 4)]
    wm = int(np.median(np.argwhere(roi)[:, 0]))
    ws = [wm - 8, wm, wm + 8, wm + 30]
    qc = [
        vl.slice_sheet(out / 'qc-roi3.jpg', h, overlays, 1, vs, window, cols=2, axis_names=('W', 'V', 'U'), voxel_mm=vox,
                       curves=[[(np.arange(h.shape[2]), gd[v], 'magenta')] for v in vs],
                       titles=[f'V={v}: ROI-3 cyan, cortex orange, distal face magenta' for v in vs]),
        vl.slice_sheet(out / 'qc-roi3-axial.jpg', h, overlays, 0, ws, window, cols=2, axis_names=('W', 'V', 'U'), voxel_mm=vox,
                       titles=[f'axial W={k}: ROI-3 cyan, cortex orange' for k in ws]),
    ]
    qc += delivered_faces(out, h, tib, [('distal face', 'magenta', gd, dv), ('proximal face', 'orange', prox, np.load(a.proximal_valid))],
                          [int(k) for k in gd_spec['slices']], sidecar.protocol(a.spec, 'plate-faces', 'qc_panels')['qc_panels'], window, vox)
    values = {'plate-eroded-fraction': sidecar.value(
        plate['eroded_fraction'], 'fraction', 'share of the tibia\'s (V, U) footprint, over the V range of the traced distal face, that the worker marked eroded in plate_eroded: '
        'ROI-3 there starts below the remaining bone, not below a plate', kind='diagnostic')}
    sidecar.emit_values(
        out / 'roi3.json',
        values,
        dict(params, eroded_stretches=plate['eroded_stretches']),
        objects=placed,
        eroded_stretches=plate['eroded_stretches'],
        qc=qc,
        roi3_tissue=str(out / 'roi3-tissue.npy'),
        cortex=str(out / 'cortex.npy'),
        distal_face=str(out / 'growth-plate-distal-face.npy'),
        cortex_estimate_mm=round(est, 4),
        roi3_voxels=int(roi.sum()),
    )


if __name__ == '__main__':
    main()
