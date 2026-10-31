# Voluma — Agent Instructions

Voluma turns a micro-CT scan into validated measurements where every number
traces to its evidence. The current build is the micro-CT workflow MVP: a
researcher picks the mouse OA workflow, adds a scan, watches the run, and
reviews the results per task in 3D. The contract is the [requirements]; the
screens are in the [visual direction] and its mockups. There are no real users
or data yet: change freely, delete unused code, and add no compatibility shims.

Two people build in parallel, each with several coding agents. Every rule
below exists so those agents never step on each other. Architecture and the
reasons behind the setup: [.context/CONTEXT.md](.context/CONTEXT.md).

## Commands

| Command | Does |
|---|---|
| `pnpm i` | Install; also installs the pre-commit hook. `pnpm check` also needs [uv](https://docs.astral.sh/uv/) for the Python in `workflows/` (on macOS or ARM, Docker too) |
| `pnpm check` | Lint, typecheck and tests across the workspace. CI runs the same |
| `pnpm db:up` | Start the local Postgres container (once per machine; needs Docker) |
| `pnpm dev` | API and web app on free ports, with this worktree's own database; prints both URLs |
| `pnpm dev:stop` | Stop this worktree's `pnpm dev` and runner processes (recorded in `.dev/pids/`), and no one else's |
| `pnpm worktrees:clean` | Read-only inventory of registered worktrees; automatic cleanup and `--yes` are disabled |
| `pnpm format` | Biome format and safe fixes |
| `pnpm check:pr-body <body.md>` | Check a PR body draft against the template |
| `pnpm --filter @voluma/runner start` | The runner service: claims queued runs from the API and runs them (`RUNNER_MODEL=openai/<id>` in `.env`; `pnpm dev` running locally, start a run in the browser); see [CONTEXT.md](.context/CONTEXT.md) |
| `pnpm --filter @voluma/<pkg> <script>` | One package's script, e.g. `pnpm --filter @voluma/api db:migrate` |

An agent that starts sandboxes runs `pnpm --filter @voluma/runner sandboxes:clean --run <id>` for each of its runs before it finishes (without `--run` it ends every agent's sandboxes).

Merging to `main` deploys to Render staging each service whose build filter (`render.yaml`) it touches: the API
(which serves the web app), the runner and the gateway, together and in no fixed order; see
[apps/api/.context/deploy.md](apps/api/.context/deploy.md).

Merges never wait for runs. A live run carries on through any number of these deploys: no
failure, no lost agent context, no human click. A change that would break a live run during the
deploy overlap (a column dropped while the old code still reads it, a narrowed stored event or
runner-facing response) ships in two PRs, expand first; anything that still breaks a live run is a
bug, not a reason to hold merges.

Pre-commit runs Biome on staged files. Nothing runs on push. Use pnpm, never npm.

## Boundaries

Anyone edits any part of the repo. Both of you hold full context on what the
other built, so a change that spans run and review is normal work, not an
exception: make it and say what changed and why, in the PR body and one
[decisions.md](.context/decisions.md) line. Telling each other after beats
asking before; a single coherent change lands faster than an approval round
and a half-migrated middle. "Run lane" and "review lane" in these docs name
areas of the app, never a person's patch.

What the structure still requires:

- Web features (`features/study`, `features/scan`) never import each other,
  and neither do `domains/run` and `domains/review` in the API. They share
  code only through `packages/` (and `apps/api/src/ports` on the server).
- Web features reach the API only through `@voluma/api-client`.
- Each web feature serves its routes; the shell mounts them and applies the user's theme.
- Each API domain serves every path under its prefix (`/run/`, `/review/`).
  A domain is built by a factory taking its own dependency type, written in
  ports. Only `apps/api/src/index.ts` reads `env` and builds adapters. One
  domain reaches the other through a port that `index.ts` wires, never an
  import.

## Contract changes

`packages/contracts` holds the schemas everything builds against, so a change
there reaches every caller at once. Two shapes work:

- **Standalone PR** when the change can land before the code that uses it:
  only `packages/contracts`, `packages/api-client` and, for a new dependency,
  the lockfile. Merge `origin/main` into the feature branch once it lands.
- **One PR with both sides** when a breaking change has to land at once:
  rename, reshape or remove a field in the contract and in every caller
  together, so there is no red base and nothing left half-migrated.

Either way the PR body names what breaks and which callers moved.

A change that could stop a stored event from parsing (a new required field or
a narrowed shape anywhere in a payload, recorded plans included) converts the
stored events in an SQL migration in `apps/api/drizzle`, applied on deploy, and
ships in two steps, expand then contract, so a live run survives the deploy overlap. Step 1: the field optional (or the shape still wide), an
idempotent migration, and the code reading the old shape in one function marked
for deletion. Step 2, after step 1 is live: a PR that re-runs the migration, makes
the field required and deletes the fallback. Note step 2 in the package's
`.context/TODO.md`. `payload` is `json` because some payloads hold `\u0000`:
read or cast payload fields only inside `CASE WHEN type = '<type>' THEN … END`,
since Postgres may evaluate the json condition before the `type` filter. Before step 2, parse every staging run's
events with the new `runEventSchema`: fetch each run's log from
`GET /api/run/runs/:id/stream` with `VOLUMA_DEBUG_TOKEN` (agents can't reach
staging's database). A query for the fields you think changed is not enough: it
missed the recorded plans that took the runs list down after #177.

## Working in parallel

One worktree and branch per agent, created from the primary checkout:

```bash
git fetch origin
git worktree add ../voluma.worktrees/<name> -b <owner>/<topic> origin/main
cd ../voluma.worktrees/<name> && pnpm i
```

- Worktrees share nothing mutable: no fixed dev ports (`pnpm dev` picks
  free ones), no shared database (it makes one per worktree), Nx cache per worktree, no Nx daemon.
  The exception is R2: every worktree and staging use one bucket, so a script
  that writes R2 writes only keys staging never reads (`dev/…`, a local
  example's `example-local-<runId>`); see `apps/api/AGENTS.md`.
- The machine is shared. To stop `pnpm dev`, the runner (`start`, `try-run`) and their
  children, run `pnpm dev:stop`: it stops only the process groups this worktree
  recorded in `.dev/pids/` (SIGTERM, SIGKILL after 55 s so a runner can release its runs; never `kill -9` the group yourself) and lists anything else still running here. Stop any other
  process only by the PID you recorded when you started it. Never stop one by name or
  pattern: `pkill -f` and `pgrep -f` match anywhere in a command line, which hits other
  agents' dev servers and any agent session launched with a prompt that contains the
  pattern; `killall` hits every process with that name. Start another long-running
  process as `setsid <cmd> > <log> 2>&1 & echo $! > <pidfile>`, and stop it and its
  children with `kill -- -$(cat <pidfile>)`. If you lost the PID, leave the process
  running and say so in your report.
- Small PRs to `main`. Keep your branch current with
  `git merge origin/main`. Never rebase, force-push or commit to someone
  else's branch.
- Commit and push early, so the other person sees work in progress: push
  after the first commit and open a draft PR (`gh pr create --draft`, with
  the template body filled as far as you can). Push again as you go. Mark
  it ready when it passes `pnpm check` and its review.
- Open PRs with [the template](.github/PULL_REQUEST_TEMPLATE.md).
  `gh pr create --body-file` skips it: copy every `##` section into your body
  file and run `pnpm check:pr-body <file>` first.
- Don't wait for a human: merge your own PR once CI is green. When it
  changes behaviour (product logic, the harness, analysis) or structure
  (packages, boundaries, interfaces, the workspace), first have a fresh
  agent review it (one that didn't write it, given the diff and the PR
  body) and fix what it finds. Docs and small config PRs need no review.
- Tiny changes skip the PR: a typo, a comment, a doc line, or a one-line fix
  or config tweak that changes nothing a user sees and
  doesn't touch `packages/contracts`. Run `pnpm check`, then
  `git push origin HEAD:main`. If the push is rejected, `git merge
  origin/main` and push again.
- On a `pnpm-lock.yaml` conflict, take either side and run `pnpm i`; it
  re-resolves the lockfile. Shared dependency versions live in the
  `catalog` in `pnpm-workspace.yaml`.
- Screenshots for a PR go in `.github/pr-assets/<branch>/`, linked at a commit.
- When the PR merges, clean up: stop your dev servers, then
  `git worktree remove ../voluma.worktrees/<name>` and `git branch -d <branch>`.
  First preserve local work, including ignored files such as `.data/` and `.env`,
  and confirm the checkout is no longer in use. `pnpm worktrees:clean` only lists
  registered worktrees; it does not establish that any resource is disposable.
  Automatic cleanup is disabled pending the [preservation policy](tools/.context/TODO.md).

## Shared memory

Other agents don't share your session or tools. Write down what
they need:
- **Decisions**: append one dated line to
  [.context/decisions.md](.context/decisions.md) when you settle something
  someone else will build on, linking the PR. Read it before starting work.
- **Deferred work** in one directory: `.context/TODO.md` in that directory.
  Cross-cutting items: a GitHub issue.
- When a change shifts how a directory works, update its `AGENTS.md` or
  `.context/` in the same PR.

## Conventions

- Apps are thin shells. Logic lives in packages or in `apps/api` domains, not
  route handlers or components.
- Domain code depends on interfaces; config picks the adapter at the
  composition root. Add an interface only where a second adapter is plausible
  (a local fake counts), and give each one a local adapter from day one.
- Lint is Biome's recommended rules, plus `noImportCycles`: an import cycle
  fails `pnpm check` (vitest tolerates cycles, `tsx` and Node do not). The
  boundaries above are rules to follow, not lint checks.
- Colours come only from `packages/design-tokens`; components use token
  utilities (`bg-card`, `text-muted-foreground`). Visual rules: [DESIGN.md](DESIGN.md).
  Every shared component has a story beside it (`*.stories.tsx`) shown in both themes in
  Storybook: `pnpm --filter @voluma/storybook storybook`.
- Workflows and analysis code live in `workflows/`. `workflows/core/` is shared
  by every run: the role files (`agents/`) and the generic micro-CT skills
  (`skills/`). A workflow is `workflows/<name>/`: `outputs.json` (every output
  a run can produce), `tasks.json` (the task list) and `skills/<skill>/`
  (`SKILL.md`, `references/`, `resources/`), e.g. `workflows/mouse-oa`, the mouse
  knee workflow. Models come from runner config. A run snapshots `core/` and its
  workflow's directory and nothing else. Python lives only in
  `workflows/`, as skill resources: CLI scripts that take and return paths,
  never bytes. Their dependencies are
  `workflows/core/requirements.txt`, compiled from `requirements.in`;
  changing it means running the "Sandbox image" workflow and updating `SANDBOX_IMAGE` in `apps/runner/src/config.ts`.
  `pnpm check` runs ruff and pytest
  there through `uv`; the sandbox image is linux/x86_64, so on macOS or ARM the
  Python tests run in a `linux/amd64` Docker container.
- Test against the real thing, not fakes: real OA6-1RK data, the real API,
  the real sandbox. No fixture data and no mock transports. Add a unit test
  only where a bug would be silent and expensive (the stale-task graph, unit
  conversions). A feature is shown to work by a browser run on real data,
  with screenshots in the PR. When a package gets its first test, give it
  a `"test": "vitest run"` script; `pnpm check` picks it up.
- Comments: a file header says what the file is for. Inline comments explain
  only hidden constraints, units and workarounds.
  Comments state what is true now; plans go in .context/TODO.md.
- Writing for people (UI copy, PR bodies, docs): lead with the point, use
  plain labels, and phrase choices as the user's decisions.

## Optional tooling

`meridian.toml`, `mars.toml` and `.agents/` configure Meridian agent tooling
for whoever uses it. Nothing in this repo requires it.

[requirements]: https://github.com/voluma-bio/docs/blob/main/work/microct-workflow-mvp/requirements.md
[visual direction]: https://github.com/voluma-bio/docs/blob/main/work/microct-workflow-mvp/mockups/direction.md
