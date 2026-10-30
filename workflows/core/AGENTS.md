# core

The generic micro-CT skills every micro-CT workflow uses (`skills/`). A workflow that needs animal-specific
knowledge is a sibling directory (`../mouse-oa/`: `skills/mouse-oa/references/` for the anatomy and protocol text, `resources/` for
its scripts). Design: `work/iterate-and-review/design/workflow-behavior/tool-contracts.md` in the docs repo (which text lives in a role
file, a method skill, a workflow skill and a script's `--help`). The measurements behind the skills' rules are in `.context/evidence.md`: SKILL.md
holds rules, not experiment logs.

- A skill is `skills/<name>/SKILL.md` (frontmatter `name`, `description` only) plus `resources/`. The run agent reads
  SKILL.md and runs the resources as `python <skill dir>/resources/<x>.py`; so SKILL.md names a resource by file name,
  says when to reach for it and what its result means, and leaves flags, schemas and outputs to the script's `--help`
  (the tool index in every agent's prompt lists each script by its first docstring line). There are no per-workflow agent definitions: the roles shared by every workflow are in
  `agents/`, and a skill never addresses one role; what a workflow wants checked per task is in its `tasks.json` and
  `skills/<workflow>/examples/`.
- Change a skill or role file only on evidence from runs on the models the workflow runs on. A run on a
  cheap stand-in model (DeepSeek) checks plumbing only: never judge or change skill or role text by how it
  behaved (Jimmy, 2026-10-29).
- **Resource contract:** CLI scripts that take and return paths. `.npy` outputs get a JSON sidecar
  (`microct-core/resources/sidecar.py`: grid id, spacing, input sha256, params; it keeps the keys `segment_sam` wrote). One JSON line
  on stdout, never arrays, never NaN (`sidecar.emit` fails on it). A script that reports numbers uses one result record,
  `sidecar.emit_values`: `{id: {value, unit, definition, kind}}`, ids from the caller. A sentence on stderr and exit 2 for what the agent can fix (`sidecar.parser` makes every argparse error one sentence); argument
  checks come before any work or write, and an argument naming an input path takes `type=sidecar.existing`, so a missing file is refused after parsing, naming the flag and path. **`--help` is the contract an agent reads before running a script** (the tool index is its first docstring line): the module docstring is the help text (`sidecar.parser(__doc__)` prints it as written and appends defaults), laid out as one index sentence under 110 characters, the rule it enforces and what it refuses, then `Writes:`, `Prints:`, `Example:` and `Exits 2`; every argument has `help=` naming its unit; a JSON the script reads has its schema in the docstring. `workflows/core/tests/test_help.py` fails on a script that breaks this. Images are JPEG, at most 2000 px and 1 MiB (`view_image`'s limit): use
  `sidecar.save_image`. A length flag takes a physical unit named in the flag (`--pad-mm`, `--depth-um`), never voxels or pixels; the
  voxel size comes from `hu.json`.
- **Imports:** a script imports another skill's module by its plain name (`import sidecar`, `import frame`). The runner puts every
  skill's `resources/` on `PYTHONPATH` in the sandbox (`runLayout` in `packages/harness/src/layout.ts`), so a module name is unique across
  skills (a test checks). In a checkout: `export PYTHONPATH=$(ls -d $PWD/workflows/*/skills/*/resources | paste -sd:)` from the repo root.
- **Thresholds:** two, and they are not interchangeable. The segmentation threshold (mask building) is a flag the caller passes,
  from the workflow's anatomy reference. The measurement threshold (BV, BV/TV) is the lab's 2.16/cm converted with the calibration
  block of `hu.json` (`sidecar.bone_threshold_hu`); no script holds a literal HU value for it. BV is the region and HU above the
  threshold, never gated by a label; BV/TV is in %.
- `convert/review_assets.py` is not a skill the run agent sees: the harness runs it in a `convert` sandbox to turn a reported file into
  review assets (OME-Zarr levels, meshes; the header says how). Its `import sidecar` resolves through the same `PYTHONPATH` (the runner gives the convert sandbox `RunLayout.pythonPath` as its only env); labels and masks downsample by mode, tie to the foreground: a one-voxel sheet survives every level, a one-voxel rod does not. The scan is the intake task's `hu.npy`, converted with `--as image --int16`. Integer coordinates are voxel centres: level k voxel i is centred at source i·2^k + (2^k−1)/2 (the OME translation).
- Python dependencies: `requirements.in` / `requirements.txt` in this directory (compiled with `uv`; the sandbox image installs
  it). 3D renders need pyvista on an off-screen VTK. Keep recipe numbers (box padding, trim rule) in one
  script each, so a recipe change touches one file.
- **Anatomy keys the generic checks read** (a workflow's `skills/<skill>/references/anatomy.json`, per label): `volume_mm3`, `components`, `must_touch`
  (ids of labels it must come within `touch_mm` of, default 0.05 mm).
  `label_stats.py` reads them; a new animal or workflow fills them in rather than changing the script.
