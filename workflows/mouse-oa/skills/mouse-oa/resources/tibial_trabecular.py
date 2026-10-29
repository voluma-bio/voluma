"""Cut the trabecular compartment of the tibial IIOC (ROI-2): under the subchondral plate, inside the cortex.

ROI-2 is ROI-1 (from iioc.py) minus the subchondral plate above a traced under-plate boundary, minus a shell of the
outer surface, minus a clearance under the growth-plate face, limited laterally by the boundary's end points and by
V limits. It writes the region only: its TV, BV and BV/TV (deck #13-15) come from `morphometry.py volumes`. An empty ROI-2 is refused.

--annotations is a JSON file of indices on the aligned grid. It needs "grid_id" (the grid_id of tibia-frame.json; a file without it
or from another grid is refused). This script reads two keys, other sections of the file are ignored:
  under_plate_curves  required: curves (below) for the boundary between the subchondral plate and the trabecular compartment,
                      with the end points on the inner side of the cortex: the first and last point of each curve limit ROI-2
                      laterally (it exists only where the curves reach)
  v_limits            required: [first V, last V], inclusive, the sections ROI-2 spans
Curves (every traced surface): {"axis": 1, "height": "row", "slices": {"<v>": [[w, u], ...]}}: the coronal section at
V = <v> (array axis 1 of the aligned grid), each point [row, column] = [W, U] read off that section's pixel grid ("height"
is "row" or omitted). A surface is linear in U along a curve (points in any order, constant past the ends) and linear in
V between traced sections (constant past the first and last). A point is [w, u], not [u, w]. At least two sections;
anything but axis 1 and height row is refused.

Writes: <out>/iioc-trab-tissue.npy  ROI-2, bool, on the aligned grid, with its sidecar
        <out>/under-plate-boundary.npy  W index of the under-plate boundary per (V,U), float32, with its sidecar
        <out>/qc-coronal.jpg  six coronal sections: ROI-2 (cyan) inside ROI-1 (green)
Prints: one JSON line {qc, tissue, upper_boundary}
Example: python tibial_trabecular.py --iioc-tissue iioc/iioc-tissue.npy --growth-plate-face iioc/growth-plate-proximal-face.npy --hu-aligned tibia-hu.npy --annotations annotations.json --out roi2/
Exits 2 with one sentence on bad input, before writing anything.
"""

from pathlib import Path

import matplotlib
import numpy as np
import sidecar
from annotations import load_annotations, need, traced_surface
from scipy import ndimage as ndi

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
    ap = sidecar.parser(__doc__)
    ap.add_argument('--iioc-tissue', type=sidecar.existing, required=True, help='iioc-tissue.npy from iioc.py (ROI-1), with its sidecar beside it')
    ap.add_argument('--growth-plate-face', type=sidecar.existing, required=True, help='growth-plate-proximal-face.npy from iioc.py')
    ap.add_argument('--hu-aligned', type=sidecar.existing, required=True, help='tibia-hu.npy from tibia_frame.py (for the QC image)')
    ap.add_argument('--annotations', type=sidecar.existing, required=True, help='annotations JSON on the aligned grid, described above')
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--shell-clearance-mm', type=float, default=0.021, help='mm: stay this far inside the outer surface of ROI-1')
    ap.add_argument(
        '--growth-clearance-mm', type=float, default=0.021, help='mm: stay this far above the growth-plate face'
    )
    ap.add_argument(
        '--upper-shift-mm', type=float, default=0.0, help='mm: move the under-plate boundary by this much: sensitivity run'
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
            surface_axis=0 if name == 'under-plate-boundary.npy' else None,
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
