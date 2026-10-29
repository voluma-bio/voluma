# Run agents

The roles every workflow run uses, one file each. A file's frontmatter says which optional tools the
role holds; its body is that role's job, read by the role on every run. They are the same for every
workflow: what a workflow adds is its own skill (`workflows/workflow-<name>/SKILL.md`) and the skill
directories it `uses`.

**Status.** The runner builds the worker's and checker's system prompts and tool grants from
`worker.md` and `checker.md` (`apps/runner/src/prompts.ts`): edit a file and the next run's new
threads get the text. `lead.md` and `review-chat.md` are marked `status: planned`: loaded and
validated, used by nothing yet. The main thread still runs on `MAIN_SYSTEM` in
`packages/harness/src/main-thread.ts`, and has no tools and does not choose what runs; `lead.md`
is the target (the main thread as a lead that owns the plan). Moving it onto these files, with the
lead's tools, fix tasks and label versions, is Run lane work in `packages/harness` and
`apps/runner`.

A run snapshots the files with its workflow (`packages/workflow/src/load.ts`) and reads them from
the snapshot, so a resumed thread gets the text it began with; a changed file reaches only threads
started after it.

| File | Role |
|---|---|
| `lead.md` | The main thread: owns the run's plan, starts and steers workers, decides what to fix, redo or cut |
| `worker.md` | Does one task in the sandbox and reports its outputs |
| `checker.md` | Re-derives one finished task's results and gives a verdict |
| `review-chat.md` | Answers the researcher about a finished run from its record |

## Frontmatter

All keys are required except `status`; any other key fails the load.

- `name`: the file name without `.md`.
- `description`: what the role is, for whoever starts it.
- `tools`: the optional tools the role is granted, from `packages/harness/src/tools/registry.ts`
  (today `view_image`, `segment_sam`). A name not there fails the load; a tool not listed is not
  granted. This is how "the checker does not rerun SAM" is enforced, not prose in a skill.
  `segment_sam` is also granted only when the run has a Meta key. The harness's own tools (`bash`,
  task tools, `thread_message`) are not listed and not configurable; code keeps their refusals (a
  checker cannot report outputs or set status).
- `status: planned`: nothing uses the role yet, so its `tools` (which may name tools that do not
  exist) are not checked against the registry.

Models are runner config (`RUNNER_MODEL`, `RUNNER_CHECK_MODEL`, `RUNNER_MAIN_MODEL`), and every
role is told the same skill list: the workflow's skill, then each skill of the directories it `uses`.

## What stays in the harness

Environment text is generated, not written here: the sandbox's paths and mount rules, the Python
packages in the image, tool schemas, the task brief, declared outputs and notes in a thread's first
message. These files state the job only, so they survive a change of sandbox or harness.

## What the supervisor still enforces

The lead is told these limits but does not police them; code does:

- every choice the lead makes is recorded as an event before it applies, so a resumed run replays it;
- the run's spend cap (`RUNNER_MAX_RUN_COST_USD`);
- a third fix round on one concern ends patching and goes to the researcher as a To check item;
- a run cannot end with a selected output unreported: each is reported, or null with a reason;
- every task that reports a measurement is checked.
