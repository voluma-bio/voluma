"""Cut the trabecular compartment of the tibial IIOC (ROI-2): under the subchondral plate, inside the cortex.

ROI-2 is ROI-1 (from iioc.py) minus the subchondral plate above a traced under-plate boundary, minus a shell of the
outer surface, minus a clearance under the growth-plate face, limited laterally by the boundary's end points and by
V limits. The two clearances (`shell_clearance_mm`, `growth_clearance_mm`) come from the spec (--spec, protocol.json, the entry
`roi-iioc-trabecular`). It writes the region only: its TV, BV and BV/TV (deck #13-15) come from `morphometry.py volumes`. An empty ROI-2 is refused.

--annotations is a JSON file of indices on the aligned grid. It needs "grid_id" (the grid_id of tibia-frame.json; a file without it
or from another grid is refused). This script reads two keys; any other key is refused, and so is a value of the wrong form or an index outside the grid:
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
        <out>/roi-iioc-trabecular.npy  ROI-2 cropped to its bounding box, uint8 (the mask object; the same voxels)
        <out>/under-plate-boundary.npy  W index of the under-plate boundary per (V,U), float32, NaN off the tibia (where the growth-plate face is NaN), with its sidecar (a surface object)
        <out>/roi2.json  the result record: `objects` holds roi-iioc-trabecular and under-plate-boundary
        <out>/qc-coronal.jpg  six coronal sections: ROI-2 (cyan) inside ROI-1 (green)
Prints: one JSON line {out, values, objects, qc, tissue, upper_boundary}
Example: python tibial_trabecular.py --spec protocol.json --window anatomy.json --iioc-tissue iioc/iioc-tissue.npy --growth-plate-face iioc/growth-plate-proximal-face.npy --hu-aligned tibia-hu.npy --annotations annotations.json --out roi2/
Exits 2 with one sentence on bad input, before writing anything.
"""

from pathlib import Path

import numpy as np
import objects
import sidecar
import viewlib as vl
from annotations import load_annotations, need, traced_surface
from scipy import ndimage as ndi

ROI_ID = 'roi-iioc-trabecular'  # the spec entry this script reads


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
    ap.add_argument('--spec', type=sidecar.existing, required=True, help="the workflow's protocol.json: the entry roi-iioc-trabecular gives the clearances")
    ap.add_argument('--window', metavar='lo,hi', required=True, help="QC display window in HU, or the workflow's anatomy.json")
    ap.add_argument('--iioc-tissue', type=sidecar.existing, required=True, help='iioc-tissue.npy from iioc.py (ROI-1), with its sidecar beside it')
    ap.add_argument('--growth-plate-face', type=sidecar.existing, required=True, help='growth-plate-proximal-face.npy from iioc.py')
    ap.add_argument('--hu-aligned', type=sidecar.existing, required=True, help='tibia-hu.npy from tibia_frame.py (for the QC image)')
    ap.add_argument('--annotations', type=sidecar.existing, required=True, help='annotations JSON on the aligned grid, described above')
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument(
        '--upper-shift-mm', type=float, default=0.0, help='mm: move the under-plate boundary by this much: sensitivity run'
    )
    a = ap.parse_args()
    g = sidecar.grid(sidecar.sidecar_path(a.iioc_tissue))
    ann = load_annotations(a.annotations, g)
    vox = g['spacing_zyx_mm'][0]
    parent = np.load(a.iioc_tissue)
    gp = np.load(a.growth_plate_face)
    hu = np.load(a.hu_aligned, mmap_mode='r')
    p = sidecar.protocol(a.spec, ROI_ID, 'shell_clearance_mm', 'growth_clearance_mm')
    roi, upper = compartment(parent, gp, ann, vox, p['shell_clearance_mm'], p['growth_clearance_mm'], a.upper_shift_mm / vox)
    if not roi.any():
        sidecar.fail('ROI-2 is empty: the under-plate curves lie outside ROI-1 or the clearances are too large')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    params = {
        'shell_clearance_mm': p['shell_clearance_mm'],
        'growth_clearance_mm': p['growth_clearance_mm'],
        'upper_shift_mm': a.upper_shift_mm,
    }
    np.save(out / 'iioc-trab-tissue.npy', roi)
    meta = {'inputs': [a.iioc_tissue, a.growth_plate_face, a.annotations], 'params': params}
    sidecar.write(out / 'iioc-trab-tissue.npy', grid_id=g['grid_id'], spacing_zyx_mm=g['spacing_zyx_mm'], **meta)
    like = sidecar.sidecar_path(a.iioc_tissue)
    placed = {
        'roi-iioc-trabecular': objects.mask(out / 'roi-iioc-trabecular.npy', roi, like=like, **meta),
        'under-plate-boundary': objects.surface(out / 'under-plate-boundary.npy', upper, 0, like=like, where=np.isfinite(gp), **meta),  # heights along W
    }
    vs = sorted(map(int, ann['under_plate_curves']['slices']))
    picks = [vs[i] for i in np.linspace(0, len(vs) - 1, 6).astype(int)]
    qc = vl.slice_sheet(out / 'qc-coronal.jpg', hu, [(parent, 'lime'), (roi, 'cyan')], 1, picks, vl.parse_window(a.window),
                        axis_names=('W', 'V', 'U'), voxel_mm=vox,
                        titles=[f'ROI-2 (cyan) inside ROI-1 (green), V={v}' for v in picks])
    sidecar.emit_values(
        out / 'roi2.json',
        {},
        objects=placed,
        qc=qc,
        tissue=str(out / 'iioc-trab-tissue.npy'),
        upper_boundary=str(out / 'under-plate-boundary.npy'),
    )


if __name__ == '__main__':
    main()
