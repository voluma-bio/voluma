# Run agents

The roles every workflow run uses, one file each, in `workflows/core/agents/`. A file's frontmatter
says what the role is and holds; its body is that role's job, read by the role on every run. The
roles are the same for every workflow: what a workflow adds is its skill (`workflows/<name>/skills/`),
its task list (`tasks.json`, whose `instructions` and `doneWhen` both the worker and the checker of a
task read) and its examples of work done right.

| File | Role |
|---|---|
| `main.md` | Coordinates the run: plans it, starts a worker per task, routes the checkers' questions, decides what is fixed, accepted or skipped |
| `worker.md` | Does one task in its sandbox and leaves the files, views and numbers it is judged by |
| `check.md` | Inspects one submitted task from its files, blind to the worker's reasoning, and gives one verdict |

Every `.md` here except `AGENTS.md` is parsed as a role file; `main.md` is required. A stray `README.md`, or a draft without frontmatter, fails every run's load. A run
snapshots the files with its workflow (`packages/workflow/src/load.ts`) and reads them from the
snapshot, so a resumed thread gets the text it began with; a changed file reaches only runs started
after it. A snapshot that has `checker.md` and no `check.md` (a run from before the rename) is refused at load: that run can't be resumed.

## Frontmatter

- `name`: the file name without `.md`.
- `description`: what the role is, for whoever reads the file.
- `model`: an alias (`wonder`, `opus`, `astra`) the runner's config maps to a provider model.
- `thinking`: optional; Pi's thinking level for the role's threads (`off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`). Unset: the runner's `RUNNER_THINKING`, else no level is sent. A run fails at start if
  the role's model lacks a non-off level set here or in `RUNNER_THINKING`. Explicit `off` overrides
  the runner's level and requests no effort; on Muse this uses the provider's default, not disabled
  reasoning. A visitor run is always `off`. When
  `RUNNER_MODEL` forces every role onto one model (a plumbing check), the role files' levels are ignored
  and `RUNNER_THINKING` alone sets the level. The level is not recorded in the
  log, so a resumed thread takes it from the snapshotted file and the runner's current
  `RUNNER_THINKING`.
- `tools`: every tool the role holds, base tools included, from the harness registry. A tool not
  listed is not granted: that, not prose, is how the checker holds no `segment_sam` (its role still
  has to say it does not redo the task, since bash can run the classic segmentation).
  `segment_sam` is granted only when the runner has a gateway, and only to a role with a sandbox.
- Holding `bash` is what gives a role a sandbox; code reads that, never the role's name.
- `scratch`: optional, `own` (default: the sandbox writes only its own `/scratch/<name>/`; the rest of
  `/scratch` is read host-side) or `all` (all of `/scratch` is writable). Needs `bash`.
- `outputs`: optional, `read` (default) or `write`: the access to `/outputs`. `write` and
  `segment_sam` need `bash`; `segment_sam` is granted only with `outputs: write`.
- `checkedBy`: the role that checks a task this role submits (`worker`: `check`). A role holding
  `submit_task` must name one. A role that is some role's `checkedBy` is a reviewer: its prompt says
  so, and it opens only the scratch files the attempt under review cites.
- `subagents`: the roles this role may start (`main`: `[worker]`), through `start_agent {role, task, brief}`.
  A role holding `start_agent` lists at least one. The checker is
  started by code on every `submit_task` and is never listed.
- `skills`: optional; the skills named in the role's prompt. Default: the workflow's whole skill list,
  the workflow's own skill first.

Any other key fails the load.

Each thread records the role file it runs on as `kind` on its `thread.started` (the role file's name).
What it may do is read from that file in the run's snapshot, which never changes, so nothing else is
recorded. Limit: whether a thread is a worker or a checker still comes from the fields of its start
(task, attempt: `threadPlace`), so `start_agent` starts roles that do a task as a worker does, and a
`checkedBy` role is a checker; other thread shapes need a change there.

## What stays in the harness

Environment text is generated, not written here: the sandbox's mounts and write rules, the Python in
the image, tool schemas, the skill list and the tool index (one line per resource script, from its
docstring), the task and its declared outputs in a thread's first message. These files state the job
only, so they survive a change of sandbox or harness.

## What code enforces

The roles are told none of these; code keeps them (why each holds:
`archive/voluma/kb/run-model.md` in the docs repo, `voluma-bio/docs`):

- every effect is an event appended before it is visible, so a resumed run replays it;
- a checker on every submitted task, by an agent that did not do it; a task is done only on a passed
  verdict;
- a check has no time limit, and an ask limit; a check that ends without a verdict makes the task
  to-check;
- fix rounds are bounded: after N `needs-review` verdicts on one task (default 2, runner config), it
  is to-check;
- feedback to a task stops the agents of every task that depends on it, and marks stale those that
  had begun;
- one writer per task; the checker's `/outputs` is read-only;
- `finish_run` is refused while a selected output is neither reported nor missing with a reason, or
  while an agent runs; a run ended by code records each unreported selected output as missing.
