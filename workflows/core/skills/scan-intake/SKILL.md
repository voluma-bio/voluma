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
- **Write `scan-notes.md`** with your results. `/inputs` holds more than the DICOM: a README, a protocol, a sample
  sheet, in whatever form the lab wrote them. Read every such file and write only what they say, with the file each
  fact came from, under three headings (a heading with nothing under it says "nothing stated"):
  - `## Present in the field`: structures, regions and features the notes say are imaged.
  - `## Absent or cut off`: structures the notes say are not in the field or are cut by it.
  - `## Other facts later steps need`: a measurement threshold, a calibration caveat, the animal, side or age, how
    the orientation was worked out, anything that changes how a number is read.

  Do not infer what the notes do not say. The notes are the researcher's account: what you see on the scan goes in
  your report, not here.
- **Report the converted scan at once** when the workflow asks for it: as soon as `hu.npy` and `hu.json` exist, before
  cleanup, report `header` (`hu.json`), then `scan` (`hu.npy`; its sidecar is read from the published header), with the
  To check item "Not yet cleaned: holder and debris still in the field". `report_output`
  moves the files and leaves a `<file>.removed.txt` pointer to the published copy: copy `hu.npy` and `hu.json` back into
  your folder from it before the cleanup below. The cleaned scan is the next version, and nothing is made from the first.
- **Clean up the scan.** The field can hold the sample holder, padding and debris beside the specimen; every later
  step, and the researcher's 3D view, reads `hu.npy`. Set what is not the specimen to air (-1000 HU) in `hu.npy`,
  keeping its grid so `hu.json` stays true, and save what you set as a mask on the scan grid with its sidecar
  (`sidecar.py --like hu.json`). A piece that may be bone of the leg stays, with a To check item asking what it is:
  bone wrongly removed is lost to every step after you.
- **Choose this scan's display window and segmentation threshold** on the cleaned scan, before anything builds a
  mask. Scans differ in density and contrast; the workflow's anatomy reference gives the values of the scan it was
  written on, with that scan's soft-tissue and bone peaks. Find this scan's two peaks on the histogram of the
  specimen's voxels, and move each reference value to the same place between them: value = soft + (reference -
  reference soft) / (reference bone - reference soft) x (bone - soft). Take the threshold from there, not from the
  valley between the peaks: on micro-CT the valley sits higher and drops thin trabeculae, whose voxels are part
  bone. Then look: save `hu >= threshold` as a mask (`sidecar.py --like hu.json`) and view it on `quad_view.py`
  slices, zoomed on the joint and on the trabeculae under the growth plate, in your window. Move the threshold
  until its outline follows the cortex edge and keeps thin trabeculae without taking in soft tissue or cartilage,
  and the window until trabeculae and the growth plate show and the densest cortex is not clipped white. Write
  `scan-settings.json` (`{"window_hu": [lo, hi], "segmentation_threshold_hu": t, "peaks_hu": [soft, bone], "why":
  "..."}`) and report it with the histogram and the views as evidence. Every later script takes the file itself:
  `--window scan-settings.json`, `--threshold-hu scan-settings.json`, `--bone-hu scan-settings.json`, and its `window_hu`
  is the `window` of a `segment_sam` request. The measurement threshold
  (`microct-core`) is the lab's and stays fixed: say in your report where it falls against the chosen threshold,
  and raise a To check item when the two are more than 300 HU apart.
- **Find out what each bone piece is.** `components.py` (`sam-segmentation`) lists the bone pieces of the cleaned
  scan; name each one in `pieces.md`, with your results, from the 3D view and the workflow's anatomy reference (two
  bones touching at a joint can be one piece: name both), with its centre and volume.
