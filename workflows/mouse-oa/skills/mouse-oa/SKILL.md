---
name: mouse-oa
description: >
  The mouse knee osteoarthritis workflow: the lab's 28 standard µCT parameters (patella, joint
  mineralization, tibial IIOC and trabecular regions, cortical thickness, distal femur).
  Read first in every mouse-oa run.
---

# Mouse OA workflow

A run measures the lab's 28 standard knee parameters on one mouse knee scan, numbered as in the lab's deck.

- `workflows/mouse-oa/outputs.json`: the 28 outputs a run can produce, in the deck's numbering (`sourceRef`).
- `workflows/mouse-oa/tasks.json`: the tasks that produce them and what each builds on.
- Anatomy: `references/anatomy.md`. The protocol and the table of parameters: `references/oa-protocol.md`.
- Scripts a task may run: `resources/`.
- Generic micro-CT skills (intake, orientation, segmentation checks, rendering): the skills listed with this one (`workflows/core/skills/`).
