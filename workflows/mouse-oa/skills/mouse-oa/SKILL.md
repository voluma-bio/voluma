---
name: mouse-oa
description: >
  The mouse knee osteoarthritis workflow: the lab's 28 standard µCT parameters (patella, joint mineralization,
  tibial IIOC and trabecular regions, cortical thickness, distal femur). Read first in every mouse-oa run.
---

# Mouse OA workflow

A run measures the lab's 28 standard knee parameters on one mouse knee scan, numbered 1 to 28 as in the
protocol's table. The protocol is the lab's standard: what each parameter is, which region it is measured on and
which script produces it are fixed there; how you find and check the anatomy is your call.

- `references/oa-protocol.md`: the steps, the 28 parameters with their output ids, and what the deck settles and
  leaves open. Every task follows it.
- `references/anatomy.md`: the label table, where each structure sits, the scan settings, and the open questions
  for the lab. `anatomy.json` is its machine-readable half.
- `examples/README.md`: for each placement a task makes, what correct looks like, with the lab's figures. Once
  you have a task, read its section before you place or judge anything.
- `resources/`: the protocol's scripts; `--help` is each one's contract.
- The generic micro-CT skills (`workflows/core/skills/`) are listed with this one.
