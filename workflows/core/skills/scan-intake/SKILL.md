---
name: scan-intake
description: >
  Load at the start of a scan: turn a DICOM series into a calibrated HU volume with its header, and write the scan's
  notes from what the researcher left in /inputs.
---

# Scan intake

`intake.py` turns the DICOM series in `/inputs` into `hu.npy` and `hu.json` (`--help`); every later step takes
`hu.json` for the voxel size and the grid.

- **HU comes from the DICOM rescale tags**, cross-checked against the Scanco calibration when present. Never from a
  histogram peak: do not shift the soft-tissue or air peak to zero, and do not call Otsu a calibration. The mapping
  is encoded, not phantom-validated: say so if asked how good the HU are.
- **It refuses** a series with missing, duplicate or unevenly spaced slices, mixed geometry or calibration, or no
  valid HU mapping, and says which. Report the refusal; do not work around it.
- Check the printed spacing against what the researcher told you. A mismatch is a To check item, not a header to
  edit.
- **Write `/outputs/intake/scan-notes.md`.** `/inputs` holds more than the DICOM: a README, a protocol, a sample
  sheet, in whatever form the lab wrote them. Read every such file and write only what they say, with the file each
  fact came from, under three headings (a heading with nothing under it says "nothing stated"):
  - `## Present in the field`: structures, regions and features the notes say are imaged.
  - `## Absent or cut off`: structures the notes say are not in the field or are cut by it.
  - `## Other facts later tasks need`: a measurement threshold, a calibration caveat, the animal, side or age, how
    the orientation was worked out, anything that changes how a number is read.

  Do not infer what the notes do not say, and do not add what you saw on the scan: intake has not looked at the
  bones.
