# Run agents

The roles every workflow run uses, one file each. A file's frontmatter says which model config it
runs on, which tools it holds and which skills it loads; its body is that role's job, read by the
role on every run. They are the same for every workflow: what a workflow adds is its own skill
(`workflows/workflow-<name>/SKILL.md`) and the skill directories it `uses`.

**Status: mockup, not wired.** The runner still builds role prompts in code
(`apps/runner/src/prompts.ts` for worker and checker, `MAIN_SYSTEM` in
`packages/harness/src/main-thread.ts` for the main thread), and the main thread has no tools and
does not choose what runs. These files are the target: the main thread as a lead that owns the
plan. Wiring them in (loading these files, the lead's tools, fix tasks, label versions) is Run
lane work in `packages/harness` and `apps/runner`.

| File | Role |
|---|---|
| `lead.md` | The main thread: owns the run's plan, starts and steers workers, decides what to fix, redo or cut |
| `worker.md` | Does one task in the sandbox and reports its outputs |
| `checker.md` | Re-derives one finished task's results and gives a verdict |
| `review-chat.md` | Answers the researcher about a finished run from its record |

## Frontmatter

- `name`, `description`: what the role is, for whoever starts it.
- `model`: the runner config key that picks its model (`RUNNER_MAIN_MODEL` and so on), never a model id.
- `tools`: the tools the role holds. A tool not listed is not granted; this is how a rule like
  "the checker does not rerun SAM" is enforced, not prose in a skill.
- `skills.load`: skills put in the role's prompt in full. `skills.available`: listed with their
  descriptions, read when a step needs one. `workflow` means the run's workflow skill;
  `workflow-uses` means every skill of the directories it `uses`.

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
