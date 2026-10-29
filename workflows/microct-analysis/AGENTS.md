# microct-analysis

The generic micro-CT skills every micro-CT workflow uses (`skills/`). A workflow that needs animal-specific
knowledge is a sibling directory (`../workflow-mouse-oa/`: `references/` for the anatomy and protocol text, `resources/` for
its scripts). Design: `design/microct-skillset.md` in the docs repo.

- A skill is `skills/<name>/SKILL.md` (frontmatter `name`, `description` only) plus `resources/`. The run agent reads
  SKILL.md and runs the resources as `python <skill dir>/resources/<x>.py`; so SKILL.md names resources relative to its own
  directory and holds no commit or mount path. There are no per-workflow agent definitions: the roles shared by every workflow are in
  `workflows/agents/`; `segmentation-check` ("When you check a task") holds only what a checker re-derives for labels.
- **Resource contract:** CLI scripts that take and return paths. `.npy` outputs get a JSON sidecar
  (`microct-core/resources/sidecar.py`: grid id, spacing, input sha256, params; it keeps the keys `segment_sam` wrote). One JSON line
  on stdout, never arrays, never NaN (`sidecar.emit` fails on it). A script that reports numbers uses one result record,
  `sidecar.emit_values`: `{id: {value, unit, definition, kind}}`, ids from the caller. A sentence on stderr and exit 2 for what the agent can fix; argument
  checks come before any work or write. Images are JPEG, at most 2000 px and 1 MiB (`view_image`'s limit): use
  `sidecar.save_image`. Every parameter that is a length is in mm; voxels come from `hu.json`.
- **Imports:** every script works under `python -I` from any directory. It puts its own directory and `microct-core/resources` (and
  any sibling skill's `resources` it imports from) on `sys.path` itself, and exits with a sentence naming the expected layout when
  that misses. The layout is `workflows/microct-analysis/skills/<skill>/resources/`, in the repository and in a run's snapshot
  alike; scripts in a workflow directory find `microct-analysis/skills/microct-core/resources` by walking up their ancestors.
- **Thresholds:** two, and they are not interchangeable. The segmentation threshold (mask building) is a flag the caller passes,
  from the workflow's anatomy reference. The measurement threshold (BV, BV/TV) is the lab's 2.16/cm converted with the calibration
  block of `hu.json` (`sidecar.bone_threshold_hu`); no script holds a literal HU value for it. BV is the region and HU above the
  threshold, never gated by a label; BV/TV is in %.
- Python dependencies: `requirements.in` / `requirements.txt` in this directory (compiled with `uv`; the sandbox image installs
  it). Everything is numpy-first; 3D renders need pyvista on an off-screen VTK. Keep recipe numbers (box padding, trim rule) in one
  script each, so a recipe change touches one file.
- Verify a script on a real scan. The one kept test is `skills/bone-morphometry/resources/test_measure.py` (unit conversions);
  `tests/test_environment.py` guards the pinned environment.
- **Anatomy keys the generic checks read** (a workflow's `references/anatomy.json`, per label): `volume_mm3`, `components`, `must_touch`
  (ids of labels it must come within `touch_mm` of, default 0.05 mm).
  `label_stats.py` reads them; a new animal or workflow fills them in rather than changing the script.
- Open facts, not to be settled in a skill: the identity of the small structures (OA6-1RK labels 5 to 12) is not anatomically checked;
  the workflow's anatomy reference says what is known. The vision rules in `visual-check` are n=1.
