---
name: microct-core
description: >
  Load first for any micro-CT task: how numbers, files and evidence work in a Voluma run,
  the render-look-decide loop, how resource scripts are run, and when to hand a question to the researcher.
---

# Micro-CT core

A researcher will trust a number only if they can trace it to the scan. Work so every
number you report can be traced.

## Files and grids

- The **scan grid** is the truth: the HU volume from `scan-intake` (`hu.npy`), with its spacing in mm from
  the DICOM header (`hu.json`). Never assume a voxel size. Any array on another grid (an oriented stack) is
  mapped back to the scan grid before you measure.
- Arrays are `.npy`, axes in Z,Y,X order. The scripts take paths and write paths. Do not load a volume
  just to print it: tool output is your context.
- Every `.npy` a resource writes has a JSON sidecar beside it (`labels.npy` gives `labels.json`) with its grid id,
  voxel size, its inputs' sha256 and its parameters. If you make an array yourself, give it one:
  `python <this skill>/resources/sidecar.py --array out.npy --like hu.json --input a.npy --param key=value`.
  `segment_sam` writes its own `labels.json` (prompts, per-object confidence); the command above adds to it.
- Put what you report in `/outputs/<task>/`, and working files in `/scratch/`. Anything else
  is lost if the sandbox restarts. The names later tasks look for: `hu.npy` and `hu.json` (intake), `frame.json`,
  `oriented.npy` and `keyframe.jpg` (orient), `labels.npy` on the scan grid (segmentation), `qc/*.jpg` (every check).

## Running a resource

The prompt lists each skill with its directory. A resource is a script in that directory:
`python <skill dir>/resources/<name>.py --in <path> ... --out <path> [parameters]`. Every one:

- takes and writes paths, and prints **one JSON line** (paths written, counts, volumes in mm³) and never an array;
- exits non-zero with a sentence that says what to change; read it, fix the input, run again;
- writes images as JPEG, at most 2000 px a side and 1 MiB (what `view_image` accepts);
- has `--help`.

## Reporting

- Report each declared output with `report_output`. Attach as evidence the files it came
  from and the QC image that shows it.
- Measurements carry units, a definition, and the structures they were measured on.
- A value outside the plan's range is still reported. Say why in the checkpoint.
- Never adjust a number after the fact to match an expectation. If the result looks wrong,
  find the cause in the data or the method.

## Render, look, decide

Before you accept any segmentation, frame, region or landmark, render it and look at it
(`visual-check`). Geometry comes from code: axes, boxes, angles, distances, volumes.
Judgment comes from looking: which bone, whether a boundary is right, whether a thing
belongs. Do not swap the two.

## Hand on what you cannot settle

A To check item is how you ask the researcher. Raise one when the data cannot settle a
choice that changes a number: a disagreement region you could not resolve, an unnamed
structure, a boundary the protocol leaves open. Point it at the region (`focus`), and
say what you chose meanwhile. Do not raise one for a choice you could settle by looking
harder. Do not name a structure the data and the anatomy skill do not support: leave it
unnamed and ask.

## Skills in this package

- `scan-intake`: turns the DICOM series into the HU volume and its header.
- `orient-joint`: the coarse frame and keyframe for a joint between two long bones.
- `sam-segmentation`: running `segment_sam`.
- `segmentation-check`: owning the labels.
- `regions-and-landmarks`: regions and landmarks SAM cannot make.
- `bone-morphometry`: measurements.
- `visual-check`: rendering and looking.

The workflow's own skills (the anatomy and the protocol) say what to look for in this animal. Read a skill when
its step comes up, not all at the start.
