---
name: scan-intake
description: >
  Load at the start of a scan: turn a DICOM series into a calibrated HU volume and a header with the voxel size,
  grid id and calibration evidence.
---

# Scan intake

```
python <this skill>/resources/intake.py --in <dicom dir> --out /outputs/intake
```

Writes `hu.npy` (float32, axes Z,Y,X, in HU) and `hu.json` (shape, `spacing_zyx_mm`, affine, calibration, the
sha256 of every source slice, and `grid_id`). Prints the shape, spacing, the HU range and where the calibration came from.
Every later step takes `hu.json` for the voxel size and the grid.

- **HU comes from the DICOM rescale tags** (slope and intercept, with the Scanco private calibration cross-checked
  when it is present). Never from a histogram peak: do not shift the soft-tissue or air peak to zero, and do not call
  Otsu a calibration. The header's mapping is encoded, not phantom-validated: say so if asked how good the HU are.
- **It refuses** a series with missing, duplicate or unevenly spaced slices, mixed geometry or calibration, or
  no valid HU mapping, and says which. Do not work around the refusal: report it. The output directory must be new.
- Check the printed spacing against what the researcher told you. A mismatch is a To check item, not something to
  fix by editing the header.
- Looks: none needed. Orientation is the next step (`orient-joint`).
