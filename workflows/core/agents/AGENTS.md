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
| `checker.md` | Inspects one submitted task from its files, blind to the worker's reasoning, and gives one verdict |
| `review-chat.md` | Answers the researcher about a finished run from its record (`status: planned`, used by nothing yet) |

Every `.md` here except `AGENTS.md` is parsed as a role file; `main.md`, `worker.md` and `checker.md`
are required. A stray `README.md`, or a draft without frontmatter, fails every run's load. A run
snapshots the files with its workflow (`packages/workflow/src/load.ts`) and reads them from the
snapshot, so a resumed thread gets the text it began with; a changed file reaches only runs started
after it.

## Frontmatter

- `name`: the file name without `.md`.
- `description`: what the role is, for whoever reads the file.
- `model`: an alias (`wonder`, `opus`, `astra`) the runner's config maps to a provider model.
- `tools`: every tool the role holds, base tools included, from the harness registry. A tool not
  listed is not granted: that, not prose, is how the checker holds no `segment_sam` (its role still
  has to say it does not redo the task, since bash can run the classic segmentation).
  `segment_sam` is granted only when the runner has a gateway, and only to a role with a sandbox.
- `subagents`: the roles this role may start (`main`: `[worker]`). The checker is started by code on
  every `submit_task` and is never listed. A role that holds `start_worker` must list `worker` (the loader refuses it otherwise).
- `skills`: optional; the skills named in the role's prompt. Default: the workflow's whole skill list,
  the workflow's own skill first.
- `status: planned`: nothing uses the role yet, so its tools are not checked against the registry.

Any other key fails the load.

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
- a check ends: a limit on the checker's active time (a runner outage does not use it up) and an ask
  limit; ending without a verdict makes the task to-check;
- fix rounds are bounded: after N `needs-review` verdicts on one task (default 2, runner config), it
  is to-check;
- feedback to a task stops the agents of every task that depends on it, and marks stale those that
  had begun;
- one writer per task; the checker's `/outputs` is read-only;
- `finish_run` is refused while a selected output is neither reported nor missing with a reason, or
  while an agent runs; a run ended by code records each unreported selected output as missing;
- the spend cap.
