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
- **Read the scan's notes and write `/outputs/intake/scan-notes.md`.** `/inputs` holds more than the DICOM: a README, a
  protocol, a sample sheet, in whatever form the lab wrote them. Read every such file. The notes are free text, so write
  down only what they say, with the file each fact came from, under three headings (a heading with nothing under it says
  "nothing stated"):
  - `## Present in the field`: structures, regions and features the notes say are imaged.
  - `## Absent or cut off`: structures the notes say are not in the field or are cut by it. Later tasks read this before they name
    anything (`segmentation-check`, section 2, says what they do with it).
  - `## Other facts later tasks need`: a measurement threshold, a calibration caveat, the animal, side or age, how the
    orientation was worked out, anything that changes how a number is read.

  Do not infer what the notes do not say, and do not add what you saw on the scan: intake has not looked at the bones.
  `scan-notes.md` is the one file every later task reads for the researcher's account of the scan.
- Looks: none needed. Orientation is the next step (`orient-joint`).
