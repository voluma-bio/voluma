# Converting stored task-loop runs

Step 1 of retiring the task loop (step 2: the deletion PR). Every run stored on staging when this was
written was a task-loop run (24, none live). Migration `0026_convert_task_runs.sql` gives each the agent
loop's events, so `OutputsReview` shows its outputs, values, 3D and conversation, and its stored events
parse with an agent-loop-only `runEventSchema`.

`pnpm --filter @voluma/api convert:task-runs --staging <url> --out drizzle/0026_convert_task_runs.sql --report <file>`
generated it (`--save <dir>` keeps the fetched streams, `--from <dir>` reads them back). The mapping is
`src/ops/convert-task-run.ts`, a pure function over one run's events; the CLI around it fetches, checks R2
(reads only: every named file `runs/<id>/outputs/<task>/<file>` must exist and match `evidence/<sha256>` in
size and single-part ETag) and writes the SQL. Delete both, with the task fold, in step 2.

## Mapping

| Task loop | Agent loop |
|---|---|
| `revision.started` plan, run's `selectedOutputs` (else the catalog's `selectable`) | one `outputs.changed` (`openingChange`, shared with the agent loop), `sections` = the plan's tasks |
| the final `output` per (task, id), as `reviewState` shows it | one `output.published`, version 1, `path` = the task's folder, `files` = its file names there: no object moves |
| measurement | `value`, in the catalog's UCUM unit (`mm³` is `mm3`, `HU` is `[hnsf'U]`; any other mismatch drops the output) |
| volume image / labels, mask structure, surface | `base` / `overlay` with `detail` (`as`, `dtype`, `gridId`, `affine`, `offsetZyx`, `axis`) |
| label structure (`femur`…) | nothing of its own: `bone-labels`' version covers it |
| line annotation | `overlay` whose file is the first JSON file in the output's evidence (the agent loop keeps the object in a file, the task loop kept it in the event); `detail.points` from the fold's world-mm ends |
| declared links | `madeFrom` from the catalog (`on`, `context`, `base`), only to converted versions |
| open To check item with an output in its `focus` | `toCheck` on that output's version, focus ids made bare; an accepted one also gets `tocheck.resolved` |
| a listed output with no version | `outputs.changed {by: rule, missing}`: the task's reason when it reported `missing`, else "The run ended without reporting it." |
| `reply` | `agent.message {from: main, to: researcher}`, same row |
| non-root `thread.started` | `role` (`worker` for a task or check thread, else `main`); `task` and `attemptId` removed |
| `person.message` | task fields (`taskId`, `itemId`, `go`, `marks`) removed; one left with no text is deleted |

Not converted, and listed in the report: outputs the catalog lacks (`oriented-volume`), scores, an output
whose file is in `scratch/`, To check items that name no output ("Marked to check", a skip).

New event ids are `convert:<runId>:<output>`; `seq` continues after the run's last.

## Which databases

The per-run INSERT applies to the run with that id, or to a copy of its log under another id (a
`seed:example` example): the same first `revision.started`, the same event count and the same last event id and seq, on an ended run (a run that gained
events since the fetch is left as it is). Every other
database (a worktree's) gets only the tail: `reply`, `thread.started`, `person.message`, the deletes of the task-only types,
`harness` set to `agents` on ended task runs (a task run not `ended` is left alone) and their root thread, and the pinned path
`workflows/workflow-mouse-oa` renamed to `workflows/mouse-oa` (the web bundles the catalog by that path). Those runs keep their
conversation and lose their task outputs.

A converted run's `pi_messages` and its R2 snapshot are the task loop's. `messageRefusal` refuses a
message to a run whose `harness` is not `agents` (409), so no task run gains events before the deploy.
A converted run, once `agents`, could be reopened on the task loop's snapshot, which has no
`outputs.yaml`: delete its `runs/<id>/workflow/.snapshot-done` marker (after the deletion PR is live) so a
reopen re-snapshots.

`\u0000` in a `reply`, `person.message` or `thread.started` payload would fail the tail's casts and
abort the deploy; staging holds none (only two `tool.result` rows).

The 24 raw streams are in `~/.local/share/voluma-backups/task-loop-streams/`.
