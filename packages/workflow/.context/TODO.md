# Workflow TODO

- **Delete the old-snapshot shim in `load.ts` (2026-11-03).** `rolesDirOf` and the `harness` entry in
  `SKILL_KEYS` let `loadWorkflow` read a snapshot cut before the task loop was deleted: its roles are in
  `core/roles/` (with a `core/agents/` of task-loop roles to ignore) and its skills carry `harness:`.
  Delete both once no run snapshotted before that deploy can be resumed or reopened: every such run
  has ended and been converted or removed, not only the live ones (a message reopens any ended run).

- Role files (`agentSchema`) and skill frontmatter (`frontmatterSchema`) in `load.ts` parse run
  snapshots strictly, so a new optional key there breaks older code in a deploy overlap or a revert
  (the `SKILL_KEYS` OVERLAP shim is one patch of it). Read snapshots leniently and keep the strict
  check for the checkout, as `snapshotOutputCatalogSchema` does for `outputs.yaml` (#610 review).
