# Contracts: rules for stored payloads

- **A stored payload never embeds an authoring schema.** `outputs.yaml`'s entry schema
  (`output-catalog.ts`) is strict and changes with the workflow format; an event that embedded it
  would stop parsing the day it changed, which is how recorded plans took the runs list down after
  #177. `outputs.changed.add` keeps entries loose (`id`, `kind`, the rest passes through); the
  writer checks them against the catalog, the parser never does.
- **Every place a payload names an output takes `outputRefSchema`** (a catalog id, or
  `<worker>/<id>` for an output a worker reported that the catalog does not declare). The catalog
  file itself can only name its own entries.
- **Paths in agent-model events are relative to the run's prefix** (`output.published.path`,
  `approval.requested.fileHashes`); a version's file names are relative to the version's folder.
- **Units are UCUM** (`mm3`, `[hnsf'U]`). Review shows a display form (see `TODO.md`).
- **YAML read from Python**: write the key `"on":` quoted, since PyYAML reads a bare `on` as
  `True`. `loadWorkflow` refuses an unquoted one.
