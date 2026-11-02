---
name: mouse-oa
description: >
  The mouse knee osteoarthritis workflow: the lab's 28 standard µCT parameters (patella, joint mineralization,
  tibial IIOC and trabecular regions, cortical thickness, distal femur). Read first in every mouse-oa run.
companions: [microct-core]
---

# Mouse OA workflow

A run measures the lab's 28 standard knee parameters on one mouse knee scan, numbered 1 to 28 as in the
protocol's table. The protocol is the lab's standard: what each parameter is, which region it is measured on and
which script produces it are fixed there; how you find and check the anatomy is your call.

A number the protocol defines comes from the protocol's script, every time, run on the files you report: that is
what makes it a measurement the lab can compare across scans. A script that refuses is enforcing the standard: fix
the input it names or pass the question on; do not route around it with code of your own.

- `references/oa-protocol.md`: the steps, the 28 parameters with their output ids, and what the deck settles and
  leaves open. Every step follows it.
- `references/anatomy.md`: the label table, where each structure sits, the scan settings, and the open questions
  for the lab. `anatomy.json` is its machine-readable half.
- `examples/README.md`: for each placement a step makes, what correct looks like, with the lab's figures. Read the
  section of the step you work on before you place or judge anything.
- `resources/` (in a run, `/workflow/workflows/mouse-oa/skills/mouse-oa/resources/`): the protocol's scripts; `--help`
  is each one's contract. `resources/protocol.json` holds every number the protocol fixes and the output ids the
  scripts write under; scripts read it with `--spec`, so you pass no protocol number as a flag.
- Report each placed object (region, surface, ruler, grid) by passing the `objects` entry of the script's result record to
  `report_output` unchanged, under the id it is keyed by; `morphometry.py cortical` reports its slab under the `--output` id. A named
  bone is reported as a structure with its label value in `bone-labels` (`{label: 2}` for the tibia; the labels are in
  `outputs.json`).
- The generic micro-CT skills (`workflows/core/skills/`) are listed with this one.
