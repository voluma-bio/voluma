"""Shaft-aligned frame and cropped stack for one long bone (the tibia for the IIOC protocol).

  python tibia_frame.py --hu hu.npy --hu-json hu.json --labels labels.npy --label 2 --out <dir> [--name tibia]
         [--joint-end low|high] [--shaft-frac 0.5 0.95] [--epiphysis-frac 0 0.2] [--depth-mm 3.15] [--pad 10]

Fits the bone's shaft axis (centroid regression over the shaft part), takes the epiphyseal long cross-axis as U
(+U medial and +V anterior come from a sign rule on scan y and `--joint-end` that assumes one knee and one scan orientation:
confirm it on the QC montage before naming a side), and resamples the HU volume and the bone mask onto that
frame, cropped around the joint end. Everything the protocol annotates (growth-plate curves, heights, plate
patches) is indexed on this aligned grid: array axes (W, V, U), W running from the joint end toward the shaft.

Writes <out>/<name>-hu.npy (float32, linear), <name>-mask.npy (bool, nearest), <name>-frame.json, and a QC
montage. The frame.json (schema and maps in `microct-core/resources/frame.py`) maps aligned indices back to the scan grid, which
`iioc.py` uses to measure on the scan. This script only fits the axes and the crop; it stays here, not in `orient-joint`,
because its sign rule (+U medial, +V anterior), its crop defaults and `envelope.close_and_fill` are the mouse tibia protocol's.
"""

import argparse
import sys
from pathlib import Path

import matplotlib
import numpy as np

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path; microct-core is found by walking up to the directory that holds it.
CORE = next((p / 'microct-analysis/skills/microct-core/resources' for p in HERE.parents
             if (p / 'microct-analysis/skills/microct-core/resources/sidecar.py').exists()), None)
if CORE is None:
    sys.exit('Cannot find microct-core: this script expects microct-analysis/skills/microct-core/resources/ in a '
             'directory above it (<workflows>/workflow-mouse-oa/resources/ with <workflows>/microct-analysis/ beside it)')
sys.path[:0] = [str(HERE), str(CORE)]
import frame as fr
import sidecar
from envelope import close_and_fill

matplotlib.use('Agg')
import matplotlib.pyplot as plt

SUBSAMPLE = 2  # epiphysis points for the PCA are taken every 2nd voxel


def zrange(frac, lo, hi, joint_end):
    """Scan z range for a fraction pair measured from the joint end of the bone's z extent [lo, hi]."""
    n = hi - lo
    a, b = frac
    if joint_end == 'high':
        return round(hi - b * n), round(hi - a * n)
    return round(lo + a * n), round(lo + b * n)


def fit_frame(mask, shaft_z, epi_z, joint_end):
    centers = []
    for z in range(shaft_z[0], shaft_z[1], 10):
        yy, xx = np.where(close_and_fill(mask[z]))
        if len(yy) == 0:
            sidecar.fail(f'label has no voxels at slice {z}: widen --shaft-frac or check --label and --joint-end')
        centers.append([xx.mean(), yy.mean(), z])
    centers = np.array(centers)
    w = np.array([np.polyfit(centers[:, 2], centers[:, 0], 1)[0], np.polyfit(centers[:, 2], centers[:, 1], 1)[0], 1.0])
    w /= np.linalg.norm(w)
    if joint_end == 'high':
        w = -w  # +W points from the joint toward the shaft
    z, y, x = np.where(mask[epi_z[0] : epi_z[1] : SUBSAMPLE, ::SUBSAMPLE, ::SUBSAMPLE])
    p = np.column_stack([SUBSAMPLE * x, SUBSAMPLE * y, SUBSAMPLE * z + epi_z[0]])
    if len(p) == 0:
        sidecar.fail('no bone voxels in the epiphysis range: widen --epiphysis-frac')
    centered = p - p.mean(axis=0)
    projected = centered - np.outer(centered @ w, w)
    _, vecs = np.linalg.eigh(projected.T @ projected)
    u = vecs[:, -1]
    if u[1] < 0:
        u = -u
    v = np.cross(w, u)
    v /= np.linalg.norm(v)
    u = np.cross(v, w)
    return np.column_stack([u, v, w]), p.mean(axis=0)


def crop_for(mask, basis, origin, joint_end, depth_vox, pad):
    """Lower corner and shape (xyz order, in aligned voxels) covering the bone from the joint end to depth_vox."""
    zs = np.flatnonzero(mask.any(axis=(1, 2)))
    lo, hi = (zs[-depth_vox:][0], zs[-1]) if joint_end == 'high' else (zs[0], zs[0] + depth_vox)
    z, y, x = np.nonzero(mask[lo : hi + 1])
    local = (np.column_stack([x, y, z + lo]) - origin) @ basis
    low = np.floor(local.min(axis=0)).astype(int) - pad
    high = np.ceil(local.max(axis=0)).astype(int) + pad + 1
    return low, high - low


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--hu', required=True, help='hu.npy of the scan (float32, Z,Y,X)')
    ap.add_argument('--hu-json', required=True, help='hu.json that scan-intake wrote: grid id and spacing')
    ap.add_argument('--labels', required=True, help='labels.npy on the scan grid')
    ap.add_argument('--label', type=int, required=True, help='label id of the bone (tibia = 2)')
    ap.add_argument('--out', required=True, help='output directory')
    ap.add_argument('--name', default='tibia')
    ap.add_argument(
        '--joint-end',
        choices=['low', 'high'],
        default='low',
        help='which end of scan z the knee joint is at (low = small slice index)',
    )
    ap.add_argument(
        '--shaft-frac',
        type=float,
        nargs=2,
        default=[0.5, 0.95],
        help='shaft part of the bone, as fractions of its z extent from the joint end',
    )
    ap.add_argument('--epiphysis-frac', type=float, nargs=2, default=[0.0, 0.2], help='epiphysis part, same fractions')
    ap.add_argument('--shaft-z', type=int, nargs=2, help='explicit shaft slice range (overrides --shaft-frac)')
    ap.add_argument('--epiphysis-z', type=int, nargs=2, help='explicit epiphysis slice range')
    ap.add_argument('--crop-lower-uvw', type=int, nargs=3, help='explicit crop corner in aligned (U, V, W) voxels')
    ap.add_argument('--crop-shape-uvw', type=int, nargs=3, help='explicit crop size (U, V, W) with --crop-lower-uvw')
    ap.add_argument('--depth-mm', type=float, default=3.15, help='how far from the joint end the crop reaches')
    ap.add_argument('--pad', type=int, default=10, help='voxels of margin around the bone in the crop')
    a = ap.parse_args()
    g = sidecar.grid(a.hu_json)
    sp = g['spacing_zyx_mm']
    if not np.allclose(sp, sp[0], rtol=1e-3):
        sidecar.fail(f'spacing {sp} is not isotropic: the protocol needs isotropic voxels; resample first')
    hu = np.load(a.hu)
    labels = np.load(a.labels, mmap_mode='r')
    if hu.shape != labels.shape:
        sidecar.fail(
            f'hu {hu.shape} and labels {labels.shape} are on different grids: pass the labels made on this scan'
        )
    mask = np.asarray(labels) == a.label
    if not mask.any():
        sidecar.fail(f'label {a.label} is empty in {a.labels}')
    zs = np.flatnonzero(mask.any(axis=(1, 2)))
    shaft_z = a.shaft_z or zrange(a.shaft_frac, zs[0], zs[-1], a.joint_end)
    epi_z = a.epiphysis_z or zrange(a.epiphysis_frac, zs[0], zs[-1], a.joint_end)
    basis, origin = fit_frame(mask, shaft_z, epi_z, a.joint_end)
    depth_vox = round(a.depth_mm / sp[0])
    if a.crop_lower_uvw and a.crop_shape_uvw:
        low, shape_xyz = np.array(a.crop_lower_uvw), np.array(a.crop_shape_uvw)
    else:
        low, shape_xyz = crop_for(mask, basis, origin, a.joint_end, depth_vox, a.pad)
    shape_zyx = tuple(int(i) for i in shape_xyz[::-1])
    frame = fr.make(
        g['grid_id'],
        sp,
        parent_affine_xyz=g['affine_xyz_to_world_mm'],
        R_zyx=basis[::-1, ::-1].T,  # frame axis i (W, V, U) as a scan (z, y, x) vector: the basis columns, reversed
        origin_zyx=(origin + basis @ low)[::-1],
        shape=shape_zyx,
        axes='aligned array axes (W, V, U): +U roughly medial, +V anterior, +W from the joint toward the shaft; '
        'check on the QC montage before annotating',
    )
    aligned = fr.resample(hu, frame, order=1, cval=-1000)
    amask = fr.resample(mask.astype(np.uint8), frame, order=0, cval=0, dtype=np.uint8).astype(bool)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    params = {
        'label': a.label,
        'joint_end': a.joint_end,
        'shaft_z': list(shaft_z),
        'epiphysis_z': list(epi_z),
        'depth_mm': a.depth_mm,
        'pad': a.pad,
        'crop_lower_uvw': low.tolist(),
        'crop_shape_uvw': shape_xyz.tolist(),
    }
    for name, arr in ((f'{a.name}-hu.npy', aligned), (f'{a.name}-mask.npy', amask)):
        np.save(out / name, arr)
        sidecar.write(
            out / name,
            grid_id=frame['grid_id'],
            spacing_zyx_mm=sp,
            inputs=[a.hu, a.labels],
            params=params,
            script='tibia_frame.py',
        )
    fr.save(frame, out / f'{a.name}-frame.json')
    fig, axs = plt.subplots(2, 3, figsize=(18, 12))
    for ax, v in zip(axs.ravel(), np.linspace(shape_zyx[1] * 0.2, shape_zyx[1] * 0.8, 6).astype(int)):
        ax.imshow(aligned[:, v, :], cmap='gray', vmin=-500, vmax=6000)
        ax.contour(amask[:, v, :], levels=[0.5], colors='cyan', linewidths=0.5)
        ax.set(title=f'coronal V={v}', xlabel='U index', ylabel='W index (joint at top)')
        ax.grid(alpha=0.3)
    fig.tight_layout()
    qc = out / f'{a.name}-frame-qc.jpg'
    sidecar.save_image(fig, qc)
    plt.close(fig)
    sidecar.emit(
        hu=str(out / f'{a.name}-hu.npy'),
        mask=str(out / f'{a.name}-mask.npy'),
        frame=str(out / f'{a.name}-frame.json'),
        qc=str(qc),
        grid_id=frame['grid_id'],
        shape_wvu=list(shape_zyx),
        mask_volume_mm3=round(float(amask.sum()) * sp[0] ** 3, 4),
        shaft_z=list(shaft_z),
        epiphysis_z=list(epi_z),
    )


if __name__ == '__main__':
    main()
