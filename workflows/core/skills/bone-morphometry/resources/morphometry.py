"""Measure a region of interest: the one owner of TV, BV and BV/TV, plus trabecular and cortical thickness.

  volumes      TV, BV, BV/TV of a region
  trabecular   the same three, plus Tb.Th, Tb.Sp, Tb.N (and with --skeleton, Tb.Nd and Tb.Tm), a QC image, thickness maps
  cortical     Ct.Th: largest-contained-sphere thickness of a cortical mask, in a slab at a depth below a surface

Bone is the region and `--hu` above the bone threshold, with no label gate: `--threshold` in HU, else the lab's 2.16/cm
converted with the calibration in `--hu-json` (the scan's hu.json). `--roi`, `--hu` and `--grid` (default: the region's own
sidecar) must be on one grid; the volumes are counted on it. Lengths in mm (cortical depth, slab and context in um), volumes
in mm³, BV/TV in %, densities in 1/mm³. Thickness needs isotropic voxels. Each value is written under the output id the
caller gives with `--id KEY=output-id` (repeatable; the keys are printed by `<command> --help`), else under KEY. The record
format is in `microct-core/resources/sidecar.py`. Methods: ../SKILL.md. Refused: a mask that is not bool, an empty ROI, an ROI
holding only bone or only marrow, HU on another grid than the region, anisotropic voxels (thickness).

Writes: volumes: <out>/volumes.json; trabecular: <out>/morphometry.json, qc.jpg, thickness-mm.npy and separation-mm.npy
        (the ROI's bounding box on the region's grid, `offset_zyx` in their sidecars, mm); cortical: <out>/<name>.json,
        qc-<name>.jpg and slab-<name>.npy (the slab measured, cropped, as an object: see `microct-core/resources/objects.py`).
        The json is the result record {values: {id: {value, unit, definition, kind}}, grid_id, inputs, ...}; cortical adds `objects` (the slab, under `--object-id`)
Prints: one JSON line {out, values: {id: {value, unit, definition, kind}}}; trabecular adds {qc, thickness, separation}, cortical {qc}
Example: python morphometry.py trabecular --roi roi.npy --hu hu.npy --hu-json hu.json --out out/roi2 --id BV/TV=BVTV-roi2
Exits 2 with one sentence on bad input, before writing anything.
"""

import argparse
import warnings
from pathlib import Path

import matplotlib
import numpy as np
import objects
import sidecar
from scipy import ndimage as ndi

matplotlib.use('Agg')
import matplotlib.pyplot as plt


def local_thickness(phase, step=0.5):
    """Diameter, in voxels, of the largest sphere contained in `phase` that covers each voxel (0 outside).

    Distances use voxel centres and the phase is padded with background, so a phase cut by the array edge or by
    an ROI is measured as if solid ends there. Radii are quantised at `step` voxels, so a diameter is a whole number of
    voxels and a structure an odd number of voxels wide reads one voxel high (a 1-voxel plate reads 2, 3 reads 4; even
    widths read exactly; +9% on OA6-1RK ROI-3 against the same mask upsampled 2x). Report the voxel size with every
    thickness. This is not the mean of twice the distance transform.
    """
    phase = np.pad(np.asarray(phase, dtype=bool), 1)
    if not phase.any():
        raise ValueError('empty phase')
    dt = ndi.distance_transform_edt(phase)
    radii = np.arange(1, np.floor(dt.max() / step) * step + step / 2, step)[::-1]
    result = np.zeros(phase.shape, np.float32)
    for r in radii:
        centers = dt >= r
        if not centers.any():
            continue
        covered = ndi.distance_transform_edt(~centers) < r
        result[(result == 0) & phase & covered] = 2 * r
    return result[1:-1, 1:-1, 1:-1]


def skeleton_counts(bone, roi, margin):
    """Tb.Nd and Tb.Tm from the 3D skeleton of `bone` (a crop), with and without voxels near the ROI edge.

    A skeleton voxel with 1 neighbour (26-connectivity) is an end; voxels with >=3 neighbours are junction voxels,
    and a connected cluster of them is one node. ROI clipping cuts struts, so ends and nodes within `margin`
    voxels of the ROI boundary are counted separately and left out of the interior counts; `interior_voxels` is the
    part of the ROI those counts come from, and the density divides by it.
    """
    from skimage.morphology import skeletonize

    sk = skeletonize(bone)
    nb = ndi.convolve(sk.astype(np.uint8), np.ones((3, 3, 3), np.uint8), mode='constant') - 1
    nb = np.where(sk, nb, 0)
    ends = nb == 1
    junction = nb >= 3
    node_lab, n_nodes = ndi.label(junction, structure=np.ones((3, 3, 3)))
    interior = ndi.distance_transform_edt(np.pad(roi, 1))[1:-1, 1:-1, 1:-1] > margin
    node_ids = np.arange(1, n_nodes + 1)
    node_inside = (
        np.array(ndi.minimum(interior.astype(np.uint8), node_lab, node_ids)).astype(bool)
        if n_nodes
        else np.zeros(0, bool)
    )
    return {
        'interior_voxels': int((interior & roi).sum()),
        'skeleton_voxels': int(sk.sum()),
        'nodes_all': int(n_nodes),
        'nodes_interior': int(node_inside.sum()),
        'ends_all': int(ends.sum()),
        'ends_interior': int((ends & interior).sum()),
        'skeleton': sk,
    }


def load_bool(path, name):
    a = np.load(path, mmap_mode='r')
    if a.dtype != bool:
        sidecar.fail(f'{name} {path} is {a.dtype}, not bool: pass a boolean mask (e.g. labels == 3 saved as .npy)')
    return np.asarray(a)


def crop_box(mask, pad=0):
    sl = ndi.find_objects(mask.astype(np.uint8))
    if not sl:
        sidecar.fail('the region mask is empty: nothing to measure')
    return tuple(slice(max(s.start - pad, 0), min(s.stop + pad, n)) for s, n in zip(sl[0], mask.shape))


def write_crop_map(path, arr, parent_grid, spacing, box, inputs, params):
    np.save(path, arr)
    sidecar.write(
        path,
        grid_id=parent_grid,
        spacing_zyx_mm=spacing,
        inputs=inputs,
        params=dict(params, unit='mm'),
        offset_zyx=[s.start for s in box],
    )


TRAB_KEYS = ('TV', 'BV', 'BV/TV', 'Tb.Th', 'Tb.Sp', 'Tb.N', 'Tb.Nd', 'Tb.Tm', 'Nd/Tm')
VOLUME_KEYS = TRAB_KEYS[:3]


def output_ids(items, keys):
    ids = {k: k for k in keys}
    for item in items or []:
        key, _, new = item.partition('=')
        if key not in ids or not new:
            sidecar.fail(f'--id {item!r}: write KEY=output-id, with KEY one of {list(keys)}')
        ids[key] = new
    return ids


def load_region(a):
    """The one BV rule: bone = region and HU above the threshold. Returns grid, ROI, HU, bone, threshold."""
    g = sidecar.grid(a.grid or sidecar.sidecar_path(a.roi))
    hu_grid = sidecar.grid(sidecar.sidecar_path(a.hu))
    if hu_grid['grid_id'] != g['grid_id']:
        sidecar.fail(f'{a.hu} is on another grid than the region ({a.grid or a.roi}): pass the HU array of the grid the region was made on '
                     '(tibia-hu.npy for a region traced on the aligned stack, hu.npy for one on the scan grid)')
    roi = load_bool(a.roi, 'ROI')
    hu = np.load(a.hu, mmap_mode='r')
    if hu.shape != roi.shape:
        sidecar.fail(f'hu shape {hu.shape} differs from ROI shape {roi.shape}: they must be on the same grid')
    threshold = sidecar.bone_threshold_hu(a.hu_json, a.threshold)
    return g, roi, hu, roi & (np.asarray(hu) > threshold), threshold


def volume_values(roi, bone, sp, threshold, ids, region):
    tv = float(roi.sum() * np.prod(sp))
    bv = float(bone.sum() * np.prod(sp))
    values = {
        ids['TV']: sidecar.value(tv, 'mm³', f'{region} tissue volume: ROI voxel count x voxel volume'),
        ids['BV']: sidecar.value(bv, 'mm³', f'{region} bone volume: ROI voxels with HU > {threshold:g} x voxel volume'),
        ids['BV/TV']: sidecar.value(bv / tv * 100, '%', f'{region} BV / TV'),
    }
    return values, tv, bv


def volumes(a):
    ids = output_ids(a.id, VOLUME_KEYS)
    g, roi, _, bone, threshold = load_region(a)
    sp = np.array(g['spacing_zyx_mm'], float)
    values, _, _ = volume_values(roi, bone, sp, threshold, ids, a.region)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sidecar.emit_values(out / 'volumes.json', values, meta={
        'grid_id': g['grid_id'], 'spacing_zyx_mm': g['spacing_zyx_mm'], 'threshold_hu': threshold,
        'inputs': {str(q): sidecar.sha256_file(q) for q in (a.roi, a.hu)}})


def trabecular(a):
    ids = output_ids(a.id, TRAB_KEYS)
    g, roi, hu, bone, threshold = load_region(a)
    sp = np.array(g['spacing_zyx_mm'], float)
    if not np.allclose(sp, sp[0], rtol=1e-3):
        sidecar.fail(
            f'spacing {sp.tolist()} mm is not isotropic: sphere thickness needs isotropic voxels; resample first'
        )
    vox = float(sp[0])
    inputs = [a.roi, a.hu]
    marrow = roi & ~bone
    if not bone.any() or not marrow.any():
        sidecar.fail('the ROI holds only bone or only marrow at this threshold: check the threshold and the ROI')
    box = crop_box(roi)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    th_vox = local_thickness(bone[box])
    sp_vox = local_thickness(marrow[box])
    th, sep = th_vox * vox, sp_vox * vox
    values, tv, bv = volume_values(roi, bone, sp, threshold, ids, a.region)
    frac = bv / tv
    tbth = float(th[bone[box]].mean())
    tbsp = float(sep[marrow[box]].mean())
    values.update({
        ids['Tb.Th']: sidecar.value(tbth, 'mm', 'mean diameter of the largest sphere inside bone covering each bone voxel'),
        ids['Tb.Sp']: sidecar.value(
            tbsp,
            'mm',
            'mean diameter of the largest sphere inside marrow covering each marrow voxel; '
            'the space outside the ROI does not count as marrow',
        ),
        ids['Tb.N']: sidecar.value(frac / tbth, '1/mm', 'model-derived (BV/TV)/Tb.Th (Bouxsein 2010), not a direct count of struts'),
        'voxel-size': sidecar.value(vox, 'mm', 'voxel edge: every thickness here is a whole number of voxels, and reads one voxel high for odd widths',
                                    kind='diagnostic'),
    })
    maps = {'thickness': out / 'thickness-mm.npy', 'separation': out / 'separation-mm.npy'}
    p = {'threshold': threshold, 'step': 0.5}
    write_crop_map(maps['thickness'], th.astype(np.float32), g['grid_id'], g['spacing_zyx_mm'], box, inputs, p)
    write_crop_map(maps['separation'], sep.astype(np.float32), g['grid_id'], g['spacing_zyx_mm'], box, inputs, p)

    sk, counts = None, {}
    if a.skeleton:
        c = skeleton_counts(bone[box], roi[box], round(a.edge_margin_mm / vox, 6))
        sk = c.pop('skeleton')
        n_in = c['nodes_interior']
        e_in = c['ends_interior']
        tv_in = c['interior_voxels'] * vox**3
        where = (
            f'counted in the part of the ROI farther than {a.edge_margin_mm:g} mm from its edge '
            f'({tv_in:.5f} mm³ of {tv:.5f}), per mm³ of that tissue volume; not validated against Scanco'
        )
        values[ids['Tb.Nd']] = sidecar.value(
            n_in / tv_in,
            '1/mm³',
            'junction clusters (skeleton voxels with >=3 neighbours, 26-connected clusters merged) ' + where,
        )
        values[ids['Tb.Tm']] = sidecar.value(e_in / tv_in, '1/mm³', 'skeleton end voxels (1 neighbour) ' + where)
        values[ids['Nd/Tm']] = sidecar.value(n_in / e_in if e_in else None, '1', 'Tb.Nd / Tb.Tm (null when there are no ends)',
                                             kind='diagnostic')
        values['node-count'] = sidecar.value(n_in, '1', 'nodes in the counted volume', kind='diagnostic')
        values['end-count'] = sidecar.value(e_in, '1', 'ends in the counted volume', kind='diagnostic')
        values['skeleton-counted-volume'] = sidecar.value(
            tv_in, 'mm³', 'part of the ROI the node and end counts come from, which they are divided by', kind='diagnostic')
        counts = c

    qc = out / 'qc.jpg'
    qc_figure(qc, a, hu, roi, bone, th, sep, box, sk, values)
    sidecar.emit_values(
        out / 'morphometry.json',
        values,
        meta={
            'grid_id': g['grid_id'],
            'spacing_zyx_mm': g['spacing_zyx_mm'],
            'inputs': {str(q): sidecar.sha256_file(q) for q in inputs + [a.grid or sidecar.sidecar_path(a.roi)]},
            'threshold_hu': threshold,
            'skeleton_counts': counts,
            'crop_slices_zyx': [[s.start, s.stop] for s in box],
        },
        qc=str(qc),
        thickness=str(maps['thickness']),
        separation=str(maps['separation']),
    )


def qc_figure(path, a, hu, roi, bone, th, sep, box, sk, values):
    axis = a.qc_axis
    lo, hi = box[axis].start, box[axis].stop
    idx = [int(lo + (hi - lo) * f) for f in (0.25, 0.5, 0.75)]
    other = [i for i in range(3) if i != axis]
    sl2 = tuple(box[i] for i in other)
    r0, r1, c0, c1 = box[other[0]].start, box[other[0]].stop, box[other[1]].start, box[other[1]].stop
    extent = (c0, c1, r1, r0)
    rows, cols = np.arange(r0, r1), np.arange(c0, c1)

    def cut(i):
        t = [slice(None)] * 3
        t[axis] = i
        return tuple(t)

    fig, axs = plt.subplots(4, 2, figsize=(14, 17))
    for ax, i in zip(axs.flat[:3], idx):
        t = cut(i)
        img = np.asarray(hu[t])[sl2]
        ax.imshow(img, cmap='gray', extent=extent)
        for m, c in ((roi, 'cyan'), (bone, 'orange')):
            if m[t][sl2].any():
                ax.contour(cols, rows, m[t][sl2], levels=[0.5], colors=c, linewidths=0.7)
        ax.set_title(f'axis {axis} index {i}: ROI cyan, bone orange')
    t = cut(idx[1] - lo)
    ax = axs.flat[3]
    if sk is not None:
        ax.imshow(bone[box][t], cmap='gray', extent=extent)
        pts = np.argwhere(sk[t])
        ax.scatter(pts[:, 1] + c0, pts[:, 0] + r0, s=2, c='red')
        ax.set_title(f'skeleton (red) on bone, index {idx[1]}')
    else:
        ax.axis('off')
    for ax, arr, m, name in ((axs.flat[4], th, bone[box], 'Tb.Th'), (axs.flat[5], sep, (roi & ~bone)[box], 'Tb.Sp')):
        im = ax.imshow(np.where(m[t], arr[t] * 1000, np.nan), cmap='viridis', vmin=0, extent=extent)
        fig.colorbar(im, ax=ax, label='um', fraction=0.04)
        ax.set_title(f'{name} map, index {idx[1]}')
    for ax in axs.flat[6:]:
        ax.axis('off')
    axs.flat[6].text(
        0,
        1,
        '\n'.join(f'{k}: {v["value"]:.4g} {v["unit"]}' if v['value'] is not None else f'{k}: -' for k, v in values.items()),
        va='top',
        family='monospace',
        fontsize=11,
    )
    fig.tight_layout()
    sidecar.save_image(fig, path)
    plt.close(fig)


def cortical(a):
    g = sidecar.grid(a.grid)
    sp = np.array(g['spacing_zyx_mm'], float)
    if not np.allclose(sp, sp[0], rtol=1e-3):
        sidecar.fail(
            f'spacing {sp.tolist()} mm is not isotropic: sphere thickness needs isotropic voxels; resample first'
        )
    vox = float(sp[0])
    cortex = load_bool(a.cortex, 'cortical mask')
    surf = np.load(a.surface)
    ax = a.axis
    other = [i for i in range(3) if i != ax]
    if surf.shape != tuple(cortex.shape[i] for i in other):
        sidecar.fail(
            f'surface shape {surf.shape} must be the mask shape without axis {ax}: '
            f'{tuple(cortex.shape[i] for i in other)}'
        )
    depth_vox = a.depth_um / 1000 / vox
    half = max(a.slab_um / 1000 / vox / 2, 0.5)
    coord = np.arange(cortex.shape[ax]).reshape([-1 if i == ax else 1 for i in range(3)])
    s = np.expand_dims(surf, ax)
    d = (coord - s) * a.direction  # depth in voxels below the surface, along `direction`
    slab = cortex & (np.abs(d - depth_vox) <= half) & np.isfinite(s)
    if not slab.any():
        sidecar.fail(f'no cortical voxels at {a.depth_um} um below the surface: check --axis, --direction and the mask')
    # Spheres are measured on the cortex within `context` of the slab along the axis, not the whole bone: the walls
    # are thinner than the context, so a sphere never reaches the cut face, and the run takes seconds not minutes.
    context = int(np.ceil(a.context_um / 1000 / vox))
    box = list(crop_box(slab))
    box[ax] = slice(max(box[ax].start - context, 0), min(box[ax].stop + context, cortex.shape[ax]))
    box = tuple(box)
    th = local_thickness(cortex[box]) * vox
    t = th[slab[box]]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    values = {
        a.name: sidecar.value(
            t.mean(),
            'mm',
            f'mean diameter of the largest sphere inside the cortical mask, over cortical '
            f'voxels within {a.slab_um} um of {a.depth_um} um below the reference surface (axis {ax})',
            std=float(t.std()),
            median=float(np.median(t)),
            n_voxels=int(t.size),
        ),
        'voxel-size': sidecar.value(vox, 'mm', 'voxel edge: thickness is a whole number of voxels, and reads one voxel high for odd widths',
                                    kind='diagnostic'),
    }
    qc = out / f'qc-{a.name}.jpg'
    fig, axs = plt.subplots(1, 2, figsize=(14, 7))
    tfull = np.full(cortex.shape, np.nan, np.float32)
    tfull[box] = th
    tslab = np.where(slab, tfull, np.nan)
    # Both panels project along the axis: the slab follows the reference surface, so it is not one slice.
    axs[0].imshow(cortex.any(axis=ax), cmap='gray')
    axs[0].imshow(np.where(slab.any(axis=ax), 1.0, np.nan), cmap='autumn', alpha=0.6)
    axs[0].set_title(f'cortical mask seen along axis {ax}; slab in red')
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')  # all-NaN columns are the empty parts of the projection
        proj = np.nanmean(tslab, axis=ax) * 1000
    im = axs[1].imshow(proj, cmap='viridis', vmin=0)
    fig.colorbar(im, ax=axs[1], label='um')
    axs[1].set_title(f'{a.name} = {values[a.name]["value"] * 1000:.1f} um (slab mean; map = mean along axis {ax}); object {a.object_id}')
    fig.tight_layout()
    sidecar.save_image(fig, qc)
    plt.close(fig)
    slab_entry = objects.mask(out / f'slab-{a.name}.npy', slab, like=a.grid, crop=True)  # the voxels the thickness was read from
    sidecar.emit_values(
        out / f'{a.name}.json',
        values,
        meta={
            'grid_id': g['grid_id'],
            'spacing_zyx_mm': g['spacing_zyx_mm'],
            'inputs': {str(q): sidecar.sha256_file(q) for q in (a.cortex, a.surface, a.grid)},
        },
        qc=str(qc),
        objects={a.object_id: slab_entry},
    )


def main():
    ap = sidecar.parser(__doc__)
    sub = ap.add_subparsers(dest='cmd', required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--roi', type=sidecar.existing, required=True, help='bool .npy: the region measured')
    common.add_argument('--hu', type=sidecar.existing, required=True, help='HU array on the region\'s grid (hu.npy for a scan-grid region, the aligned stack\'s HU otherwise): bone = HU above the threshold')
    common.add_argument('--hu-json', type=sidecar.existing, help='the scan\'s hu.json: the lab threshold in HU comes from its calibration (not needed with --threshold)')
    common.add_argument('--threshold', type=float, help='bone threshold in HU (default: the lab threshold, 2.16/cm, from --hu-json)')
    common.add_argument('--grid', type=sidecar.existing, help='sidecar of the grid the region and --hu are on (default: the region\'s own)')
    common.add_argument('--region', default='ROI', help='name of the region in the value definitions')
    common.add_argument('--out', required=True, help='output directory (created)')
    fmt = sidecar.HelpFormatter
    v = sub.add_parser('volumes', parents=[common], formatter_class=fmt, help='TV, BV, BV/TV of a region',
                       description='TV, BV and BV/TV of a region (mm³, mm³, %). Writes <out>/volumes.json.')
    v.add_argument('--id', action='append', metavar='KEY=ID', help=f'output id for KEY in {list(VOLUME_KEYS)} (repeatable)')
    v.set_defaults(fn=volumes)
    t = sub.add_parser('trabecular', parents=[common], formatter_class=fmt, help='TV, BV, BV/TV, Tb.Th, Tb.Sp, Tb.N [, Tb.Nd, Tb.Tm] in an ROI',
                       description='TV, BV, BV/TV, Tb.Th, Tb.Sp, Tb.N [, Tb.Nd, Tb.Tm] of an ROI, a QC image and the thickness and separation maps. '
                       'Writes <out>/morphometry.json, qc.jpg, thickness-mm.npy, separation-mm.npy.')
    t.add_argument('--id', action='append', metavar='KEY=ID', help=f'output id for KEY in {list(TRAB_KEYS)} (repeatable)')
    t.add_argument('--skeleton', action='store_true', help='also count nodes (Tb.Nd) and ends (Tb.Tm)')
    t.add_argument(
        '--edge-margin-mm', type=float, default=0.0315, help='mm: skeleton points this close to the ROI edge are not counted'
    )
    t.add_argument('--qc-axis', type=int, default=1, choices=[0, 1, 2], help='axis the QC slices are cut across')
    t.set_defaults(fn=trabecular)
    c = sub.add_parser('cortical', formatter_class=fmt, help='Ct.Th in a slab at a depth below a reference surface',
                       description='Ct.Th: mean largest-contained-sphere diameter over the cortical voxels of a slab at a depth below a '
                       'reference surface. Writes <out>/<name>.json and qc-<name>.jpg.')
    c.add_argument('--cortex', type=sidecar.existing, required=True, help='bool .npy of the cortical bone (not trabeculae)')
    c.add_argument(
        '--surface', type=sidecar.existing, required=True, help='2D .npy: index along --axis of the reference surface, per position (the mask shape without --axis)'
    )
    c.add_argument('--axis', type=int, default=0, choices=[0, 1, 2], help='axis the depth is measured along')
    c.add_argument(
        '--direction', type=int, default=1, choices=[-1, 1], help='+1 if depth grows with the index along --axis'
    )
    c.add_argument('--depth-um', type=float, required=True, help='um: depth of the slab centre below the surface')
    c.add_argument('--slab-um', type=float, default=50, help='um: thickness of the slab centred on the depth')
    c.add_argument(
        '--context-um', type=float, default=400, help='um: cortex kept above and below the slab when measuring spheres'
    )
    c.add_argument('--name', default='Ct.Th', help='the output id of the value (and the output file name)')
    c.add_argument('--object-id', required=True, help='the output id the workflow declares for the slab measured (its mask is reported under it)')
    c.add_argument('--grid', type=sidecar.existing, required=True, help='hu.json or a sidecar of the grid the cortex is on')
    c.add_argument('--out', required=True, help='output directory (created)')
    c.set_defaults(fn=cortical)
    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
