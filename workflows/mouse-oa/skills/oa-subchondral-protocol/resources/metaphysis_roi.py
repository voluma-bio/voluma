"""Metaphyseal regions under the tibial growth plate: ROI-3 (deck #16-23) and the cortex for Ct.Th (deck #24, #25).

  python metaphysis_roi.py --hu-aligned tibia-hu.npy --mask tibia-mask.npy --annotations annotations.json --out <dir>
         [--threshold 2500] [--start-um 50] [--length-um 200] [--cortex-clearance-um 20] [--cortex-mm X]
         [--cortex-search-factor 2]

The growth plate's distal face is the reference surface (from `growth_plate_distal_curves`, or the proximal face
from iioc.py plus `growth_plate_thickness_mm`: an assumption the agent must have read off the images).
ROI-3 is the slab between `start` and `start + length` below that face (measured along W), inside the filled tibial
cross-section, at least `cortex + clearance` from its outer edge. The cortex thickness used for that edge is the
depth at which the bone fraction of the outer layers first drops below one half (estimated in the ROI-3 slices,
reported as cortex_estimate_mm), or --cortex-mm. The cortex mask for Ct.Th is the bone within `search factor` times
that depth of the outer edge, over 1.3 mm of shaft below the plate: it can include trabeculae that join the cortex.

Writes roi3-tissue.npy, roi3-bone.npy, cortex.npy, growth-plate-distal-face.npy (2D W index per V,U), roi3.json,
a QC image. TV, BV and BV/TV come out here; the rest (Tb.N/Th/Sp, nodes/ends, Ct.Th) is `morphometry.py` on
these masks (`trabecular` on roi3-*, `cortical` on cortex.npy with the distal face as --surface).
"""

import argparse
import json
import sys
from pathlib import Path

import matplotlib
import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / 'microct-analysis/skills/microct-core/resources'))
import sidecar
from iioc import boundary_surface

matplotlib.use('Agg')
import matplotlib.pyplot as plt

CORTEX_SPAN_MM = 1.3  # shaft length below the plate the cortex mask covers: Ct.Th is asked at up to 1 mm


def distal_face(ann, a_face, vox, shape_vu):
    if 'growth_plate_distal_curves' in ann:
        return boundary_surface(ann['growth_plate_distal_curves'], shape_vu), 'traced distal curves'
    if 'growth_plate_thickness_mm' in ann:
        return a_face + ann['growth_plate_thickness_mm'] / vox, 'proximal face + growth_plate_thickness_mm (assumed)'
    sidecar.fail(
        'annotations.json needs "growth_plate_distal_curves" (traced like the proximal face) or '
        '"growth_plate_thickness_mm" (read it off a coronal section)'
    )


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
    ap.add_argument(
        '--growth-plate-face', help='growth-plate-proximal-face.npy from iioc.py (for the thickness fallback)'
    )
    ap.add_argument('--annotations', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--threshold', type=float, default=2500.0)
    ap.add_argument('--start-um', type=float, default=50.0, help='ROI-3 starts this far below the growth plate')
    ap.add_argument('--length-um', type=float, default=200.0, help='ROI-3 length along the shaft')
    ap.add_argument('--cortex-clearance-um', type=float, default=20.0)
    ap.add_argument('--cortex-mm', type=float, help='cortex thickness for the clearance (default: estimated)')
    ap.add_argument('--cortex-search-factor', type=float, default=2.0)
    a = ap.parse_args()
    ann = json.loads(Path(a.annotations).read_text())
    g = sidecar.grid(sidecar.sidecar_path(a.mask))
    vox = g['spacing_zyx_mm'][0]
    h = np.load(a.hu_aligned, mmap_mode='r')
    tib = np.load(a.mask)
    face = np.load(a.growth_plate_face) if a.growth_plate_face else None
    gd, how = distal_face(ann, face, vox, h.shape[1:])
    gd = gd.astype(np.float32)
    w = np.arange(h.shape[0])[:, None, None]
    rel = (w - gd[None]) * vox * 1000  # um below the distal face
    w0 = max(int(np.floor(gd.min())), 0)
    w1 = min(int(np.ceil(gd.max() + CORTEX_SPAN_MM / vox)) + 1, h.shape[0])
    filled = np.zeros(h.shape, bool)
    for k in range(w0, w1):
        filled[k] = ndi.binary_fill_holes(tib[k])
    dist = edge_distance(filled, w0, w1)
    bone_all = tib & (np.asarray(h) > a.threshold)
    slab = (rel >= a.start_um) & (rel < a.start_um + a.length_um)
    est = cortex_depth(bone_all, dist, slab & filled) * vox
    cortex_mm = a.cortex_mm if a.cortex_mm is not None else est
    edge = (cortex_mm + a.cortex_clearance_um / 1000) / vox
    roi = slab & filled & (dist > edge)
    if not roi.any():
        sidecar.fail('ROI-3 is empty: check the growth-plate surfaces, or lower --cortex-mm')
    bone = roi & bone_all
    below = (rel >= 0) & (w < w1)
    cortex = bone_all & below & filled & (dist <= cortex_mm * a.cortex_search_factor / vox)
    tv, bv = float(roi.sum()) * vox**3, float(bone.sum()) * vox**3
    values = {
        'roi3_tv': {
            'value': tv,
            'unit': 'mm^3',
            'definition': f'deck #16: tissue volume of ROI-3, {a.start_um:g}-'
            f'{a.start_um + a.length_um:g} um below the growth plate, >= {a.cortex_clearance_um:g} um inside '
            f'the cortex ({cortex_mm * 1000:.0f} um)',
        },
        'roi3_bv': {'value': bv, 'unit': 'mm^3', 'definition': f'deck #17: HU > {a.threshold} inside ROI-3'},
        'roi3_bv_tv': {'value': bv / tv, 'unit': '1', 'definition': 'deck #18: BV/TV as a fraction'},
    }
    meta = {'distal_face': how, 'cortex_estimate_mm': est, 'cortex_mm_used': cortex_mm, 'threshold': a.threshold}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    inputs = [a.hu_aligned, a.mask, a.annotations]
    params = dict(
        meta,
        start_um=a.start_um,
        length_um=a.length_um,
        cortex_clearance_um=a.cortex_clearance_um,
        cortex_search_factor=a.cortex_search_factor,
    )
    for name, arr in (
        ('roi3-tissue.npy', roi),
        ('roi3-bone.npy', bone),
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
    (out / 'roi3.json').write_text(json.dumps({'values': values, 'meta': meta}, indent=1) + '\n')
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
        out=str(out / 'roi3.json'),
        qc=str(qc),
        roi3_tissue=str(out / 'roi3-tissue.npy'),
        roi3_bone=str(out / 'roi3-bone.npy'),
        cortex=str(out / 'cortex.npy'),
        distal_face=str(out / 'growth-plate-distal-face.npy'),
        cortex_estimate_mm=round(est, 4),
        distal_face_source=how,
        values={k: round(v['value'], 5) for k, v in values.items()},
    )


if __name__ == '__main__':
    main()
