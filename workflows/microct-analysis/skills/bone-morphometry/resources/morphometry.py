"""Trabecular and cortical morphometry of a region of interest, from a bone mask on the scan grid.

  trabecular   TV, BV, BV/TV, Tb.Th, Tb.Sp, Tb.N (and with --skeleton, Tb.Nd and Tb.Tm), a QC PNG, thickness maps
  cortical     Ct.Th: largest-contained-sphere thickness of a cortical mask, in a slab at a depth below a surface

All lengths in mm, volumes in mm^3, BV/TV in %. Methods are defined in ../SKILL.md.
"""

import argparse
import json
import sys
import warnings
from pathlib import Path

import matplotlib
import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path, so every directory a script imports from is added here.
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'microct-core/resources')]
try:
    import sidecar
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects <workflows>/microct-analysis/skills/<skill>/resources/ with '
             '<workflows>/microct-analysis/skills/microct-core/resources/sidecar.py beside it')


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


def val(value, unit, definition, **extra):
    return dict(value=None if value is None else float(value), unit=unit, definition=definition, **extra)


def write_crop_map(path, arr, parent_grid, spacing, box, inputs, params):
    np.save(path, arr)
    origin = [s.start for s in box]
    sidecar.write(
        path,
        grid_id=sidecar.derived_grid_id(parent_grid, {'crop_origin_zyx': origin}),
        spacing_zyx_mm=spacing,
        inputs=inputs,
        params=dict(params, crop_origin_zyx=origin, unit='mm'),
    )


def trabecular(a):
    g = sidecar.grid(a.grid)
    sp = np.array(g['spacing_zyx_mm'], float)
    if not np.allclose(sp, sp[0], rtol=1e-3):
        sidecar.fail(
            f'spacing {sp.tolist()} mm is not isotropic: sphere thickness needs isotropic voxels; resample first'
        )
    vox = float(sp[0])
    roi = load_bool(a.roi, 'ROI')
    inputs = [a.roi]
    if a.bone is not None:
        bone = load_bool(a.bone, 'bone mask')
        if bone.shape != roi.shape:
            sidecar.fail(f'bone mask shape {bone.shape} differs from ROI shape {roi.shape}: they must be on the same grid')
        bone = bone & roi
        inputs.append(a.bone)
        hu = None
    else:
        if a.hu is None:
            sidecar.fail('pass either --bone MASK.npy, or --hu hu.npy (bone = HU above --threshold, default the lab threshold)')
        hu = np.load(a.hu, mmap_mode='r')
        if hu.shape != roi.shape:
            sidecar.fail(f'hu shape {hu.shape} differs from ROI shape {roi.shape}: they must be on the same grid')
        a.threshold = sidecar.bone_threshold_hu(a.grid, a.threshold)
        inputs.append(a.hu)
        bone = roi & (np.asarray(hu) > a.threshold)
    marrow = roi & ~bone
    if not bone.any() or not marrow.any():
        sidecar.fail('the ROI holds only bone or only marrow at this threshold: check the threshold and the ROI')
    box = crop_box(roi)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    th_vox = local_thickness(bone[box])
    sp_vox = local_thickness(marrow[box])
    th, sep = th_vox * vox, sp_vox * vox
    tv = roi.sum() * vox**3
    bv = bone.sum() * vox**3
    frac = bv / tv
    tbth = float(th[bone[box]].mean())
    tbsp = float(sep[marrow[box]].mean())
    values = {
        'TV': val(tv, 'mm^3', 'ROI voxel count x voxel volume; trabeculae plus marrow'),
        'BV': val(bv, 'mm^3', 'bone voxels in the ROI x voxel volume'),
        'BV/TV': val(frac * 100, '%', 'BV / TV'),
        'Tb.Th': val(
            tbth, 'mm', 'mean diameter of the largest sphere inside bone covering each bone voxel', voxel_mm=vox
        ),
        'Tb.Sp': val(
            tbsp,
            'mm',
            'mean diameter of the largest sphere inside marrow covering each marrow voxel; '
            'the space outside the ROI does not count as marrow',
            voxel_mm=vox,
        ),
        'Tb.N': val(frac / tbth, '1/mm', 'model-derived (BV/TV)/Tb.Th (Bouxsein 2010), not a direct count of struts'),
    }
    maps = {'thickness': out / 'thickness-mm.npy', 'separation': out / 'separation-mm.npy'}
    p = {'threshold': a.threshold, 'step': 0.5}
    write_crop_map(maps['thickness'], th.astype(np.float32), g['grid_id'], g['spacing_zyx_mm'], box, inputs, p)
    write_crop_map(maps['separation'], sep.astype(np.float32), g['grid_id'], g['spacing_zyx_mm'], box, inputs, p)

    counts = {}
    sk = None
    if a.skeleton:
        c = skeleton_counts(bone[box], roi[box], a.edge_margin_voxels)
        sk = c.pop('skeleton')
        counts = c
        n_in = c['nodes_interior']
        e_in = c['ends_interior']
        tv_in = c['interior_voxels'] * vox**3
        where = (
            f'counted in the part of the ROI farther than {a.edge_margin_voxels:g} voxels from its edge '
            f'({tv_in:.5f} mm^3 of {tv:.5f}), per mm^3 of that tissue volume; not validated against Scanco'
        )
        values['Tb.Nd'] = val(
            n_in / tv_in,
            '1/mm^3',
            'junction clusters (skeleton voxels with >=3 neighbours, 26-connected clusters merged) ' + where,
            count=n_in,
            counted_volume_mm3=tv_in,
        )
        values['Tb.Tm'] = val(
            e_in / tv_in,
            '1/mm^3',
            'skeleton end voxels (1 neighbour) ' + where,
            count=e_in,
            counted_volume_mm3=tv_in,
        )
        values['Nd/Tm'] = val(n_in / e_in if e_in else None, '1', 'Tb.Nd / Tb.Tm (null when there are no ends)')

    qc = out / 'qc.jpg'
    qc_figure(qc, a, hu, roi, bone, th, sep, box, sk, values)
    (out / 'morphometry.json').write_text(
        json.dumps(
            {
                'values': values,
                'grid_id': g['grid_id'],
                'spacing_zyx_mm': g['spacing_zyx_mm'],
                'inputs': {str(q): sidecar.sha256_file(q) for q in inputs + [a.grid]},
                'threshold': a.threshold,
                'skeleton_counts': counts,
                'crop_slices_zyx': [[s.start, s.stop] for s in box],
            },
            indent=1,
        )
        + '\n'
    )
    sidecar.emit(
        out=str(out / 'morphometry.json'),
        qc=str(qc),
        thickness=str(maps['thickness']),
        separation=str(maps['separation']),
        values={k: {'value': None if v['value'] is None else round(v['value'], 6), 'unit': v['unit']} for k, v in values.items()},
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
        img = np.asarray(hu[t])[sl2] if hu is not None else bone[t][sl2].astype(float)
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
        a.name: val(
            t.mean(),
            'mm',
            f'mean diameter of the largest sphere inside the cortical mask, over cortical '
            f'voxels within {a.slab_um} um of {a.depth_um} um below the reference surface (axis {ax})',
            voxel_mm=vox,
            std=float(t.std()),
            median=float(np.median(t)),
            n_voxels=int(t.size),
        )
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
    axs[1].set_title(f'{a.name} = {values[a.name]["value"] * 1000:.1f} um (slab mean; map = mean along axis {ax})')
    fig.tight_layout()
    sidecar.save_image(fig, qc)
    plt.close(fig)
    (out / f'{a.name}.json').write_text(
        json.dumps(
            {
                'values': values,
                'grid_id': g['grid_id'],
                'spacing_zyx_mm': g['spacing_zyx_mm'],
                'inputs': {str(q): sidecar.sha256_file(q) for q in (a.cortex, a.surface, a.grid)},
            },
            indent=1,
        )
        + '\n'
    )
    sidecar.emit(
        out=str(out / f'{a.name}.json'),
        qc=str(qc),
        values={a.name: {'value': round(values[a.name]['value'], 6), 'unit': 'mm'}},
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    t = sub.add_parser('trabecular', help='TV, BV, BV/TV, Tb.Th, Tb.Sp, Tb.N [, Tb.Nd, Tb.Tm] in an ROI')
    t.add_argument('--roi', required=True, help='bool .npy: the region measured')
    t.add_argument('--bone', help='bool .npy of bone (clipped to the ROI)')
    t.add_argument('--hu', help='hu.npy: bone = hu > threshold (the BV rule: ROI and HU, no label gate)')
    t.add_argument('--threshold', type=float, help='bone threshold in HU (default: the lab threshold, 2.16/cm, from --grid)')
    t.add_argument('--grid', required=True, help='hu.json (or any sidecar) of the grid these masks are on')
    t.add_argument('--out', required=True, help='output directory')
    t.add_argument('--skeleton', action='store_true', help='also count nodes (Tb.Nd) and ends (Tb.Tm)')
    t.add_argument(
        '--edge-margin-voxels', type=float, default=3, help='skeleton points this close to the ROI edge are not counted'
    )
    t.add_argument('--qc-axis', type=int, default=1, choices=[0, 1, 2], help='axis the QC slices are cut across')
    t.set_defaults(fn=trabecular)
    c = sub.add_parser('cortical', help='Ct.Th in a slab at a depth below a reference surface')
    c.add_argument('--cortex', required=True, help='bool .npy of the cortical bone (not trabeculae)')
    c.add_argument(
        '--surface', required=True, help='2D .npy: index along --axis of the reference surface, per position'
    )
    c.add_argument('--axis', type=int, default=0, choices=[0, 1, 2])
    c.add_argument(
        '--direction', type=int, default=1, choices=[-1, 1], help='+1 if depth grows with the index along --axis'
    )
    c.add_argument('--depth-um', type=float, required=True)
    c.add_argument('--slab-um', type=float, default=50, help='thickness of the slab centred on the depth')
    c.add_argument(
        '--context-um', type=float, default=400, help='cortex kept above and below the slab when measuring spheres'
    )
    c.add_argument('--name', default='Ct.Th')
    c.add_argument('--grid', required=True)
    c.add_argument('--out', required=True)
    c.set_defaults(fn=cortical)
    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
