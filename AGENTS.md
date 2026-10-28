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
| `pnpm i` | Install; also installs the pre-commit hook. `pnpm check` also needs [uv](https://docs.astral.sh/uv/) for the Python in `workflows/` |
| `pnpm check` | Lint, typecheck and tests across the workspace. CI runs the same |
| `pnpm db:up` | Start the local Postgres container (once per machine; needs Docker) |
| `pnpm dev` | API and web app on free ports, with this worktree's own database; prints both URLs |
| `pnpm format` | Biome format and safe fixes |
| `pnpm check:pr-body <body.md>` | Check a PR body draft against the template |
| `pnpm --filter @voluma/runner start` | The runner service: claims queued runs from the API and runs them (`RUNNER_MODEL=openai/<id>` in `.env`; `pnpm dev` running locally, start a run in the browser); see [CONTEXT.md](.context/CONTEXT.md) |
| `pnpm --filter @voluma/<pkg> <script>` | One package's script, e.g. `pnpm --filter @voluma/api db:migrate` |

An agent that starts sandboxes runs `pnpm --filter @voluma/runner sandboxes:clean --run <id>` for each of its runs before it finishes (without `--run` it ends every agent's sandboxes).

Merging to `main` deploys the API (which serves the web app) to Railway staging; see
[apps/api/.context/deploy.md](apps/api/.context/deploy.md).

Pre-commit runs Biome on staged files. Nothing runs on push. Use pnpm, never npm.

## Ownership

| Path | Owner |
|---|---|
| `apps/web/src/features/run`, `apps/api/src/domains/run`, `packages/workflow`, `packages/harness`, `apps/runner` | Run lane |
| `apps/web/src/features/review`, `apps/api/src/domains/review`, `packages/viewer` | Review lane |
| `workflows/microct-analysis` | Run lane |
| `workflows/mouse-oa` | Both; small PRs |
| `packages/contracts`, `packages/api-client` | Both; contract PRs only |
| `packages/design-tokens`, `packages/ui`, `apps/web/src/shell`, `apps/web/src/dev-ui`, `apps/web` and `apps/api` root files, `apps/api/src/index.ts`, `apps/api/src/ports`, root config, `tools/` | Both; small PRs |

- Edit only your lane's directories. When you need a change in the other
  lane's code, open a GitHub issue for its owner.
- `features/run` and `features/review` never import each other, and neither
  do `domains/run` and `domains/review` in the API. Lanes share code only
  through `packages/` (and `apps/api/src/ports` on the server).
- Web features reach the API only through `@voluma/api-client`.
- Each web feature owns its routes and theme; the shell only mounts them.
- Each API domain owns every path under its prefix (`/run/`, `/review/`).
  A domain is built by a factory taking its own dependency type, written in
  ports. Only `apps/api/src/index.ts` reads `env` and builds adapters. One
  domain reaches the other through a port that `index.ts` wires, never an
  import.

## Contract changes

`packages/contracts` holds the schemas both lanes build against. Never edit
it inside a feature PR. When you need a contract change:
1. Stop the feature work that depends on it.
2. Open a separate PR that changes only `packages/contracts`,
   `packages/api-client` and, for a new dependency, the
   lockfile. It follows the same review rule as any PR: a fresh agent
   reviews it, then merge it once CI is green. A sweeping change waits for
   both owners to approve it: one that renames, reshapes or removes what the
   other lane already uses. Adding schemas, fields or calls is not
   sweeping.
3. Merge `origin/main` into your branch once it lands, then continue.

## Working in parallel

One worktree and branch per agent, created from the primary checkout:

```bash
git fetch origin
git worktree add ../voluma.worktrees/<name> -b <owner>/<topic> origin/main
cd ../voluma.worktrees/<name> && pnpm i
```

- Worktrees share nothing mutable: no fixed dev ports (`pnpm dev` picks
  free ones), no shared database (it makes one per worktree), Nx cache per worktree, no Nx daemon.
- Small PRs to `main`. Keep your branch current with
  `git merge origin/main`. Never rebase, force-push or commit to someone
  else's branch.
- Commit and push early, so the other lane sees work in progress: push
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
  body) and fix what it finds. Docs and small config PRs need no review. Sweeping contract changes also wait for both owners (see Contract changes).
- Tiny changes skip the PR: a typo, a comment, a doc line, or a one-line fix
  or config tweak in your own lane that changes nothing a user sees and
  doesn't touch `packages/contracts`. Run `pnpm check`, then
  `git push origin HEAD:main`. If the push is rejected, `git merge
  origin/main` and push again.
- On a `pnpm-lock.yaml` conflict, take either side and run `pnpm i`; it
  re-resolves the lockfile. Shared dependency versions live in the
  `catalog` in `pnpm-workspace.yaml`.
- Screenshots for a PR go in `.github/pr-assets/<branch>/`, linked at a commit.
- When the PR merges, clean up: stop your dev servers, then
  `git worktree remove ../voluma.worktrees/<name>` and `git branch -d <branch>`.

## Shared memory

Agents in the other lane don't share your session or tools. Write down what
they need:
- **Decisions**: append one dated line to
  [.context/decisions.md](.context/decisions.md) when you settle something
  the other lane must know, linking the PR. Read it before starting work.
- **Deferred work** in one directory: `.context/TODO.md` in that directory.
  Cross-lane items: a GitHub issue.
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
  Check shared components at `/dev/ui` in both themes.
- Workflows and analysis code live in `workflows/`. A workflow is a Mars
  schema v1 package (`mars.toml`, skills, agents, `workflow.md`):
  `workflows/microct-analysis` holds the generic micro-CT skills,
  `workflows/mouse-oa` the mouse knee workflow. A run pins the voluma commit;
  the catalog names the workflow's directory. Python lives only in
  `workflows/`, as skill resources: CLI scripts that take and return paths,
  never bytes. Their dependencies are
  `workflows/microct-analysis/requirements.txt`; changing it republishes the
  sandbox image. `pnpm check` runs ruff and pytest there through `uv`.
- Test against the real thing, not fakes: real OA6-1RK data, the real API,
  the real sandbox. No fixture data and no mock transports. Add a unit test
  only where a bug would be silent and expensive (the stale-task graph, unit
  conversions). A feature is shown to work by a browser run on real data,
  with screenshots in the PR. When a package gets its first test, give it
  a `"test": "vitest run"` script; `pnpm check` picks it up.
- Comments: a file header says what the file is for. Inline comments explain
  only hidden constraints, units and workarounds.
- Writing for people (UI copy, PR bodies, docs): lead with the point, use
  plain labels, and phrase choices as the user's decisions.

## Optional tooling

`meridian.toml`, `mars.toml` and `.agents/` configure Meridian agent tooling
for whoever uses it. Nothing in this repo requires it.

[requirements]: https://github.com/voluma-bio/docs/blob/main/work/microct-workflow-mvp/requirements.md
[visual direction]: https://github.com/voluma-bio/docs/blob/main/work/microct-workflow-mvp/mockups/direction.md
