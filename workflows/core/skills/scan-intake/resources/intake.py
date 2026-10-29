"""Convert a DICOM series to a calibrated HU volume (hu.npy) and its grid header (hu.json).

HU comes from the rescale tags (and Scanco's private calibration where present), never from a histogram peak.
Refuses, and says which: a series with fewer than two .dcm slices, missing, duplicate or unevenly spaced slices, slices
shifted in plane, mixed series, geometry or calibration, no valid positive-slope HU mapping, a DICOM mapping that
contradicts Scanco's private calibration, or an `--out` that already holds hu.npy. Slices are found recursively under `--in`.

Writes: <out>/hu.npy  float32 HU, axis order Z,Y,X, slices sorted along the series normal
        <out>/hu.json  the scan's grid: shape_zyx, spacing_zyx_mm, affine_xyz_to_world_mm (consumes x,y,z voxel-centre
        indices), calibration, grid_id, and the sha256 of every source slice
Prints: one JSON line {hu, header, shape_zyx, spacing_zyx_mm, grid_id, calibration, hu_min, hu_max}
Example: python intake.py --in dicom/ --out scan/
Exits 2 with one sentence on the input it checks; a missing file is a Python error.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
import pydicom
import sidecar

CT_IMAGE_STORAGE = '1.2.840.10008.5.1.4.1.1.2'


def calibration(ds):
    """The HU mapping of one slice, with the evidence for it."""
    slope, intercept = float(ds.RescaleSlope), float(ds.RescaleIntercept)
    kind = list(ds.get('ImageType', []))
    implicit_hu = (str(ds.SOPClassUID) == CT_IMAGE_STORAGE and len(kind) >= 3 and kind[0] == 'ORIGINAL'
                   and kind[2] != 'LOCALIZER' and ds.get('MultiEnergyCTAcquisition', 'NO') == 'NO')
    units = ds.get('RescaleType', 'HU' if implicit_hu else None)
    if units != 'HU' or not np.isfinite([slope, intercept]).all() or slope <= 0:
        sidecar.fail('No valid positive-slope HU mapping in this CT header: ask the researcher what the units are')
    result = {'slope': slope, 'intercept': intercept, 'units': 'HU',
                  'evidence': 'RescaleType' if 'RescaleType' in ds else 'DICOM CT Image Module implicit HU'}
    try:
        block = ds.private_block(0x0029, 'SCANCO calibration')
    except KeyError:
        return result
    scaling, water = float(block[0].value), float(block[6].value)
    expected = 1000 / (scaling * water)
    if not np.isclose(slope, expected, rtol=1e-5) or not np.isclose(intercept, -1000):
        sidecar.fail('The DICOM HU mapping contradicts the Scanco private calibration: report it, do not pick one')
    result.update(mu_scaling=scaling, mu_water_per_cm=water, private_hu_slope=expected, private_mapping_consistent=True)
    return result


def check_geometry(headers):
    first = headers[0]
    orient = np.array(first.ImageOrientationPatient, dtype=float).reshape(2, 3)
    if not np.allclose(orient @ orient.T, np.eye(2), atol=1e-6):
        sidecar.fail('Invalid DICOM orientation cosines')
    normal = np.cross(*orient)
    positions = np.array([d.ImagePositionPatient for d in headers], dtype=float)
    order = np.argsort(positions @ normal)
    positions = positions[order]
    gaps = np.diff(positions @ normal)
    dz = float(np.median(gaps))
    if dz <= 0 or not np.allclose(gaps, dz, atol=1e-6, rtol=1e-4):
        sidecar.fail('Duplicate, missing or unevenly spaced slices: the series cannot be stacked as it is')
    if not np.allclose(np.diff(positions, axis=0), dz * normal, atol=1e-5):
        sidecar.fail('Slices are shifted in plane: resampling is needed before stacking')
    cal = calibration(first)
    for d in headers:
        if (d.SeriesInstanceUID != first.SeriesInstanceUID
                or (d.Rows, d.Columns) != (first.Rows, first.Columns)
                or not np.allclose(d.ImageOrientationPatient, orient.ravel())
                or not np.allclose(d.PixelSpacing, first.PixelSpacing)
                or calibration(d) != cal):
            sidecar.fail('Mixed series, geometry or calibration across slices: use one series')
    if len({str(d.SOPInstanceUID) for d in headers}) != len(headers):
        sidecar.fail('Duplicate SOP instance UIDs in the series')
    return orient, normal, order, positions, dz, cal


def load_series(source, out):
    paths = sorted(p for p in Path(source).rglob('*') if p.suffix.lower() == '.dcm')
    if len(paths) < 2:
        sidecar.fail(f'Need at least two .dcm slices under {source}')
    headers = [pydicom.dcmread(p, stop_before_pixels=True) for p in paths]
    first = headers[0]
    orient, normal, order, positions, dz, cal = check_geometry(headers)
    spacing_xyz = [float(first.PixelSpacing[1]), float(first.PixelSpacing[0]), dz]
    affine = np.eye(4)
    affine[:3, :3] = np.column_stack([orient[0], orient[1], normal]) @ np.diag(spacing_xyz)
    affine[:3, 3] = positions[0]
    out.mkdir(parents=True, exist_ok=True)
    dest = out / 'hu.npy'
    if dest.exists():
        sidecar.fail(f'{dest} exists: write to a fresh output directory')
    # Built in memory and written once: /outputs is a bucket mount, which cannot take a memory-mapped or piecemeal write.
    volume = np.empty((len(paths), first.Rows, first.Columns), np.float32)
    sources = []
    for z, idx in enumerate(order):
        p = paths[idx]
        d = pydicom.dcmread(p)
        volume[z] = d.pixel_array.astype(np.float32) * cal['slope'] + cal['intercept']
        sources.append({'path': str(p.resolve()), 'sha256': sidecar.sha256_file(p)})
    np.save(dest, volume)
    meta = {'shape_zyx': list(volume.shape), 'spacing_zyx_mm': spacing_xyz[::-1], 'spacing_xyz_mm': spacing_xyz,
                'affine_xyz_to_world_mm': affine.tolist(), 'calibration': cal, 'sources': sources,
                'coordinate_note': 'Array indices are Z,Y,X; the affine consumes X,Y,Z voxel-center indices',
                'status': 'Calibrated from header metadata; no independent phantom validation'}
    ident = {k: meta[k] for k in ('shape_zyx', 'affine_xyz_to_world_mm', 'sources')}
    meta['grid_id'] = hashlib.sha256(json.dumps(ident, sort_keys=True).encode()).hexdigest()
    (out / 'hu.json').write_text(json.dumps(meta, indent=1) + '\n')
    return meta, float(volume.min()), float(volume.max())


if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--in', dest='src', required=True, help='directory holding the DICOM series (.dcm files, searched recursively)')
    ap.add_argument('--out', required=True, help='output directory (created; must not already hold hu.npy)')
    a = ap.parse_args()
    m, hu_min, hu_max = load_series(a.src, Path(a.out))
    sidecar.emit(hu=str(Path(a.out) / 'hu.npy'), header=str(Path(a.out) / 'hu.json'), shape_zyx=m['shape_zyx'],
                 spacing_zyx_mm=m['spacing_zyx_mm'], grid_id=m['grid_id'], calibration=m['calibration']['evidence'],
                 hu_min=hu_min, hu_max=hu_max)
