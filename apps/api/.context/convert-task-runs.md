# Stored task-loop runs were converted (done)

Every run stored on staging as a task-loop run (24, none live) became an agent-loop run in two
migrations; the converter that generated the first is deleted.

- `drizzle/0026_convert_task_runs.sql` (PR #529): per run, the agent-loop events (`outputs.changed`,
  `output.published`, `agent.message`…) with ids `convert:<runId>:<output>`, then a generic tail for
  every database: `reply` → `agent.message`, `person.message` and `thread.started` lose their task
  fields, the task-only event types are deleted, `harness` becomes `agents`, and a pinned
  `workflows/workflow-mouse-oa` is renamed `workflows/mouse-oa`.
- `drizzle/0028_convert_task_runs_again.sql`: that tail again, for task runs that ended between
  #529's deploy and the deletion's. Idempotent. Its `when` is later than 0027's, which is later than 0026's.
- What the per-run conversion mapped and left out: the conversion report in
  `.github/pr-assets/jimyao-convert-task-runs/conversion-report.md`. A version's folder is the task's
  own folder in R2, so no object moved.

A converted run's R2 workflow snapshot is the task loop's, with no `outputs.yaml`.
`messageRefusal` (`domains/run/corrections.ts`) refuses a run holding its `convert:<runId>:outputs`
event; see [TODO.md](TODO.md) for when that goes.
