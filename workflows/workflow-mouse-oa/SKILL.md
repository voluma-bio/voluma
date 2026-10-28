---
name: workflow-mouse-oa
description: >
  The mouse knee osteoarthritis workflow: the lab's 28 standard µCT parameters (patella, joint
  mineralization, tibial IIOC and trabecular regions, cortical thickness, distal femur).
  Read first in every mouse-oa run.
uses:
  - workflows/microct-analysis
---

# Mouse OA workflow (STARTER: edit me)

This is a starter written from the lab's 28-parameter spec, for Jimmy and Andrew to edit.
`outputs.json` and `tasks.json` are drafts: task names, dependencies, instructions and
criteria are guesses, and `range` is missing wherever the expected range is unknown.

- `outputs.json`: the 28 outputs a run can produce, in the deck's numbering (`sourceRef`).
- `tasks.json`: the tasks that produce them and what each builds on.
- Anatomy: `references/anatomy.md`. The protocol and the table of parameters: `references/oa-protocol.md`.
- Scripts a task may run: `resources/`.
- Generic micro-CT skills (intake, orientation, segmentation checks, rendering): the skills listed with this one.
