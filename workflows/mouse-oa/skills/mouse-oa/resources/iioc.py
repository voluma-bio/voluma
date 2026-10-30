"""Cut the tibial secondary ossification centre (IIOC, ROI-1) from traced curves; measure heights and width.

ROI-1 is the tibial bone between the articular surface and the proximal face of the growth plate (growth-plate
band and metaphysis excluded; marrow and cortical shell included), cut along growth-plate curves the agent traced
on coronal sections of the aligned stack (`tibia_frame.py`). This script writes regions and heights only: TV, BV and BV/TV of
ROI-1 (deck #4-6) come from `morphometry.py volumes`. Heights #7-9 are reported two ways until the lab chooses: along W, the
tibial shaft axis (the deck values), and perpendicular to the plane fitted to the traced growth-plate face (diagnostics
`*-normal`). The plane's rms residual says how far the traced face is from planar; where it is large, the two differ in size
and in sign from one height to the next. Plate-run bone is the ROI and aligned HU above the threshold (default: the lab's
2.16/cm in this scan's HU, from hu.json's calibration); no label gates it.

--annotations is a JSON file of indices on the aligned grid. It needs "grid_id" (the grid_id of tibia-frame.json; a file without it
or from another grid is refused). This script reads these keys; any other key is refused, and so is a value of the wrong form or an index outside the grid:
  growth_plate_curves     required: the proximal face of the growth plate, curves (below) on at least two V sections
  articular_corrections   optional list of {"u_range": [lo, hi], "v_range": [lo, hi], "curves": curves}: where part of the
                          tibia label is really femur or fibula above the articular surface, `curves` mark the true
                          articular surface inside the U and V ranges; ROI-1 keeps only what lies below it
  compartment_midpoint_u  required: {"lateral": U, "medial": U}, the U index at the middle of each plateau compartment. A height
                          point outside the ROI-1 footprint (or within 3 voxels of its edge) stops the script: move the point
  width_points_uvw        required: two [u, v, w] points (deck #10): the centre of the fibula-tibia junction on the tibial
                          surface, and the most prominent point on the other side
  growth_plate_mid_u      optional: U of "the middle of the growth plate" for height #7 (default: the mean U of the two width points)
  height_section_v        optional: the coronal section the heights are measured on (default: where the footprint's
                          growth-plate-to-top distance is largest)
  plate_patches           optional: {"medial": {"u": [lo, hi], "v": [lo, hi]}, "lateral": {...}}, U and V ranges (hi excluded)
                          of the subchondral-plate patch per compartment (default: `plate_patch_width_um` of the spec wide around
                          the compartment midpoint and height_section_v)
Curves (every traced surface): {"axis": 1, "height": "row", "slices": {"<v>": [[w, u], ...]}}: the coronal section at
V = <v> (array axis 1 of the aligned grid), each point [row, column] = [W, U] read off that section's pixel grid ("height"
is "row" or omitted). A surface is linear in U along a curve (points in any order, constant past the ends) and linear in
V between traced sections (constant past the first and last). A point is [w, u], not [u, w]. At least two sections;
anything but axis 1 and height row is refused.

Writes: in <out>, on the aligned grid (array axes W,V,U), each .npy with its sidecar:
  iioc-tissue.npy  ROI-1, bool                         growth-plate-proximal-face.npy  W index per (V,U), float32, NaN off the tibia (a surface object)
  growth-plate-proximal-valid.npy  2D bool: where the face is traced, not held constant past its first and last section or its curves' ends
  articular-top-surface.npy  W index of the ROI-1 top per (V,U) (a surface object)       <side>-plate-run.npy  bool, the first bone run of each compartment's patch
  iioc-tissue-scan.npy  ROI-1 on the scan grid (the scan's sidecar)    width-points-scan.json  the two width points as a points file on the scan grid, for amira_landmarks.py
  roi-iioc.npy  ROI-1 cropped to its bounding box, uint8 (the mask object; iioc-tissue.npy is the same voxels for the next scripts)
  iioc.json  the result record (every value with its definition: heights, width, diagnostics; `objects`: roi-iioc, the two surfaces
  and the four rulers, in the shapes `report_output` takes)   qc-coronal.jpg, qc-heights.jpg  QC images
Prints: the result record {out, values: {id: {value, unit, definition, kind}}, objects} with the paths of the files above (qc, tissue, tissue_scan, width_points_scan, growth_plate_face, growth_plate_traced, articular_top, plate_runs, removed_disconnected_voxels)
Example: python iioc.py --spec protocol.json --window anatomy.json --hu-aligned tibia-hu.npy --mask tibia-mask.npy --frame tibia-frame.json --hu-json hu.json --annotations annotations.json --out iioc/
Exits 2 with one sentence on bad input, before writing anything.
"""

import json
from pathlib import Path

import frame as fr
import numpy as np
import objects
import sidecar
import viewlib as vl
from annotations import load_annotations, need, traced_surface
from envelope import close_and_fill, footprint
from scipy import ndimage as ndi

ROI_ID = 'roi-iioc'  # the spec entry this script reads
MIN_COMPONENT = 50  # coronal fragments below this many pixels are segmentation specks, not bone
EDGE_ERODE = 3  # footprint erosion for the local-height search: avoids tangential edge extrema


def envelope(bone, gp, vox):
    """Filled tibial envelope under the face gp (W index per V,U). The cut face is sealed before filling marrow."""
    result = np.zeros(bone.shape, bool)
    wi = np.arange(bone.shape[0])[:, None]
    for v in range(bone.shape[1]):
        plane = ndi.binary_opening(bone[:, v, :], iterations=1)
        plane &= wi < gp[v][None, :]
        cc, _ = ndi.label(plane)
        sizes = np.bincount(cc.ravel())
        sizes[0] = 0
        plane = sizes[cc] >= MIN_COMPONENT
        contact = plane & (wi >= gp[v][None, :] - 10)
        us = np.flatnonzero(contact.any(axis=0))
        if len(us) > 1:
            uu = np.arange(us[0], us[-1] + 1)
            plane[np.clip(np.ceil(gp[v, uu]).astype(int) - 1, 0, bone.shape[0] - 1), uu] = True
        result[:, v, :] = close_and_fill(plane, vox)
    result = ndi.binary_fill_holes(ndi.binary_closing(result, iterations=1) | result)
    for u in range(bone.shape[2]):
        result[:, :, u] = ndi.binary_fill_holes(result[:, :, u])
    return result


def largest(mask):
    cc, _ = ndi.label(mask)
    n = np.bincount(cc.ravel())
    n[0] = 0
    return cc == n.argmax(), int(mask.sum() - n.max())


def ray_length(roi, start, direction, step=0.05, max_lead=3.0):
    """Distance in voxels from `start` along the unit `direction` to where the ray leaves `roi` (nearest-voxel membership).

    `start` sits on a traced face, which can round to a voxel just outside the ROI: the ray first walks up to `max_lead`
    voxels to enter it, and the length counts from `start` to the exit. Returns None for a ray that never enters.
    """
    def inside(t):
        p = np.rint(start + t * direction).astype(int)
        return (p >= 0).all() and (p < roi.shape).all() and roi[tuple(p)]

    t = 0.0
    while not inside(t):
        t += step
        if t > max_lead:
            return None
    while inside(t):
        t += step
    return t


def first_run(bone, v, u):
    ww = np.flatnonzero(bone[:, v, u])
    if not len(ww):
        return None
    start = end = int(ww[0])
    while end < bone.shape[0] and bone[end, v, u]:
        end += 1
    return start, end


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--spec', type=sidecar.existing, required=True, help="the workflow's protocol.json: the entry roi-iioc gives the plate patch width")
    ap.add_argument('--window', type=vl.window_arg, metavar='lo,hi', required=True, help="QC display window in HU, or the workflow's anatomy.json")
    ap.add_argument('--hu-aligned', type=sidecar.existing, required=True, help='tibia-hu.npy from tibia_frame.py')
    ap.add_argument('--mask', type=sidecar.existing, required=True, help='tibia-mask.npy from tibia_frame.py')
    ap.add_argument('--frame', type=sidecar.existing, required=True, help='tibia-frame.json from tibia_frame.py')
    ap.add_argument('--hu-json', type=sidecar.existing, required=True, help='hu.json of the scan: its grid, and the calibration the lab threshold in HU comes from')
    ap.add_argument('--annotations', type=sidecar.existing, required=True, help='annotations JSON on the aligned grid, described above')
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--threshold', type=float, help='bone threshold in HU (default: the lab threshold, 2.16/cm, from --hu-json)')
    ap.add_argument(
        '--gp-shift-mm',
        type=float,
        default=0.0,
        help='mm: move the traced growth-plate face by this much (+ = toward the shaft): sensitivity run',
    )
    a = ap.parse_args()
    plate_width_um = sidecar.protocol(a.spec, ROI_ID, 'plate_patch_width_um')['plate_patch_width_um']
    frame = fr.load(a.frame)
    ann = load_annotations(a.annotations, frame)
    g = sidecar.grid(a.hu_json)
    a.threshold = sidecar.bone_threshold_hu(a.hu_json, a.threshold)
    vox = frame['spacing_zyx_mm'][0]
    h = np.load(a.hu_aligned, mmap_mode='r')
    tib = np.load(a.mask)
    if frame['parent_grid_id'] != g['grid_id']:
        sidecar.fail('the frame was made on another scan grid than hu.json: rerun tibia_frame.py on this scan')
    gp_spec = need(ann, 'growth_plate_curves', 'trace the proximal face of the growth plate')
    gp, gp_traced = traced_surface(gp_spec, 'growth_plate_curves', h.shape)
    gp = gp + a.gp_shift_mm / vox
    v_traced = sorted(int(k) for k in gp_spec['slices'])
    gp_traced = gp_traced & (np.arange(gp.shape[0])[:, None] >= v_traced[0]) & (np.arange(gp.shape[0])[:, None] <= v_traced[-1])
    env = envelope(tib, gp, vox)
    w = np.arange(h.shape[0])[:, None, None]
    roi = env & (w < gp[None])
    for fix in ann.get('articular_corrections', []):
        surf = traced_surface(fix['curves'], 'articular_corrections[].curves', h.shape)[0]
        ulo, uhi = fix['u_range']
        vlo, vhi = fix['v_range']
        keep = np.ones(h.shape, bool)
        keep[:, vlo:vhi, ulo:uhi] = w >= surf[None, vlo:vhi, ulo:uhi]
        roi &= keep
    roi, removed = largest(roi)
    bone = roi & (np.asarray(h) > a.threshold)
    scan_roi = fr.to_scan(roi, frame, g['shape'])
    values = {'voxel-size': sidecar.value(vox, 'mm', 'voxel edge of the aligned grid, which every length here is a multiple of', kind='diagnostic')}
    valid = roi.any(axis=0)
    top = np.argmax(roi, axis=0).astype(float)
    local_height = np.where(valid, gp - top, np.nan)
    interior = ndi.binary_erosion(valid, iterations=EDGE_ERODE)
    vmax, umax = np.unravel_index(np.nanargmax(np.where(interior, local_height, np.nan)), valid.shape)
    v_star = int(ann.get('height_section_v', vmax))
    wp = need(
        ann,
        'width_points_uvw',
        'two [u, v, w] points: centre of the fibula-tibia junction on the tibial surface, '
        'and the prominent point on the other side',
    )
    wp = np.array(wp, float)
    u_mid = round(ann.get('growth_plate_mid_u', wp[:, 0].mean()))
    mids = need(ann, 'compartment_midpoint_u', 'U index of the middle of the lateral and the medial compartment')
    vv, uu = np.nonzero(valid)
    (slope_u, slope_v, icpt), *_ = np.linalg.lstsq(np.column_stack([uu, vv, np.ones(len(uu))]), gp[vv, uu], rcond=None)
    plane = slope_u * np.arange(h.shape[2])[None, :] + slope_v * np.arange(h.shape[1])[:, None] + icpt  # W of the fitted plane per (V, U)
    resid = (gp - plane)[valid]
    normal = np.array([-1.0, slope_v, slope_u])  # (w, v, u), toward the articular surface
    normal /= np.linalg.norm(normal)
    values['growth-plate-plane-rms'] = sidecar.value(
        np.sqrt(np.mean(resid**2)) * vox,
        'mm',
        'rms distance along W of the traced growth-plate face from the plane fitted to it over the ROI-1 footprint: how non-planar '
        'the face is, and so how far the heights along W and perpendicular to the plane can differ',
        kind='diagnostic',
        max_mm=float(np.abs(resid).max() * vox),
        tilt_deg=float(np.degrees(np.arccos(-normal[0]))),
    )
    height_ids = []
    rulers = {}  # object id -> line entry, on the aligned grid

    def height(key, ruler, u, deck, what):
        v = v_star
        if not (0 <= u < valid.shape[1] and 0 <= v < valid.shape[0]) or not interior[v, u]:
            sidecar.fail(
                f'{key}: U={u} on section V={v} is outside the ROI-1 footprint, or within {EDGE_ERODE} voxels of its edge, '
                'so there is no height to measure there: move that point (or height_section_v) onto the tibia'
            )
        values[key] = sidecar.value(
            local_height[v, u] * vox,
            'mm',
            f'{what}: vertical (W) distance on coronal section V={v} at U={u} from the growth-plate face '
            f'to the top of the ROI-1 surface (deck {deck}), measured along the shaft axis',
            section_v=v,
            u=int(u),
            points_uvw=[[int(u), v, float(top[v, u])], [int(u), v, float(gp[v, u])]],
        )
        length = ray_length(roi, np.array([gp[v, u], v, u]), normal)
        values[f'{key}-normal'] = sidecar.value(
            None if length is None else length * vox,
            'mm',
            f'{what}, deck {deck} measured the other way: from the traced growth-plate face at U={u}, V={v}, along the normal '
            'of the plane fitted to the face, to where it leaves ROI-1 (the top of the articular bone); null when the ray '
            'does not enter ROI-1 within 3 voxels, so check the traced face there',
            kind='diagnostic',
        )
        rulers[ruler] = objects.line([top[v, u], v, u], [gp[v, u], v, u], frame['grid_id'])  # as long as the value above
        height_ids.append(key)

    height('iioc-height', 'iioc-height-ruler', u_mid, '#7', 'IIOC height at the middle of the growth plate')
    height('iioc-height-medial-compartment', 'iioc-medial-ruler', mids['medial'], '#8', 'IIOC height, medial compartment')
    height('iioc-height-lateral-compartment', 'iioc-lateral-ruler', mids['lateral'], '#9', 'IIOC height, lateral compartment')
    values['iioc-max-local-height'] = sidecar.value(
        local_height[vmax, umax] * vox,
        'mm',
        'largest growth-plate-to-top distance along W over the eroded footprint (the old run\'s "max local height")',
        kind='diagnostic',
        section_v=int(vmax),
        u=int(umax),
    )
    width = float(np.linalg.norm((wp[1] - wp[0]) * vox))
    values['tibial-width-at-the-growth-plate'] = sidecar.value(
        width,
        'mm',
        'tibial width at the growth plate (deck #10): straight distance between '
        'the two annotated points (centre of fibula-tibia junction to the prominent point on '
        'the other side)',
        points_uvw=wp.tolist(),
    )
    rulers['tibial-width-ruler'] = objects.line(wp[0, ::-1], wp[1, ::-1], frame['grid_id'])  # [u, v, w] -> aligned (w, v, u)
    width_points_zyx = fr.to_scan_points(wp[:, ::-1], frame)  # [u, v, w] -> aligned (w, v, u) -> scan (z, y, x)
    width_points = {'grid_id': g['grid_id'], 'points': [{'name': n, 'zyx': p.tolist()} for n, p in zip(('width_a', 'width_b'), width_points_zyx)]}
    plates = {}
    for side in ('medial', 'lateral'):
        patch = ann.get('plate_patches', {}).get(side)
        half = round(plate_width_um / 2000 / vox)
        if patch is None:
            c = int(mids[side])
            patch = {'u': [c - half, c + half], 'v': [v_star - half, v_star + half]}
            for key, n, axis in (('u', h.shape[2], 'U'), ('v', h.shape[1], 'V')):
                if patch[key][0] < 0 or patch[key][1] > n:
                    sidecar.fail(f'the default {side} plate patch ({key} {patch[key][0]} to {patch[key][1]}, from the midpoint and height section) leaves the grid ({n} {axis} indices, 0 to {n}): set "plate_patches" or move the midpoint inside the grid')
        run = np.zeros(h.shape, bool)
        th = []
        for vi in range(*patch['v']):
            for ui in range(*patch['u']):
                r = first_run(bone, vi, ui)
                if r:
                    run[r[0] : r[1], vi, ui] = True
                    th.append((r[1] - r[0]) * vox)
        if not th:
            sidecar.fail(
                f'no bone in the {side} plate patch u={patch["u"]} v={patch["v"]}: move the compartment midpoint'
            )
        plates[side] = run
        values[f'subchondral-plate-{side}-first-run'] = sidecar.value(
            np.median(th),
            'mm',
            f'directional diagnostic for deck #{11 if side == "medial" else 12}: median length along W of '
            f'the first contiguous bone run below the ROI top, over {len(th)} columns of the {side} patch; trabecular '
            'bridges can lengthen a run. The sphere thickness of the run mask (plate-run.npy) is the deck value',
            kind='diagnostic',
            patch=patch,
            mean=float(np.mean(th)),
            p10_p90=np.percentile(th, [10, 90]).tolist(),
            columns=len(th),
        )
    meta = {
        'removed_disconnected_voxels': removed,
        'threshold_hu': a.threshold,
        'gp_shift_mm': a.gp_shift_mm,
        'height_section_v': v_star,
        'growth_plate_mid_u': u_mid,
        'grid_id': frame['grid_id'],
    }
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    inputs = [a.hu_aligned, a.mask, a.frame, a.annotations, a.spec]
    params = {'threshold': a.threshold, 'gp_shift_mm': a.gp_shift_mm}
    arrays = {'iioc-tissue.npy': roi, 'growth-plate-proximal-valid.npy': gp_traced}
    arrays.update({f'{s}-plate-run.npy': m for s, m in plates.items()})
    for name, arr in arrays.items():
        np.save(out / name, arr)
        sidecar.write(
            out / name,
            grid_id=frame['grid_id'],
            spacing_zyx_mm=frame['spacing_zyx_mm'],
            inputs=inputs,
            params=params,
            script='iioc.py',
        )
    meta_files = {'like': a.frame, 'inputs': inputs, 'params': params}
    placed = {  # heights are along axis 0 (W) of the aligned grid
        'roi-iioc': objects.mask(out / 'roi-iioc.npy', roi, crop=True, **meta_files),
        'growth-plate-proximal-face': objects.surface(out / 'growth-plate-proximal-face.npy', gp, 0, where=footprint(tib), **meta_files),
        'articular-surface': objects.surface(out / 'articular-top-surface.npy', np.where(valid, top, np.nan), 0, **meta_files),
        **rulers,
    }
    (out / 'width-points-scan.json').write_text(json.dumps(width_points, indent=1) + '\n')
    np.save(out / 'iioc-tissue-scan.npy', scan_roi)
    sidecar.write(
        out / 'iioc-tissue-scan.npy', like=a.hu_json, inputs=[a.hu_json, a.frame, a.mask], params=params, script='iioc.py'
    )
    qc = qc_images(out, h, roi, gp, plates, values, height_ids, v_star, vox, a.window)
    sidecar.emit_values(
        out / 'iioc.json',
        values,
        meta,
        objects=placed,
        qc=qc,
        tissue=str(out / 'iioc-tissue.npy'),
        tissue_scan=str(out / 'iioc-tissue-scan.npy'),
        width_points_scan=str(out / 'width-points-scan.json'),
        growth_plate_face=str(out / 'growth-plate-proximal-face.npy'),
        growth_plate_traced=str(out / 'growth-plate-proximal-valid.npy'),
        articular_top=str(out / 'articular-top-surface.npy'),
        plate_runs=[str(out / f'{s}-plate-run.npy') for s in plates],
        removed_disconnected_voxels=removed,
    )


QC_SECTIONS = 4  # coronal sections in qc-coronal.jpg, laid out 2 x 2
QC_MARGIN = 40  # voxels shown around the ROI and the traced face


def qc_images(out, h, roi, gp, plates, values, height_ids, v_star, vox, window):
    """qc-coronal.jpg: sections framed on ROI-1 and the traced face (ROI top minus a margin, down to the face plus a margin).

    A whole-stack panel is 1 px per voxel or less and hides a traced face that cuts 10 voxels below the growth plate, so
    every panel is framed on the ROI at the same size in voxels. qc-heights.jpg: the three heights on section `v_star`.
    """
    vr = np.flatnonzero(roi.any(axis=(0, 2)))
    vs = [int(v) for v in np.linspace(vr[0], vr[-1], QC_SECTIONS + 2)[1:-1]]
    crops = []
    for v in vs:
        us = np.flatnonzero(roi[:, v, :].any(axis=0))
        u0, u1 = max(us[0] - QC_MARGIN, 0), min(us[-1] + QC_MARGIN, h.shape[2])
        top = np.flatnonzero(roi[:, v, :].any(axis=1))[0]
        crops.append((max(top - QC_MARGIN, 0), u0, min(int(gp[v, u0:u1].max()) + QC_MARGIN, h.shape[0]), u1))
    overlays = [(roi, 'lime'), (plates['medial'], 'magenta'), (plates['lateral'], 'cyan')]
    names = ('W', 'V', 'U')
    p1 = vl.slice_sheet(out / 'qc-coronal.jpg', h, overlays, 1, vs, window, cols=2, crops=crops, axis_names=names, voxel_mm=vox,
                        curves=[[(np.arange(c[1], c[3]), gp[v, c[1] : c[3]], 'orange')] for v, c in zip(vs, crops, strict=True)],
                        titles=[f'V={v}: green ROI-1, orange growth-plate face, plate runs magenta, cyan' for v in vs])
    pts = [np.array(values[k]['points_uvw']) for k in height_ids]
    p2 = vl.slice_sheet(out / 'qc-heights.jpg', h, [(roi, 'lime')], 1, [v_star] * len(height_ids), window, axis_names=names, voxel_mm=vox,
                        curves=[[(p[:, 0], p[:, 2], 'cyan', 'o-')] for p in pts],
                        titles=[f'{k} = {values[k]["value"]:.3f} mm (V={v_star})' for k in height_ids])
    return [p1, p2]


if __name__ == '__main__':
    main()
