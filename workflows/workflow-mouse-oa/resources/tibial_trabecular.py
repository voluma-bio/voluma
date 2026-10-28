"""Trabecular compartment of the tibial IIOC (ROI-2): the region under the subchondral plate, inside the cortex.

  python tibial_trabecular.py --iioc-tissue iioc-tissue.npy --growth-plate-face growth-plate-proximal-face.npy
         --hu-aligned tibia-hu.npy --hu-json hu.json --annotations annotations.json --out <dir> [--threshold HU]
         [--shell-clearance-mm 0.021] [--growth-clearance-mm 0.021] [--upper-shift-voxels 0]

ROI-2 is ROI-1 (from iioc.py) minus the subchondral plate above a traced under-plate boundary, minus a shell of the
outer surface, minus a clearance under the growth-plate face, limited laterally by the boundary's end points and by
V limits. TV, BV (ROI and aligned-grid HU above the threshold, no label gate) and BV/TV (%) come out here; Tb.Th, Tb.Sp, Tb.N (and nodes/ends) come from
`bone-morphometry/resources/morphometry.py trabecular` on the masks this writes (iioc-trab-tissue.npy and
iioc-trab-bone.npy), which sit on the aligned grid named in their sidecars.

Writes iioc-trab-tissue.npy, iioc-trab-bone.npy, under-plate-boundary.npy (2D W index per V,U), trab.json, QC
images; prints one JSON line.
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
from iioc import boundary_surface, need

matplotlib.use('Agg')
import matplotlib.pyplot as plt


def compartment(parent, gp, ann, vox, shell_mm, growth_mm, upper_shift=0.0):
    curves = need(
        ann,
        'under_plate_curves',
        'trace the boundary between the subchondral plate and the trabecular '
        'compartment on coronal sections, end points on the inner side of the cortex',
    )
    upper = boundary_surface(curves, parent.shape[1:]) + upper_shift
    vs = sorted(map(int, curves))
    left = np.interp(np.arange(parent.shape[1]), vs, [curves[str(v)][0][0] for v in vs])
    right = np.interp(np.arange(parent.shape[1]), vs, [curves[str(v)][-1][0] for v in vs])
    w, v, u = np.ogrid[: parent.shape[0], : parent.shape[1], : parent.shape[2]]
    inner = ndi.distance_transform_edt(parent) > shell_mm / vox
    roi = inner & (w >= upper[None]) & (w < gp[None] - growth_mm / vox)
    roi &= (u >= left[None, :, None]) & (u <= right[None, :, None])
    vlo, vhi = need(ann, 'v_limits', 'first and last V index of the compartment')
    roi &= (v >= vlo) & (v <= vhi)
    return roi, upper


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--iioc-tissue', required=True)
    ap.add_argument('--growth-plate-face', required=True)
    ap.add_argument('--hu-aligned', required=True)
    ap.add_argument('--annotations', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--hu-json', required=True, help='hu.json of the scan: the lab threshold in HU comes from its calibration')
    ap.add_argument('--threshold', type=float, help='bone threshold in HU (default: the lab threshold, 2.16/cm, from --hu-json)')
    ap.add_argument('--shell-clearance-mm', type=float, default=0.021, help='stay this far inside the outer surface')
    ap.add_argument(
        '--growth-clearance-mm', type=float, default=0.021, help='stay this far above the growth-plate face'
    )
    ap.add_argument(
        '--upper-shift-voxels', type=float, default=0.0, help='move the under-plate boundary: sensitivity run'
    )
    a = ap.parse_args()
    ann = json.loads(Path(a.annotations).read_text())
    g = sidecar.grid(sidecar.sidecar_path(a.iioc_tissue))
    vox = g['spacing_zyx_mm'][0]
    parent = np.load(a.iioc_tissue)
    gp = np.load(a.growth_plate_face)
    hu = np.load(a.hu_aligned, mmap_mode='r')
    a.threshold = sidecar.bone_threshold_hu(a.hu_json, a.threshold)
    roi, upper = compartment(parent, gp, ann, vox, a.shell_clearance_mm, a.growth_clearance_mm, a.upper_shift_voxels)
    if not roi.any():
        sidecar.fail('ROI-2 is empty: the under-plate curves lie outside ROI-1 or the clearances are too large')
    bone = roi & (np.asarray(hu) > a.threshold)
    tv, bv = float(roi.sum()) * vox**3, float(bone.sum()) * vox**3
    values = {
        'iioc_trab_tv': {'value': tv, 'unit': 'mm^3', 'definition': 'ROI-2 tissue volume (deck #13), aligned grid'},
        'iioc_trab_bv': {'value': bv, 'unit': 'mm^3', 'definition': f'ROI-2 bone volume (deck #14): HU > {a.threshold}'},
        'iioc_trab_bv_tv': {'value': bv / tv * 100, 'unit': '%', 'definition': 'ROI-2 BV/TV in % (deck #15)'},
    }
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    params = {
        'threshold': a.threshold,
        'shell_clearance_mm': a.shell_clearance_mm,
        'growth_clearance_mm': a.growth_clearance_mm,
        'upper_shift_voxels': a.upper_shift_voxels,
    }
    for name, arr in (
        ('iioc-trab-tissue.npy', roi),
        ('iioc-trab-bone.npy', bone),
        ('under-plate-boundary.npy', upper.astype(np.float32)),
    ):
        np.save(out / name, arr)
        sidecar.write(
            out / name,
            grid_id=g['grid_id'],
            spacing_zyx_mm=g['spacing_zyx_mm'],
            inputs=[a.iioc_tissue, a.growth_plate_face, a.hu_aligned, a.annotations],
            params=params,
            script='tibial_trabecular.py',
        )
    (out / 'trab.json').write_text(json.dumps({'values': values, 'params': params}, indent=1) + '\n')
    vs = sorted(map(int, ann['under_plate_curves']))
    picks = [vs[i] for i in np.linspace(0, len(vs) - 1, 6).astype(int)]
    fig, axs = plt.subplots(2, 3, figsize=(18, 11))
    for v, ax in zip(picks, axs.flat):
        ax.imshow(hu[:, v, :], cmap='gray', vmin=0, vmax=5000)
        ax.contour(parent[:, v, :], levels=[0.5], colors='lime', linewidths=0.6)
        ax.contour(roi[:, v, :], levels=[0.5], colors='cyan', linewidths=1)
        ax.set(title=f'ROI-2 (cyan) inside ROI-1 (green), V={v}', xlabel='U', ylabel='W')
    fig.tight_layout()
    qc = out / 'qc-coronal.jpg'
    sidecar.save_image(fig, qc)
    plt.close(fig)
    sidecar.emit(
        out=str(out / 'trab.json'),
        qc=str(qc),
        tissue=str(out / 'iioc-trab-tissue.npy'),
        bone=str(out / 'iioc-trab-bone.npy'),
        values={k: round(v['value'], 5) for k, v in values.items()},
    )


if __name__ == '__main__':
    main()
