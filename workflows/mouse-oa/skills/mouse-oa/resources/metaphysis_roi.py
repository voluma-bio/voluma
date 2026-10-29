"""Cut the tibial metaphyseal regions under the growth plate: ROI-3 (deck #16-23) and the cortex for Ct.Th.

The growth plate's distal face is the reference surface (one face for the whole run: `cortical` reads this script's output,
it does not trace its own), and it must be traced (`growth_plate_distal_curves`): ROI-3 starts `--start-um` below it, and
there is no thickness fallback. The bone threshold (default: the lab's 2.16/cm in this scan's HU, from hu.json's calibration)
is used here only to estimate the cortex and to build the cortex mask; no label gates it.
ROI-3 is the slab between `--start-um` and `--start-um` + `--length-um` below that face (measured along W), inside the filled tibial
cross-section, at least `cortex + clearance` from its outer edge. The cortex thickness used for that edge is the
depth at which the bone fraction of the outer layers first drops below one half (estimated in the ROI-3 slices,
reported as cortex_estimate_mm), or --cortex-mm. The cortex mask for Ct.Th is the bone within `--cortex-search-factor` times
that depth of the outer edge, over 1.3 mm of shaft below the plate: it can include trabeculae that join the cortex.
It writes regions only: TV, BV and BV/TV of ROI-3 (deck #16-18) and Tb.N/Th/Sp, nodes/ends (deck #19-23) are
`morphometry.py trabecular` on roi3-tissue.npy, and Ct.Th is `morphometry.py cortical` on cortex.npy with the distal face as --surface.

--annotations is a JSON file of indices on the aligned grid. It needs "grid_id" (the grid_id of tibia-frame.json; a file without it
or from another grid is refused). This script reads one key; any other key is refused, and so is a value of the wrong form or an index outside the grid:
  growth_plate_distal_curves  required: the distal face of the growth-plate band (the side facing the shaft), curves (below),
                              traced on the coronal sections of tibia-hu.npy
Curves (every traced surface): {"axis": 1, "height": "row", "slices": {"<v>": [[w, u], ...]}}: the coronal section at
V = <v> (array axis 1 of the aligned grid), each point [row, column] = [W, U] read off that section's pixel grid ("height"
is "row" or omitted). A surface is linear in U along a curve (points in any order, constant past the ends) and linear in
V between traced sections (constant past the first and last). A point is [w, u], not [u, w]. At least two sections;
anything but axis 1 and height row is refused.

The script stops when the distal trace does not cover the V range of the proximal one (`--proximal-valid`, from iioc.py,
marks where its proximal face was traced), or when the distal face lies at or above the proximal face (`--proximal-face`)
inside the tibia: the band between them cannot be thinner than nothing. Where both faces are traced that means a point is
wrong; where either is held constant past its curves' ends it means the curves must reach further, and the message says
which face and sections. It also stops on an empty ROI-3.

Writes: <out>/roi3-tissue.npy  ROI-3, bool, on the aligned grid, with its sidecar
        <out>/cortex.npy  the cortex mask for Ct.Th, bool, with its sidecar
        <out>/growth-plate-distal-face.npy  W index of the distal face per (V,U), float32, with its sidecar (a surface object)
        <out>/roi-metaphyseal.npy, cortex-object.npy  the same two masks cropped to their bounding boxes, uint8 (the mask objects)
        <out>/roi3.json  the result record: the parameters used and the cortex estimate (cortex_estimate_mm, cortex_mm_used, threshold);
                         `objects` holds roi-metaphyseal, cortex and growth-plate-distal-face
        <out>/qc-roi3.jpg  coronal and axial sections: ROI-3 cyan, cortex orange
Prints: one JSON line {out, values, objects, qc, roi3_tissue, cortex, distal_face, cortex_estimate_mm, roi3_voxels}
Example: python metaphysis_roi.py --hu-aligned tibia-hu.npy --mask tibia-mask.npy --hu-json hu.json --annotations annotations.json --proximal-face iioc/growth-plate-proximal-face.npy --proximal-valid iioc/growth-plate-proximal-valid.npy --out roi3/
Exits 2 with one sentence on bad input, before writing anything.
"""

from pathlib import Path

import matplotlib
import numpy as np
import objects
import sidecar
from annotations import load_annotations, need, traced_surface
from envelope import close_and_fill
from scipy import ndimage as ndi

matplotlib.use('Agg')
import matplotlib.pyplot as plt

CORTEX_SPAN_MM = 1.3  # shaft length below the plate the cortex mask covers: Ct.Th is asked at up to 1 mm


def check_below_proximal(gd, dv, dlo, dhi, prox, pv, tib, vox):
    """Stop when the distal face is not below the proximal one, inside the tibia over the V range both faces cover.

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
    footprint = ndi.binary_fill_holes(tib.any(axis=0))
    vs = np.arange(gd.shape[0])[:, None]
    cross = (gd <= prox) & footprint & (vs >= max(plo, dlo)) & (vs <= min(phi, dhi))
    bad = cross & pv & dv
    if bad.any():
        vi, ui = np.nonzero(bad)
        sidecar.fail(f'the traced distal face lies at or above the proximal face at {int(bad.sum())} traced (V, U) positions, '
                     f'V={vi.min()}..{vi.max()}, U={ui.min()}..{ui.max()} (worst {float((prox - gd)[bad].max()) * vox * 1000:.0f} um): '
                     'retrace the distal face lower, or the proximal face higher, on sections in that V range')
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


def cortex_depth(bone, dist, roi_slices, max_layers=40):
    """Depth in voxels where the bone fraction of the outer layers first falls below one half."""
    sel = np.zeros(bone.shape, bool)
    sel[roi_slices] = True
    for k in range(max_layers):
        layer = sel & (dist > k) & (dist <= k + 1)
        if layer.any() and bone[layer].mean() < 0.5:
            return float(k)
    return float(max_layers)


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--hu-aligned', type=sidecar.existing, required=True, help='tibia-hu.npy from tibia_frame.py')
    ap.add_argument('--mask', type=sidecar.existing, required=True, help='tibia-mask.npy from tibia_frame.py')
    ap.add_argument('--hu-json', type=sidecar.existing, required=True, help='hu.json of the scan: the lab threshold in HU comes from its calibration')
    ap.add_argument('--annotations', type=sidecar.existing, required=True, help='annotations JSON on the aligned grid, described above')
    ap.add_argument('--proximal-face', type=sidecar.existing, required=True, help='growth-plate-proximal-face.npy from iioc.py: the distal face must lie below it')
    ap.add_argument('--proximal-valid', type=sidecar.existing, required=True, help='growth-plate-proximal-valid.npy from iioc.py: where the proximal face was traced')
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--threshold', type=float, help='bone threshold in HU (default: the lab threshold, 2.16/cm, from --hu-json)')
    ap.add_argument('--start-um', type=float, default=50.0, help='um: ROI-3 starts this far below the distal growth-plate face')
    ap.add_argument('--length-um', type=float, default=200.0, help='um: ROI-3 length along the shaft')
    ap.add_argument('--cortex-clearance-um', type=float, default=20.0, help='um: ROI-3 stays this far beyond the cortex from the outer edge')
    ap.add_argument('--cortex-mm', type=float, help='mm: cortex thickness for the clearance (default: estimated)')
    ap.add_argument('--cortex-search-factor', type=float, default=2.0, help='the cortex mask reaches this multiple of the cortex depth in from the outer edge')
    a = ap.parse_args()
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
    check_below_proximal(gd, dv, dlo, dhi, prox, np.load(a.proximal_valid), tib, vox)
    w = np.arange(h.shape[0])[:, None, None]
    rel = (w - gd[None]) * vox * 1000  # um below the distal face
    w0 = max(int(np.floor(gd.min())), 0)
    w1 = min(int(np.ceil(gd.max() + CORTEX_SPAN_MM / vox)) + 1, h.shape[0])
    filled = np.zeros(h.shape, bool)
    for k in range(w0, w1):
        filled[k] = close_and_fill(tib[k], vox)
    dist = edge_distance(filled, w0, w1)
    bone_all = np.asarray(h) > a.threshold  # HU alone; `filled` (from the tibia label) only limits where it is looked at
    slab = (rel >= a.start_um) & (rel < a.start_um + a.length_um)
    est = cortex_depth(bone_all, dist, slab & filled) * vox
    cortex_mm = a.cortex_mm if a.cortex_mm is not None else est
    edge = (cortex_mm + a.cortex_clearance_um / 1000) / vox
    roi = slab & filled & (dist > edge)
    if not roi.any():
        sidecar.fail('ROI-3 is empty: check the growth-plate surfaces, or lower --cortex-mm')
    below = (rel >= 0) & (w < w1)
    cortex = bone_all & below & filled & (dist <= cortex_mm * a.cortex_search_factor / vox)
    meta = {'distal_face': 'traced distal curves', 'cortex_estimate_mm': est, 'cortex_mm_used': cortex_mm, 'threshold': a.threshold}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    inputs = [a.hu_aligned, a.mask, a.annotations, a.proximal_face, a.proximal_valid]
    params = dict(
        meta,
        start_um=a.start_um,
        length_um=a.length_um,
        cortex_clearance_um=a.cortex_clearance_um,
        cortex_search_factor=a.cortex_search_factor,
    )
    for name, arr in (('roi3-tissue.npy', roi), ('cortex.npy', cortex)):
        np.save(out / name, arr)
        sidecar.write(out / name, grid_id=g['grid_id'], spacing_zyx_mm=g['spacing_zyx_mm'], inputs=inputs, params=params)
    like = sidecar.sidecar_path(a.mask)
    meta = {'inputs': inputs, 'params': params}
    placed = {
        'roi-metaphyseal': objects.mask(out / 'roi-metaphyseal.npy', roi, like=like, **meta),
        'cortex': objects.mask(out / 'cortex-object.npy', cortex, like=like, **meta),
        'growth-plate-distal-face': objects.surface(out / 'growth-plate-distal-face.npy', gd, 0, like=like, **meta),  # heights along W
    }
    vs = np.linspace(*np.flatnonzero(roi.any(axis=(0, 2)))[[0, -1]], 4).astype(int)
    fig, axs = plt.subplots(2, 4, figsize=(20, 10))
    for v, ax in zip(vs, axs[0]):
        ax.imshow(h[:, v, :], cmap='gray', vmin=0, vmax=5000)
        ax.contour(roi[:, v, :], levels=[0.5], colors='cyan', linewidths=0.8)
        ax.contour(cortex[:, v, :], levels=[0.5], colors='orange', linewidths=0.5)
        ax.plot(np.arange(h.shape[2]), gd[v], color='magenta', lw=0.8)
        ax.set(title=f'V={v}: ROI-3 cyan, cortex orange', xlabel='U', ylabel='W')
    wm = int(np.median(np.argwhere(roi)[:, 0]))
    for k, ax in zip((wm - 8, wm, wm + 8, wm + 30), axs[1]):
        ax.imshow(h[k], cmap='gray', vmin=0, vmax=5000)
        ax.contour(roi[k], levels=[0.5], colors='cyan', linewidths=0.8)
        ax.contour(cortex[k], levels=[0.5], colors='orange', linewidths=0.5)
        ax.set(title=f'axial W={k}', xlabel='U', ylabel='V')
    fig.tight_layout()
    qc = out / 'qc-roi3.jpg'
    sidecar.save_image(fig, qc)
    plt.close(fig)
    sidecar.emit_values(
        out / 'roi3.json',
        {},
        params,
        objects=placed,
        qc=str(qc),
        roi3_tissue=str(out / 'roi3-tissue.npy'),
        cortex=str(out / 'cortex.npy'),
        distal_face=str(out / 'growth-plate-distal-face.npy'),
        cortex_estimate_mm=round(est, 4),
        roi3_voxels=int(roi.sum()),
    )


if __name__ == '__main__':
    main()
