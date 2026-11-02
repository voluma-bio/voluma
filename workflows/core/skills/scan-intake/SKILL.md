---
name: scan-intake
description: >
  Load at the start of a scan: turn a DICOM series into a calibrated HU volume with its header, clean it up to the
  specimen, find out what each bone piece is, and write the scan's notes from what the researcher left in /inputs.
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

  Do not infer what the notes do not say. The notes are the researcher's account: what you see on the scan goes in
  your checkpoint, not here.
- **Clean up the scan.** The field can hold the sample holder, padding and debris beside the specimen; every later
  task, and the researcher's 3D view, reads `hu.npy`. Set what is not the specimen to air (-1000 HU) in `hu.npy`,
  keeping its grid so `hu.json` stays true, and save what you set as a mask on the scan grid with its sidecar
  (`sidecar.py --like hu.json`). A piece that may be bone of the leg stays, with a To check item asking what it is:
  bone wrongly removed is lost to every task after you.
- **Find out what each bone piece is.** `components.py` (`sam-segmentation`) lists the bone pieces of the cleaned
  scan; name each one in `/outputs/intake/pieces.md` from the 3D view and the workflow's anatomy reference (two
  bones touching at a joint can be one piece: name both), with its centre and volume.
