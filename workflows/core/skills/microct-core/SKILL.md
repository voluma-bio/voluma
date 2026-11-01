---
name: microct-core
description: >
  Load at the start of every micro-CT task, after the workflow's own skill: the grid, sidecar and result-record
  contract every script shares, the files later tasks look for, the two thresholds, the scan's notes that
  outrank your expectation of the anatomy, and how to word anything a researcher will read.
---

# Micro-CT core

## Words for the researcher

Anything a researcher reads (a To check title, a checkpoint `summary` or `text`, a check's `text`, an output's note or missing reason, a `finish_run` or
`accept` summary, a `reply`) never says worker, checker, check thread, model, thread, agent or a task id.
Say "the AI" for the one that did the work, "a second AI check" for the check, and the task's plain title
("Scan intake") for a task. Say what was found, not who found it.

- Before: "The checker evidence shows the oriented frame is internally consistent; task orient-joint passed."
- After: "The joint's orientation is consistent with the scan."

## Grids and files

- The **scan grid** is the truth: `hu.npy` (float32 HU, axes Z,Y,X) with `hu.json` from `scan-intake`, which
  holds the voxel size, the grid id and the calibration. Never assume a voxel size.
- Any other grid is a **frame** (an oriented stack, an aligned bone grid): a rigid resampling with its own
  `grid_id`, described by its `frame.json`. Labels made on the oriented stack go back to the scan grid before you
  report them, with `orient-joint`'s mapping scripts, not maths of your own; a measurement region is counted on
  the grid the workflow's protocol prescribes, and its record says which. An array on the oriented stack carries
  `oriented` in its name.
- Every `.npy` a script writes has a JSON **sidecar** beside it (`labels.npy`, `labels.json`): grid id, voxel size,
  the inputs' hashes and the parameters. An array you write yourself gets one with `sidecar.py` (this skill's resources); scripts
  refuse an array whose grid they cannot read. A **points file** names its grid, for example
  `{"grid_id": "scan-3f2a", "points": [{"name": "a", "zyx": [170, 330, 128]}]}`: indices mean nothing on another
  grid, so scripts refuse a file without one.
- A thing you place in 3D (a slab mask, a surface, a point, a ruler) is saved with `objects.py` (this skill's resources, a
  library): its writer makes the file and returns the entry that `report_output` takes, on a named grid. Scripts that
  place something write it as `objects` in their result record; `quad_view.py --objects <record>.json` draws it. Every
  structure, surface and annotation is reported on the grid `outputs.json` declares for it, in voxel indices, never
  world mm (a point or line end may be fractional).
- The names later tasks look for in `/outputs/<task>/`: `hu.npy`, `hu.json`, `scan-notes.md`, `pieces.md`,
  and the rough orientation `frame.json`, `oriented.npy`, `keyframe.jpg` (intake); `labels.npy`, the final labels on the scan grid
  (segmentation). Working files go in `$SCRATCH`.

## Scripts

The tool index in your prompt lists every script with its path; `--help` is its contract. Every script takes and
writes paths and prints **one JSON line**, never an array. A script that reports numbers writes one **result
record**, for example `{"values": {"tv-roi": {"value": 1.42, "unit": "mm³", "definition": "ROI voxels × voxel
volume", "kind": "measurement"}}}`, under the output ids you give it, so `report_output` binds to them. `kind` is `measurement` or `diagnostic`: a diagnostic (a voxel size, a count, a
cross-check) helps you judge a measurement and is not an output. A script that refuses exits 2 with a sentence
saying what to change: fix the input and run it again.

Report a value outside the range the anatomy reference gives as it is, and say why in the checkpoint. A result that looks wrong has its
cause in the data, the mask, the threshold or the method; never in a number adjusted to fit.

## Two thresholds

- **Segmentation threshold** builds masks (orientation, box snapping, clipping to bone, candidates). The
  workflow's anatomy reference gives it; scripts take it as `--threshold-hu`.
- **Measurement threshold** decides bone volume: the lab's bone threshold, a linear attenuation of 2.16/cm,
  converted to this scan's HU from the calibration in `hu.json`, which the measurement scripts compute
  themselves. BV is the region and HU above it, never gated by a label; BV/TV is in %. When the calibration
  exists the protocol's threshold wins: a different value in the scan's notes is reported beside the measurement,
  not used. When `hu.json` has no calibration the scripts stop until you pass `--threshold`: use the value the
  scan's notes give, name them as its source, and raise a To check item (a `checkpoint` with `toCheck`).

## The scan's notes outrank your expectation

`/outputs/intake/scan-notes.md` is the researcher's account of the scan: what is in the field, what is absent or
cut off, and facts that change how a number is read. Read it at the start of every task after intake that names a structure
or picks a threshold. The CT overrules it only with a render you cite.
