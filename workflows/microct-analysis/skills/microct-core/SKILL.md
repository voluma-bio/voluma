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
  `oriented.npy` and `keyframe.jpg` (orient), `labels.npy` (the final labels, **on the scan grid only**; SAM's output on the
  oriented stack is `labels_oriented.npy`), `qc/*.jpg` (every check).

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
harder. Do not name a structure the data and the anatomy reference do not support: leave it
unnamed and ask.

## Two thresholds

- **Segmentation threshold:** builds masks (orientation, box snapping, clipping to bone, candidates). The workflow's anatomy
  reference gives it, and each script takes it as `--threshold-hu`.
- **Measurement threshold:** decides bone volume. It is the lab's 2.16/cm converted to this scan's HU from the calibration block
  in `hu.json` (about 2460 HU on OA6-1RK), and the measurement scripts compute it themselves; a flag overrides it. BV is always
  the region and HU above the threshold, never gated by a label; BV/TV is in %.

## By role

A role is the harness's built-in prompt plus the skills; what follows is what this workflow adds.

- **Worker** (does one task): follow the skill the task names instead of improvising its recipe; read a skill when its
  step comes up. A resource that exits with a sentence is telling you what to change. If the same step fails three times, stop
  and say why in a checkpoint instead of working around it. Do not redo or contradict what the notes passed to you say is
  settled, unless the data shows it is wrong; then say so, with the evidence.
- **Checker** (judges a finished task): `segmentation-check`, "When you check a task".
- **Main thread** (decides redo, accept or fail; never chooses what runs). It keeps one short block of notes, rewritten at each
  task boundary, that later workers read: the scan facts (spacing, thresholds, frame file, keyframe), the label table as
  settled (a name that is still a question stays a question, with the question written down), disagreements settled and why,
  the open To check items and what was chosen meanwhile, and for each task the one thing the next worker must not redo. It cites
  files and never copies numbers a file holds.

  | Situation | Default call |
  |---|---|
  | The checker says `needs-review` on a segmentation | Open its evidence images. Redo with its reason in the prompt if it names a fixable cause (a wrong box, a missing neighbour, a merged fragment); otherwise accept with a To check item. |
  | The worker failed on a tool error or a missing file | Redo once with the error in the prompt. Fail if it repeats. |
  | The worker reran `segment_sam` three times on one problem | Stop it. Accept the best labels with a To check item on the region. |
  | A measurement is out of range | Accept if the checkpoint explains it from the data. Redo if it does not. |
  | A later task contradicts the notes (another keyframe, a renamed label) | Redo it with the note cited, unless it shows evidence the note is wrong; then update the notes and let the supervisor mark the dependents stale. |

  When you accept with a To check item, say what the researcher is being asked and what was chosen meanwhile.
- **Review chat** (answers the researcher about the run's results): it starts from a summary of every task's result and can look
  up more (a task's outputs, checks, evidence, events) through read-only lookup tools over the run record, including `view_image` on
  evidence files. It has no sandbox and no bash and never runs analysis itself; a change it wants becomes a proposal that reruns
  tasks. It answers from that evidence and says which it used, gives no number the record does not hold, keeps an unsettled
  name unsettled, and does not estimate an angle, length or volume from an image.

## Skills in this package

- `scan-intake`: turns the DICOM series into the HU volume and its header.
- `orient-joint`: the coarse frame and keyframe for a joint between two long bones; moving labels, points and pieces between
  grids.
- `sam-segmentation`: running `segment_sam`, including the small-structure request.
- `segmentation-check`: owning the labels, and checking a finished task.
- `regions-and-landmarks`: regions and landmarks SAM cannot make, and the Amira hand-off for points.
- `bone-morphometry`: how each measurement is defined and computed.
- `visual-check`: rendering and looking.

The workflow's own references (the anatomy and the protocol) say what to look for in this animal. Read a reference when its
step comes up, not all at the start.
