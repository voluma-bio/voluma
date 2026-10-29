"""Trabecular compartment of the tibial IIOC (ROI-2): the region under the subchondral plate, inside the cortex.

  python tibial_trabecular.py --iioc-tissue iioc-tissue.npy --growth-plate-face growth-plate-proximal-face.npy
         --hu-aligned tibia-hu.npy --annotations annotations.json --out <dir>
         [--shell-clearance-mm 0.021] [--growth-clearance-mm 0.021] [--upper-shift-mm 0]

ROI-2 is ROI-1 (from iioc.py) minus the subchondral plate above a traced under-plate boundary, minus a shell of the
outer surface, minus a clearance under the growth-plate face, limited laterally by the boundary's end points and by
V limits. It writes the region only: its TV, BV and BV/TV (deck #13-15) come from `morphometry.py volumes`.

Writes iioc-trab-tissue.npy, under-plate-boundary.npy (2D W index per V,U), QC images; prints one JSON line.
The annotation schema is in ../references/oa-protocol.md.
"""

import argparse
import sys
from pathlib import Path

import matplotlib
import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; microct-core is found by walking up to the directory that holds it.
CORE = next((p / 'core/skills/microct-core/resources' for p in HERE.parents
             if (p / 'core/skills/microct-core/resources/sidecar.py').exists()), None)
if CORE is None:
    sys.exit('Cannot find microct-core: this script expects core/skills/microct-core/resources/ in a '
             'directory above it (<workflows>/mouse-oa/skills/mouse-oa/resources/ with <workflows>/core/ beside it)')
sys.path[:0] = [str(HERE), str(CORE)]
import sidecar
from iioc import load_annotations, need, traced_surface

matplotlib.use('Agg')
import matplotlib.pyplot as plt


def compartment(parent, gp, ann, vox, shell_mm, growth_mm, upper_shift=0.0):
    spec = need(
        ann,
        'under_plate_curves',
        'trace the boundary between the subchondral plate and the trabecular '
        'compartment on coronal sections, end points on the inner side of the cortex',
    )
    upper, reach = traced_surface(spec, 'under_plate_curves', parent.shape)
    upper = upper + upper_shift
    w = np.arange(parent.shape[0])[:, None, None]
    v = np.arange(parent.shape[1])[None, :, None]
    inner = ndi.distance_transform_edt(parent) > shell_mm / vox
    roi = inner & (w >= upper[None]) & (w < gp[None] - growth_mm / vox)
    roi &= reach[None]  # only where the traced curves reach: their end points limit ROI-2 sideways
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
    ap.add_argument('--shell-clearance-mm', type=float, default=0.021, help='stay this far inside the outer surface')
    ap.add_argument(
        '--growth-clearance-mm', type=float, default=0.021, help='stay this far above the growth-plate face'
    )
    ap.add_argument(
        '--upper-shift-mm', type=float, default=0.0, help='move the under-plate boundary by this many mm: sensitivity run'
    )
    a = ap.parse_args()
    g = sidecar.grid(sidecar.sidecar_path(a.iioc_tissue))
    ann = load_annotations(a.annotations, g['grid_id'])
    vox = g['spacing_zyx_mm'][0]
    parent = np.load(a.iioc_tissue)
    gp = np.load(a.growth_plate_face)
    hu = np.load(a.hu_aligned, mmap_mode='r')
    roi, upper = compartment(parent, gp, ann, vox, a.shell_clearance_mm, a.growth_clearance_mm, a.upper_shift_mm / vox)
    if not roi.any():
        sidecar.fail('ROI-2 is empty: the under-plate curves lie outside ROI-1 or the clearances are too large')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    params = {
        'shell_clearance_mm': a.shell_clearance_mm,
        'growth_clearance_mm': a.growth_clearance_mm,
        'upper_shift_mm': a.upper_shift_mm,
    }
    for name, arr in (
        ('iioc-trab-tissue.npy', roi),
        ('under-plate-boundary.npy', upper.astype(np.float32)),
    ):
        np.save(out / name, arr)
        sidecar.write(
            out / name,
            grid_id=g['grid_id'],
            spacing_zyx_mm=g['spacing_zyx_mm'],
            inputs=[a.iioc_tissue, a.growth_plate_face, a.annotations],
            params=params,
            script='tibial_trabecular.py',
        )
    vs = sorted(map(int, ann['under_plate_curves']['slices']))
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
        qc=str(qc),
        tissue=str(out / 'iioc-trab-tissue.npy'),
        upper_boundary=str(out / 'under-plate-boundary.npy'),
    )


if __name__ == '__main__':
    main()
