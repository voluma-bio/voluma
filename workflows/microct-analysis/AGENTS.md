# microct-analysis

The generic micro-CT skills (`skills/`) and the four agent definitions (`agents/`) every micro-CT workflow uses. Design:
`design/microct-skillset.md` in the docs repo. The mouse-specific skills are in `../mouse-oa/skills/`.

- A skill is `skills/<name>/SKILL.md` (frontmatter `name`, `description` only) plus `resources/`. The run agent reads
  SKILL.md and runs the resources as `python <skill dir>/resources/<x>.py`; so SKILL.md names resources relative to its own
  directory and holds no commit or mount path.
- **Resource contract:** CLI scripts that take and return paths. `.npy` outputs get a JSON sidecar (`microct-core/resources/sidecar.py`:
  grid id, spacing, input sha256, params; keeps keys `segment_sam` wrote). One JSON line on stdout, never arrays. A sentence on
  stderr and exit 2 for what the agent can fix. Images are JPEG, at most 2000 px and 1 MiB (`view_image`'s limit): use
  `sidecar.save_image`. Every parameter that is a length is in mm; voxels come from `hu.json`.
- Scripts reach sibling skills with `sys.path.insert(0, .../'<skill>/resources')`; skills in `../mouse-oa` reach this package
  through `parents[4] / 'microct-analysis/skills/...'`. Both packages are always imported at one commit, side by side.
- Python dependencies: `requirements.txt` in this directory. Everything is numpy-first; 3D renders need pyvista on an off-screen
  VTK. Keep recipe numbers (box padding, trim rule, thresholds) in one script each, so a recipe change touches one file.
- Verify a script on real OA6-1RK (`/home/jimyao/experiments/seg-bakeoff/`, `public/meta-api/oa6*/` hold the POC outputs to compare
  against). The one kept test is `skills/bone-morphometry/resources/test_measure.py` (unit conversions).
- Open facts, not to be settled in a skill: OA6-1RK label 5 is unresolved (fabella or medial joint mineralization). The vision
  rules in `visual-check` are n=1.
