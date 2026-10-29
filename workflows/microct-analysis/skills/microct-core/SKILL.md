---
name: microct-core
description: >
  Load first for any micro-CT task: how numbers, files and evidence work in a Voluma run,
  the render-look-decide loop, how resource scripts are run, and when to hand a question to the researcher.
---

# Micro-CT core

## Files and grids

- The **scan grid** is the truth: the HU volume from `scan-intake` (`hu.npy`), with its spacing in mm from
  the DICOM header (`hu.json`). Never assume a voxel size. Any array on another grid (an oriented stack) is
  mapped back to the scan grid before you measure.
- Arrays are `.npy`, axes in Z,Y,X order. The scripts take paths and write paths. Do not load a volume
  just to print it: tool output is your context.
- A **frame** is a rigid, resampled copy of the scan grid with its own `grid_id` (the oriented stack, an aligned bone grid). Its
  `frame.json` has `parent_grid_id`, `grid_id`, `R_zyx`, `origin_zyx`, `shape`, `spacing_zyx_mm` and
  `affine_xyz_to_world_mm` (the frame's own placement in world mm, in `hu.json`'s convention; `frame.make` composes it from the
  scan's affine and refuses a frame that is not a rotation times the voxel size); scan index `x` and frame index `p`
  relate by `x = p @ R_zyx + origin_zyx`. `resources/frame.py` resamples a scan volume onto a frame and maps points and
  stacks both ways: use it, do not rebuild the maths. Anything on a frame is mapped to the scan grid before you measure.
- A **points file** is `{"grid_id": ..., "points": [{"name": "a", "zyx": [z, y, x]}, ...]}`; `femoral_frame.py` and `amira_landmarks.py` (both take several points files and merge them) refuse one without a
  `grid_id` or from another grid; `map_points.py --points-file` moves a file to the other grid of a frame, because indices mean nothing on another grid.
- Every `.npy` a resource writes has a JSON sidecar beside it (`labels.npy` gives `labels.json`) with its grid id,
  voxel size, its inputs' sha256 and its parameters. If you make an array yourself, give it one:
  `python <this skill>/resources/sidecar.py --array out.npy --like hu.json --input a.npy --param key=value`.
  `segment_sam` writes its own `labels.json` (prompts, per-object confidence); the command above adds to it.
- Put what you report in `/outputs/<task>/`, and working files in `/scratch/`. Anything else
  is lost if the sandbox restarts. The names later tasks look for: `hu.npy`, `hu.json` and `scan-notes.md` (intake: what the
  researcher's notes say is in the field, what is absent, and other facts such as a measurement threshold), `frame.json`,
  `oriented.npy` and `keyframe.jpg` (orient), `labels.npy` (the final labels, **on the scan grid only**), `qc/*.jpg` (every
  check). An array on the oriented stack has `oriented` in its name (`labels_big_oriented.npy`, `small_oriented.npy`); one
  without it is on the scan grid.

## Running a resource

The prompt lists each skill with its directory. A resource is a script in that directory:
`python <skill dir>/resources/<name>.py --in <path> ... --out <path> [parameters]`. Every one:

- takes and writes paths, and prints **one JSON line** (paths written, counts, volumes in mm³) and never an array;
- if it reports numbers, writes them as one **result record**: `{"values": {"<id>": {"value", "unit", "definition", "kind"}}}`
  in its JSON file (plus provenance such as the points or labels used), and prints the same under `values` without the provenance.
  The id is the output id the caller gave (`--id KEY=output-id` in `morphometry.py`, the name in a `measure.py` spec, fixed in a
  workflow's own scripts), so `report_output` binds to it. `kind` is `measurement` or `diagnostic`: a diagnostic helps you judge a
  measurement (a voxel size, a count, a cross-check) and is not an output. `value` is null when there is nothing to measure;
  units are `mm`, `mm³`, `%`, `1/mm`, `1/mm³`, `1`;
- exits non-zero with a sentence that says what to change; read it, fix the input, run again;
- writes images as JPEG, at most 2000 px a side and 1 MiB (what `view_image` accepts);
- has `--help`.

## Reporting

- Attach as evidence the files a value came from and the QC image that shows it.
- A structure that is absent gets `null` or `0` with a note, never the nearest look-alike (`segmentation-check`, section 2).
- Measurements carry units, a definition, and the structures they were measured on.
- A value outside the plan's range is still reported. Say why in the checkpoint.
- Never adjust a number to match an expectation. A result that looks wrong has its cause in the data, the mask, the
  threshold or the method.

## Render, look, decide

Before you accept any segmentation, frame, region or landmark, render it and look at it
(`visual-check`). Geometry comes from code: axes, boxes, angles, distances, volumes.
Judgment comes from looking: which bone, whether a boundary is right, whether a thing
belongs.

## Read the scan's notes before you name anything

`/outputs/intake/scan-notes.md` is the researcher's account of the scan, written by intake: what is in the field, what is
absent or cut off, and other facts. Read it at the start of every task that names a structure or picks a threshold. It
outranks your expectation of the anatomy; the CT can overrule it only with evidence you cite.

## Hand on what you cannot settle

A To check item is how you ask the researcher. Raise one when the data cannot settle a
choice that changes a number: a disagreement region you could not resolve, an unnamed
structure, a boundary the protocol leaves open. Point it at the region (`focus`), and
say what you chose meanwhile. A choice you could settle by looking harder is not one.
`segmentation-check`, section 2, says when a structure is unnamed or absent.

## Two thresholds

- **Segmentation threshold:** builds masks (orientation, box snapping, clipping to bone, candidates). The workflow's anatomy
  reference gives it, and each script takes it as `--threshold-hu`.
- **Measurement threshold:** decides bone volume. It is the lab's 2.16/cm converted to this scan's HU from the calibration block
  in `hu.json`, and the measurement scripts compute it themselves; a flag overrides it. BV is always the region and HU above
  the threshold, never gated by a label; BV/TV is in %. The protocol's threshold wins whenever the calibration exists; a
  different value in `scan-notes.md` is reported beside the measurement, not used. When `hu.json` has no calibration the
  scripts fail until you pass `--threshold`: use the threshold the notes give, name them as its source, and raise a To check item.

The workflow's own references (the anatomy and the protocol) say what to look for in this animal. Read a reference when its
step comes up, not all at the start.
