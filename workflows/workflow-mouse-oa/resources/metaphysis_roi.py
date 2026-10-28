"""Metaphyseal regions under the tibial growth plate: ROI-3 (deck #16-23) and the cortex for Ct.Th (deck #24, #25).

  python metaphysis_roi.py --hu-aligned tibia-hu.npy --mask tibia-mask.npy --hu-json hu.json --annotations annotations.json
         --proximal-face growth-plate-proximal-face.npy --out <dir> [--threshold HU] [--start-um 50] [--length-um 200] [--cortex-clearance-um 20] [--cortex-mm X]
         [--cortex-search-factor 2]

The growth plate's distal face is the reference surface (one face for the whole run: `cortical` reads this script's output,
it does not trace its own), and it must be traced (`growth_plate_distal_curves` in the
annotations): ROI-3 starts 50 um below it, so a guessed band thickness (100-200 um on OA6-1RK) moves BV/TV from 23% to
15% and is not a measurement. The bone threshold (default: the lab's 2.16/cm in this scan's HU, from hu.json's calibration)
is used here only to estimate the cortex and to build the cortex mask; no label gates it.
ROI-3 is the slab between `start` and `start + length` below that face (measured along W), inside the filled tibial
cross-section, at least `cortex + clearance` from its outer edge. The cortex thickness used for that edge is the
depth at which the bone fraction of the outer layers first drops below one half (estimated in the ROI-3 slices,
reported as cortex_estimate_mm), or --cortex-mm. The cortex mask for Ct.Th is the bone within `search factor` times
that depth of the outer edge, over 1.3 mm of shaft below the plate: it can include trabeculae that join the cortex.

The script stops when the distal trace does not cover the V range of the proximal one, or when the traced distal face lies
at or above the proximal face (`--proximal-face`, from iioc.py) inside the tibia, where both come from traced points: the
band between them cannot be thinner than nothing.

Writes roi3-tissue.npy, cortex.npy, growth-plate-distal-face.npy (2D W index per V,U), roi3.json (the
parameters used and the cortex estimate), a QC image. It writes regions only: TV, BV and BV/TV of ROI-3 (deck #16-18) and Tb.N/Th/Sp,
nodes/ends (deck #19-23) are `morphometry.py trabecular` on roi3-tissue.npy, and Ct.Th is `morphometry.py cortical` on
cortex.npy with the distal face as --surface. The annotation schema is in ../references/oa-protocol.md.
"""

import argparse
import json
import sys
from pathlib import Path

import matplotlib
import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; microct-core is found by walking up to the directory that holds it.
CORE = next((p / 'microct-analysis/skills/microct-core/resources' for p in HERE.parents
             if (p / 'microct-analysis/skills/microct-core/resources/sidecar.py').exists()), None)
if CORE is None:
    sys.exit('Cannot find microct-core: this script expects microct-analysis/skills/microct-core/resources/ in a '
             'directory above it (<workflows>/workflow-mouse-oa/resources/ with <workflows>/microct-analysis/ beside it)')
sys.path[:0] = [str(HERE), str(CORE)]
import sidecar
from envelope import close_and_fill
from iioc import load_annotations, need, traced_surface

matplotlib.use('Agg')
import matplotlib.pyplot as plt

CORTEX_SPAN_MM = 1.3  # shaft length below the plate the cortex mask covers: Ct.Th is asked at up to 1 mm


def trace_extent(spec, key, shape):
    """(valid, first V, last V): where a trace holds data. Beyond it the face is the nearest trace held constant."""
    valid = traced_surface(spec, key, shape)[1]
    levels = sorted(int(k) for k in spec['slices'])
    return valid, levels[0], levels[-1]


def check_below_proximal(ann, gd, prox, tib, shape, vox):
    """Stop when the distal face is not below the proximal one, comparing only where both come from traced points.

    Outside a trace (past its last section or the ends of its curves) a face is extrapolated and can cross the other
    one without any traced point being wrong, so the agent is told which sections to add, not to lower the points.
    """
    pv, plo, phi = trace_extent(need(ann, 'growth_plate_curves', 'trace the proximal face of the growth plate'),
                                'growth_plate_curves', shape)
    dv, dlo, dhi = trace_extent(ann['growth_plate_distal_curves'], 'growth_plate_distal_curves', shape)
    if dlo > plo or dhi < phi:
        sidecar.fail(f'the distal face is traced on sections V={dlo}..{dhi} but the proximal face on V={plo}..{phi}, so the distal '
                     'face is not known over the whole proximal one: '
                     + ' and '.join(f'trace the distal face on a section near V={v} too'
                                    for v, miss in ((plo, dlo > plo), (phi, dhi < phi)) if miss))
    footprint = ndi.binary_fill_holes(tib.any(axis=0))
    vs = np.arange(gd.shape[0])[:, None]
    bad = (gd <= prox) & pv & dv & footprint & (vs >= max(plo, dlo)) & (vs <= min(phi, dhi))
    if bad.any():
        vi, ui = np.nonzero(bad)
        sidecar.fail(f'the traced distal face lies at or above the proximal face at {int(bad.sum())} traced (V, U) positions, '
                     f'V={vi.min()}..{vi.max()}, U={ui.min()}..{ui.max()} (worst {float((prox - gd)[bad].max()) * vox * 1000:.0f} um): '
                     'retrace the distal face lower, or the proximal face higher, on sections in that V range')


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
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--hu-aligned', required=True)
    ap.add_argument('--mask', required=True, help='tibia-mask.npy from tibia_frame.py')
    ap.add_argument('--hu-json', required=True, help='hu.json of the scan: the lab threshold in HU comes from its calibration')
    ap.add_argument('--annotations', required=True)
    ap.add_argument('--proximal-face', required=True, help='growth-plate-proximal-face.npy from iioc.py: the distal face must lie below it')
    ap.add_argument('--out', required=True)
    ap.add_argument('--threshold', type=float, help='bone threshold in HU (default: the lab threshold, 2.16/cm, from --hu-json)')
    ap.add_argument('--start-um', type=float, default=50.0, help='ROI-3 starts this far below the growth plate')
    ap.add_argument('--length-um', type=float, default=200.0, help='ROI-3 length along the shaft')
    ap.add_argument('--cortex-clearance-um', type=float, default=20.0)
    ap.add_argument('--cortex-mm', type=float, help='cortex thickness for the clearance (default: estimated)')
    ap.add_argument('--cortex-search-factor', type=float, default=2.0)
    a = ap.parse_args()
    g = sidecar.grid(sidecar.sidecar_path(a.mask))
    ann = load_annotations(a.annotations, g['grid_id'])
    vox = g['spacing_zyx_mm'][0]
    h = np.load(a.hu_aligned, mmap_mode='r')
    tib = np.load(a.mask)
    if 'growth_plate_distal_curves' not in ann:
        sidecar.fail(
            'annotations.json has no "growth_plate_distal_curves": trace the distal face of the growth-plate band on coronal '
            'sections of tibia-hu.npy (the side facing the shaft, like the proximal face in section A) and run again'
        )
    a.threshold = sidecar.bone_threshold_hu(a.hu_json, a.threshold)
    gd = traced_surface(ann['growth_plate_distal_curves'], 'growth_plate_distal_curves', h.shape)[0].astype(np.float32)
    prox = np.load(a.proximal_face)
    if prox.shape != gd.shape:
        sidecar.fail(f'--proximal-face is {prox.shape} but the distal face is {gd.shape}: pass the face of the same tibia frame')
    check_below_proximal(ann, gd, prox, tib, h.shape, vox)
    w = np.arange(h.shape[0])[:, None, None]
    rel = (w - gd[None]) * vox * 1000  # um below the distal face
    w0 = max(int(np.floor(gd.min())), 0)
    w1 = min(int(np.ceil(gd.max() + CORTEX_SPAN_MM / vox)) + 1, h.shape[0])
    filled = np.zeros(h.shape, bool)
    for k in range(w0, w1):
        filled[k] = close_and_fill(tib[k])
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
    inputs = [a.hu_aligned, a.mask, a.annotations, a.proximal_face]
    params = dict(
        meta,
        start_um=a.start_um,
        length_um=a.length_um,
        cortex_clearance_um=a.cortex_clearance_um,
        cortex_search_factor=a.cortex_search_factor,
    )
    for name, arr in (
        ('roi3-tissue.npy', roi),
        ('cortex.npy', cortex),
        ('growth-plate-distal-face.npy', gd),
    ):
        np.save(out / name, arr)
        sidecar.write(
            out / name,
            grid_id=g['grid_id'],
            spacing_zyx_mm=g['spacing_zyx_mm'],
            inputs=inputs,
            params=params,
            script='metaphysis_roi.py',
        )
    (out / 'roi3.json').write_text(json.dumps(params, indent=1) + '\n')
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
    sidecar.emit(
        params=str(out / 'roi3.json'),
        qc=str(qc),
        roi3_tissue=str(out / 'roi3-tissue.npy'),
        cortex=str(out / 'cortex.npy'),
        distal_face=str(out / 'growth-plate-distal-face.npy'),
        cortex_estimate_mm=round(est, 4),
        roi3_voxels=int(roi.sum()),
    )


if __name__ == '__main__':
    main()
