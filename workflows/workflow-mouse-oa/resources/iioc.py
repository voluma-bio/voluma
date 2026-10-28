"""Tibial secondary ossification centre (IIOC, ROI-1): tissue region, TV/BV/BV/TV, heights, width, plate columns.

  python iioc.py --hu-aligned tibia-hu.npy --mask tibia-mask.npy --frame tibia-frame.json
         --hu hu.npy --hu-json hu.json --annotations annotations.json --out <dir> [--threshold HU] [--gp-shift-voxels 0]

ROI-1 is the tibial bone between the articular surface and the proximal face of the growth plate (growth-plate
band and metaphysis excluded; marrow and cortical shell included), cut along growth-plate curves the agent traced
on coronal sections of the aligned stack (see ../SKILL.md for the annotation schema). TV and BV are counted on the
scan grid: the aligned region is mapped back with nearest-neighbour and thresholded on unresampled HU.

Writes (aligned grid, array axes W,V,U) iioc-tissue.npy, iioc-bone.npy, growth-plate-proximal-face.npy,
articular-top-surface.npy (2D, W index per V,U), <side>-plate-run.npy, and on the scan grid iioc-tissue-scan.npy and
width-points-scan.json (the two width points as [z, y, x] scan indices, for `amira_landmarks.py`); plus iioc.json (every
value, with its definition) and QC images. Prints one JSON line.

Bone is the ROI and unresampled HU above the threshold (default: the lab's 2.16/cm in this scan's HU, from hu.json's
calibration); no label gates it. BV/TV is in %. Heights are measured along W, the tibial shaft axis; `shaft_to_growth_plate_normal_deg`
says how far that is from perpendicular to the growth-plate face.
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

matplotlib.use('Agg')
import matplotlib.pyplot as plt

MIN_COMPONENT = 50  # coronal fragments below this many pixels are segmentation specks, not bone
EDGE_ERODE = 3  # footprint erosion for the local-height search: avoids tangential edge extrema


def boundary_surface(curves, shape_vu):
    """W index per (V, U) from curves {"<v>": [[u, w], ...]}: linear in U along each curve, linear in V between."""
    if len(curves) < 2:
        sidecar.fail('a boundary needs curves on at least two coronal sections (V indices): trace more sections')
    levels = sorted(map(int, curves))
    rows = []
    for v in levels:
        pts = np.array(curves[str(v)], float)
        if len(pts) < 2 or np.any(np.diff(pts[:, 0]) <= 0):
            sidecar.fail(f'curve at V={v} needs at least two [u, w] points with strictly increasing u')
        rows.append(np.interp(np.arange(shape_vu[1]), pts[:, 0], pts[:, 1]))
    rows = np.array(rows)
    return np.array([np.interp(np.arange(shape_vu[0]), levels, rows[:, u]) for u in range(shape_vu[1])]).T


def envelope(bone, gp, iterations=2):
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
        closed = ndi.binary_closing(plane, iterations=iterations) | plane
        result[:, v, :] = ndi.binary_fill_holes(closed)
    result = ndi.binary_fill_holes(ndi.binary_closing(result, iterations=1) | result)
    for u in range(bone.shape[2]):
        result[:, :, u] = ndi.binary_fill_holes(result[:, :, u])
    return result


def to_scan(mask, frame, scan_shape):
    """Nearest-neighbour map of an aligned-grid mask onto the scan grid."""
    inv = np.array(frame['output_xyz_to_original_xyz_matrix']).T
    off = np.array(frame['output_xyz_to_original_xyz_offset'])
    return ndi.affine_transform(
        mask.astype(np.uint8), inv[::-1, ::-1], (-inv @ off)[::-1], output_shape=scan_shape, order=0, prefilter=False
    ).astype(bool)


def largest(mask):
    cc, _ = ndi.label(mask)
    n = np.bincount(cc.ravel())
    n[0] = 0
    return cc == n.argmax(), int(mask.sum() - n.max())


def first_run(bone, v, u):
    ww = np.flatnonzero(bone[:, v, u])
    if not len(ww):
        return None
    start = end = int(ww[0])
    while end < bone.shape[0] and bone[end, v, u]:
        end += 1
    return start, end


def need(ann, key, hint):
    if key not in ann:
        sidecar.fail(f'annotations.json has no "{key}": {hint}')
    return ann[key]


def val(value, unit, definition, **extra):
    return dict(value=float(value), unit=unit, definition=definition, **extra)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--hu-aligned', required=True, help='tibia-hu.npy from tibia_frame.py')
    ap.add_argument('--mask', required=True, help='tibia-mask.npy from tibia_frame.py')
    ap.add_argument('--frame', required=True, help='tibia-frame.json from tibia_frame.py')
    ap.add_argument('--hu', required=True, help='hu.npy of the scan: TV and BV are counted on this grid')
    ap.add_argument('--hu-json', required=True, help='hu.json of the scan')
    ap.add_argument('--annotations', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--threshold', type=float, help='bone threshold in HU (default: the lab threshold, 2.16/cm, from --hu-json)')
    ap.add_argument(
        '--gp-shift-voxels',
        type=float,
        default=0.0,
        help='move the traced growth-plate face by this many voxels (+ = toward the shaft): sensitivity run',
    )
    a = ap.parse_args()
    ann = json.loads(Path(a.annotations).read_text())
    frame = json.loads(Path(a.frame).read_text())
    g = sidecar.grid(a.hu_json)
    a.threshold = sidecar.bone_threshold_hu(a.hu_json, a.threshold)
    vox = frame['spacing_zyx_mm'][0]
    h = np.load(a.hu_aligned, mmap_mode='r')
    tib = np.load(a.mask)
    if frame['parent_grid_id'] != g['grid_id']:
        sidecar.fail('the frame was made on another scan grid than hu.json: rerun tibia_frame.py on this scan')
    shape_vu = h.shape[1:]
    gp = (
        boundary_surface(need(ann, 'growth_plate_curves', 'trace the proximal face of the growth plate'), shape_vu)
        + a.gp_shift_voxels
    )
    env = envelope(tib, gp)
    w = np.arange(h.shape[0])[:, None, None]
    roi = env & (w < gp[None])
    for fix in ann.get('articular_corrections', []):
        surf = boundary_surface(fix['curves'], shape_vu)
        ulo, uhi = fix['u_range']
        vlo, vhi = fix['v_range']
        keep = np.ones(h.shape, bool)
        keep[:, vlo:vhi, ulo:uhi] = w >= surf[None, vlo:vhi, ulo:uhi]
        roi &= keep
    roi, removed = largest(roi)
    bone = roi & (np.asarray(h) > a.threshold)
    raw = np.load(a.hu, mmap_mode='r')
    scan_roi = to_scan(roi, frame, raw.shape)
    tv = int(scan_roi.sum()) * vox**3
    bv = int(np.count_nonzero(raw[scan_roi] > a.threshold)) * vox**3
    values = {
        'iioc_tv': val(
            tv,
            'mm^3',
            'ROI-1 tissue volume (deck #4): bone, marrow and cortical shell between the articular '
            'surface and the traced proximal growth-plate face; counted on the scan grid',
        ),
        'iioc_bv': val(
            bv, 'mm^3', f'ROI-1 bone volume (deck #5): unresampled scan HU > {a.threshold} inside the same ROI'
        ),
        'iioc_bv_tv': val(bv / tv * 100, '%', 'ROI-1 BV/TV in % (deck #6); whole-IIOC, includes shell and plate'),
    }
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

    def height(key, u, deck, what):
        v = v_star
        if not (0 <= u < valid.shape[1] and 0 <= v < valid.shape[0]) or not interior[v, u]:
            sidecar.fail(
                f'{key}: U={u} on section V={v} is outside the ROI-1 footprint, or within {EDGE_ERODE} voxels of its edge, '
                'so there is no height to measure there: move that point (or height_section_v) onto the tibia'
            )
        values[key] = val(
            local_height[v, u] * vox,
            'mm',
            f'{what}: vertical (W) distance on coronal section V={v} at U={u} from the growth-plate face '
            f'to the top of the ROI-1 surface (deck {deck})',
            section_v=v,
            u=int(u),
            points_uvw=[[int(u), v, float(top[v, u])], [int(u), v, float(gp[v, u])]],
            voxel_mm=vox,
        )

    height('iioc_height', u_mid, '#7', 'IIOC height at the middle of the growth plate')
    height('iioc_height_medial', mids['medial'], '#8', 'IIOC height, medial compartment')
    height('iioc_height_lateral', mids['lateral'], '#9', 'IIOC height, lateral compartment')
    values['iioc_max_local_height'] = val(
        local_height[vmax, umax] * vox,
        'mm',
        'diagnostic: largest growth-plate-to-top distance over the eroded footprint (not a deck parameter)',
        section_v=int(vmax),
        u=int(umax),
    )
    vv, uu = np.nonzero(valid)
    slope_u, slope_v, _ = np.linalg.lstsq(np.column_stack([uu, vv, np.ones(len(uu))]), gp[vv, uu], rcond=None)[0]
    values['shaft_to_growth_plate_normal_deg'] = val(
        np.degrees(np.arccos(1 / np.sqrt(1 + slope_u**2 + slope_v**2))),
        'deg',
        'angle between the tibial shaft axis (W) and the normal of the plane fitted to the traced growth-plate face over the '
        'ROI-1 footprint: 0 means "along the shaft" and "perpendicular to the growth plate" are the same direction for heights #7-9',
    )
    width = float(np.linalg.norm((wp[1] - wp[0]) * vox))
    values['tibial_width'] = val(
        width,
        'mm',
        'tibial width at the growth plate (deck #10): straight distance between '
        'the two annotated points (centre of fibula-tibia junction to the prominent point on '
        'the other side)',
        points_uvw=wp.tolist(),
    )
    basis = np.array(frame['output_xyz_to_original_xyz_matrix'])
    origin_xyz = np.array(frame['output_xyz_to_original_xyz_offset'])
    width_points_zyx = {
        name: (basis @ p + origin_xyz)[::-1].tolist() for name, p in zip(('width_a', 'width_b'), wp, strict=True)
    }
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
        values[f'subchondral_plate_{side}_first_run'] = val(
            np.median(th),
            'mm',
            f'directional diagnostic for deck #{11 if side == "medial" else 12}: median length along W of '
            f'the first contiguous bone run below the ROI top, over {len(th)} columns of the {side} patch; trabecular '
            'bridges can lengthen a run. The sphere thickness of the run mask (plate-run.npy) is the deck value',
            patch=patch,
            mean=float(np.mean(th)),
            p10_p90=np.percentile(th, [10, 90]).tolist(),
            columns=len(th),
            voxel_mm=vox,
        )
    meta = {
        'removed_disconnected_voxels': removed,
        'threshold_hu': a.threshold,
        'gp_shift_voxels': a.gp_shift_voxels,
        'aligned_bv_tv_percent': float(bone.sum() / roi.sum() * 100),
        'height_section_v': v_star,
        'growth_plate_mid_u': u_mid,
    }
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    inputs = [a.hu_aligned, a.mask, a.frame, a.annotations]
    params = {'threshold': a.threshold, 'gp_shift_voxels': a.gp_shift_voxels}
    arrays = {
        'iioc-tissue.npy': roi,
        'iioc-bone.npy': bone,
        'growth-plate-proximal-face.npy': gp.astype(np.float32),
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
    (out / 'width-points-scan.json').write_text(json.dumps(width_points_zyx, indent=1) + '\n')
    np.save(out / 'iioc-tissue-scan.npy', scan_roi)
    sidecar.write(
        out / 'iioc-tissue-scan.npy', like=a.hu_json, inputs=[a.hu, a.frame, a.mask], params=params, script='iioc.py'
    )
    (out / 'iioc.json').write_text(
        json.dumps({'values': values, 'meta': meta, 'grid_id': frame['grid_id']}, indent=1) + '\n'
    )
    qc = qc_images(out, h, roi, gp, plates, values, v_star)
    sidecar.emit(
        out=str(out / 'iioc.json'),
        qc=qc,
        tissue=str(out / 'iioc-tissue.npy'),
        tissue_scan=str(out / 'iioc-tissue-scan.npy'),
        width_points_scan=str(out / 'width-points-scan.json'),
        growth_plate_face=str(out / 'growth-plate-proximal-face.npy'),
        articular_top=str(out / 'articular-top-surface.npy'),
        plate_runs=[str(out / f'{s}-plate-run.npy') for s in plates],
        values={k: round(v['value'], 5) for k, v in values.items()},
        removed_disconnected_voxels=removed,
    )


def qc_images(out, h, roi, gp, plates, values, v_star):
    vs = [
        int(v)
        for v in np.linspace(np.flatnonzero(roi.any(axis=(0, 2)))[0], np.flatnonzero(roi.any(axis=(0, 2)))[-1], 8)[1:-1]
    ][:6]
    fig, axs = plt.subplots(2, 3, figsize=(18, 11))
    for v, ax in zip(vs, axs.flat):
        ax.imshow(h[:, v, :], cmap='gray', vmin=0, vmax=5000)
        ax.contour(roi[:, v, :], levels=[0.5], colors='lime', linewidths=0.8)
        ax.plot(np.arange(h.shape[2]), gp[v], color='orange', lw=0.8)
        for side, c in (('medial', 'magenta'), ('lateral', 'cyan')):
            if plates[side][:, v, :].any():
                ax.contour(plates[side][:, v, :], levels=[0.5], colors=[c], linewidths=0.8)
        ax.set(title=f'V={v}: green ROI-1, orange growth-plate face', xlabel='U', ylabel='W')
        ax.grid(alpha=0.15)
    fig.tight_layout()
    p1 = out / 'qc-coronal.jpg'
    sidecar.save_image(fig, p1)
    plt.close(fig)
    fig, axs = plt.subplots(1, 3, figsize=(18, 7))
    keys = ['iioc_height', 'iioc_height_medial', 'iioc_height_lateral']
    for k, ax in zip(keys, axs):
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
