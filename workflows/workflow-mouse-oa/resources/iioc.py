"""Tibial secondary ossification centre (IIOC, ROI-1): the tissue region, heights, width and plate columns.

  python iioc.py --hu-aligned tibia-hu.npy --mask tibia-mask.npy --frame tibia-frame.json
         --hu-json hu.json --annotations annotations.json --out <dir> [--threshold HU] [--gp-shift-mm 0]

ROI-1 is the tibial bone between the articular surface and the proximal face of the growth plate (growth-plate
band and metaphysis excluded; marrow and cortical shell included), cut along growth-plate curves the agent traced
on coronal sections of the aligned stack. The annotation schema and the whole protocol are in ../references/oa-protocol.md.
This script writes regions and heights only: TV, BV and BV/TV of ROI-1 (deck #4-6) come from `morphometry.py volumes`.

Writes (aligned grid, array axes W,V,U) iioc-tissue.npy, growth-plate-proximal-face.npy, growth-plate-proximal-valid.npy (2D bool: where the face is traced,
not held constant past its first and last section or its curves' ends), articular-top-surface.npy (2D, W index per V,U), <side>-plate-run.npy, and on the scan grid iioc-tissue-scan.npy and width-points-scan.json (the two
width points as a points file on the scan grid, for `amira_landmarks.py`); plus iioc.json (every value, with its definition) and QC
images. Prints the result record (`microct-core/resources/sidecar.py`) with the paths.

Heights #7-9 are reported two ways until the lab chooses: along W, the tibial shaft axis (the deck values), and
perpendicular to the plane fitted to the traced growth-plate face (diagnostics `*-normal`). The plane's rms residual says
how far the traced face is from planar; where it is large, the two differ in size and in sign from one height to the next.
Plate-run bone is the ROI and aligned HU above the threshold (default: the lab's 2.16/cm in this scan's HU, from hu.json's
calibration); no label gates it.
"""

import argparse
import json
import sys
from pathlib import Path

import matplotlib
import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; the generic skills are found by walking up to the directory that holds them.
SKILLS = next((p / 'microct-analysis/skills' for p in HERE.parents
               if (p / 'microct-analysis/skills/microct-core/resources/sidecar.py').exists()), None)
if SKILLS is None:
    sys.exit('Cannot find microct-core: this script expects microct-analysis/skills/microct-core/resources/ in a '
             'directory above it (<workflows>/workflow-mouse-oa/resources/ with <workflows>/microct-analysis/ beside it)')
sys.path[:0] = [str(HERE), str(SKILLS / 'microct-core/resources'), str(SKILLS / 'regions-and-landmarks/resources')]
import frame as fr
import sidecar
from envelope import close_and_fill
from region_from_curves import surface_from_curves

matplotlib.use('Agg')
import matplotlib.pyplot as plt

MIN_COMPONENT = 50  # coronal fragments below this many pixels are segmentation specks, not bone
EDGE_ERODE = 3  # footprint erosion for the local-height search: avoids tangential edge extrema


def traced_surface(spec, key, shape):
    """W index per (V, U) from curves in region_from_curves' schema, traced on coronal sections (axis 1, height = row)."""
    if spec.get('axis') != 1 or spec.get('height', 'row') != 'row':
        sidecar.fail(f'"{key}" must be traced on coronal sections of the aligned stack: {{"axis": 1, "height": "row", "slices": '
                     '{"<v>": [[w, u], ...]}} (a point is [row = W, column = U])')
    if len(spec.get('slices', {})) < 2:
        sidecar.fail(f'"{key}" needs curves on at least two coronal sections (V indices): trace more sections')
    H, *_, valid = surface_from_curves(spec, shape)
    return H, valid


def envelope(bone, gp):
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
        result[:, v, :] = close_and_fill(plane)
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


def load_annotations(path, grid_id):
    """Annotations hold indices on one aligned grid; read them only for that grid."""
    ann = json.loads(Path(path).read_text())
    if 'grid_id' not in ann:
        sidecar.fail(f'{path} has no "grid_id": copy the grid_id of the aligned grid you traced on (tibia-frame.json) into it')
    if ann['grid_id'] != grid_id:
        sidecar.fail(f'{path} was traced on another aligned grid (grid_id differs): its indices do not apply here; trace again')
    return ann


def need(ann, key, hint):
    if key not in ann:
        sidecar.fail(f'annotations.json has no "{key}": {hint}')
    return ann[key]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--hu-aligned', required=True, help='tibia-hu.npy from tibia_frame.py')
    ap.add_argument('--mask', required=True, help='tibia-mask.npy from tibia_frame.py')
    ap.add_argument('--frame', required=True, help='tibia-frame.json from tibia_frame.py')
    ap.add_argument('--hu-json', required=True, help='hu.json of the scan: its grid, and the calibration the lab threshold in HU comes from')
    ap.add_argument('--annotations', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--threshold', type=float, help='bone threshold in HU (default: the lab threshold, 2.16/cm, from --hu-json)')
    ap.add_argument(
        '--gp-shift-mm',
        type=float,
        default=0.0,
        help='move the traced growth-plate face by this many mm (+ = toward the shaft): sensitivity run',
    )
    a = ap.parse_args()
    frame = fr.load(a.frame)
    ann = load_annotations(a.annotations, frame['grid_id'])
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
    env = envelope(tib, gp)
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

    def height(key, u, deck, what):
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
        height_ids.append(key)

    height('iioc-height', u_mid, '#7', 'IIOC height at the middle of the growth plate')
    height('iioc-height-medial-compartment', mids['medial'], '#8', 'IIOC height, medial compartment')
    height('iioc-height-lateral-compartment', mids['lateral'], '#9', 'IIOC height, lateral compartment')
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
    width_points_zyx = fr.to_scan_points(wp[:, ::-1], frame)  # [u, v, w] -> aligned (w, v, u) -> scan (z, y, x)
    width_points = {'grid_id': g['grid_id'], 'points': [{'name': n, 'zyx': p.tolist()} for n, p in zip(('width_a', 'width_b'), width_points_zyx)]}
    plates = {}
    for side in ('medial', 'lateral'):
        patch = ann.get('plate_patches', {}).get(side)
        half = round(0.25 / vox)  # deck: plate region is 500 um wide
        if patch is None:
            c = int(mids[side])
            patch = {'u': [c - half, c + half], 'v': [v_star - half, v_star + half]}
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
    inputs = [a.hu_aligned, a.mask, a.frame, a.annotations]
    params = {'threshold': a.threshold, 'gp_shift_mm': a.gp_shift_mm}
    arrays = {
        'iioc-tissue.npy': roi,
        'growth-plate-proximal-face.npy': gp.astype(np.float32),
        'growth-plate-proximal-valid.npy': gp_traced,
        'articular-top-surface.npy': np.where(valid, top, np.nan).astype(np.float32),
    }
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
    (out / 'width-points-scan.json').write_text(json.dumps(width_points, indent=1) + '\n')
    np.save(out / 'iioc-tissue-scan.npy', scan_roi)
    sidecar.write(
        out / 'iioc-tissue-scan.npy', like=a.hu_json, inputs=[a.hu_json, a.frame, a.mask], params=params, script='iioc.py'
    )
    qc = qc_images(out, h, roi, gp, plates, values, height_ids, v_star, vox)
    sidecar.emit_values(
        out / 'iioc.json',
        values,
        meta,
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
QC_MAX_PX = sidecar.MAX_IMAGE_PX - 10  # a few pixels under the view_image limit: the saved size rounds up
QC_PAD_PX = (70, 20, 45, 45, 80, 90)  # left, right, top, bottom, gap between columns, gap between rows


def qc_images(out, h, roi, gp, plates, values, height_ids, v_star, vox):
    """qc-coronal.jpg: sections framed on ROI-1 and the traced face (ROI top minus a margin, down to the face plus a margin).

    A whole-stack panel is 1 px per voxel or less and hides a traced face that cuts 10 voxels below the growth plate.
    Every panel has the same size in voxels and the figure is sized to the panels at the largest scale that fits
    `QC_MAX_PX`; the title states that scale.
    """
    vr = np.flatnonzero(roi.any(axis=(0, 2)))
    boxes = []
    for v in (int(v) for v in np.linspace(vr[0], vr[-1], QC_SECTIONS + 2)[1:-1]):
        us = np.flatnonzero(roi[:, v, :].any(axis=0))
        u0, u1 = max(us[0] - QC_MARGIN, 0), min(us[-1] + QC_MARGIN, h.shape[2])
        top = np.flatnonzero(roi[:, v, :].any(axis=1))[0]
        w0, w1 = max(top - QC_MARGIN, 0), min(int(gp[v, u0:u1].max()) + QC_MARGIN, h.shape[0])
        boxes.append((v, u0, u1, w0, w1))
    nu = max(b[2] - b[1] for b in boxes)
    nw = max(b[4] - b[3] for b in boxes)
    left, right, top_pad, bottom, gap_x, gap_y = QC_PAD_PX
    scale = min(3.0, (QC_MAX_PX - left - right - gap_x) / (2 * nu), (QC_MAX_PX - top_pad - bottom - gap_y) / (2 * nw))
    fig_w, fig_h = 2 * nu * scale + left + right + gap_x, 2 * nw * scale + top_pad + bottom + gap_y
    fig = plt.figure(figsize=(fig_w / 100, fig_h / 100), dpi=100)
    for i, (v, u0, u1, w0, w1) in enumerate(boxes):
        r, c = divmod(i, 2)
        ax = fig.add_axes((
            (left + c * (nu * scale + gap_x)) / fig_w,
            1 - (top_pad + (r + 1) * nw * scale + r * gap_y) / fig_h,
            nu * scale / fig_w,
            nw * scale / fig_h,
        ))
        lim_u, lim_w = u0 + nu, w0 + nw  # equal panel size; the frame grows toward the shaft, past the face
        u1, w1 = min(lim_u, h.shape[2]), min(lim_w, h.shape[0])
        ax.imshow(h[w0:w1, v, u0:u1], cmap='gray', vmin=0, vmax=5000, extent=(u0 - 0.5, u1 - 0.5, w1 - 0.5, w0 - 0.5), aspect='equal')
        ax.contour(np.arange(u0, u1), np.arange(w0, w1), roi[w0:w1, v, u0:u1], levels=[0.5], colors='lime', linewidths=0.6)
        ax.plot(np.arange(u0, u1), gp[v, u0:u1], color='orange', lw=0.6)
        for side, c in (('medial', 'magenta'), ('lateral', 'cyan')):
            if plates[side][w0:w1, v, u0:u1].any():
                ax.contour(np.arange(u0, u1), np.arange(w0, w1), plates[side][w0:w1, v, u0:u1], levels=[0.5], colors=[c], linewidths=0.6)
        ax.set(title=f'V={v}: green ROI-1, orange growth-plate face', xlabel='U', ylabel='W', xlim=(u0 - 0.5, lim_u - 0.5), ylim=(lim_w - 0.5, w0 - 0.5))
        ax.grid(alpha=0.15)
    fig.suptitle(f'{scale:.2f} px per voxel: 0.1 mm = {0.1 / vox * scale:.0f} px', y=1 - 8 / fig_h, fontsize=10)
    p1 = out / 'qc-coronal.jpg'
    sidecar.save_image(fig, p1)
    plt.close(fig)
    fig, axs = plt.subplots(1, 3, figsize=(18, 7))
    for k, ax in zip(height_ids, axs):
        pts = np.array(values[k]['points_uvw'])
        ax.imshow(h[:, v_star, :], cmap='gray', vmin=0, vmax=5000)
        ax.contour(roi[:, v_star, :], levels=[0.5], colors='lime', linewidths=0.7)
        ax.plot(pts[:, 0], pts[:, 2], 'o-', color='cyan')
        ax.set(title=f'{k} = {values[k]["value"]:.3f} mm (V={v_star})', xlabel='U', ylabel='W')
    fig.tight_layout()
    p2 = out / 'qc-heights.jpg'
    sidecar.save_image(fig, p2)
    plt.close(fig)
    return [str(p1), str(p2)]


if __name__ == '__main__':
    main()
