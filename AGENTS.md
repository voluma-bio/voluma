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
| `pnpm i` | Install; also installs the pre-commit hook |
| `pnpm check` | Lint, typecheck and tests across the workspace. CI runs the same |
| `pnpm dev` | Web app; Vite prints the URL (it takes a free port) |
| `pnpm format` | Biome format and safe fixes |
| `pnpm check:pr-body <body.md>` | Check a PR body draft against the template |
| `pnpm --filter @voluma/<pkg> <script>` | One package's script, e.g. `pnpm --filter @voluma/api dev` |

Pre-commit runs Biome on staged files. Nothing runs on push. Use pnpm, never npm.

## Ownership

| Path | Owner |
|---|---|
| `apps/web/src/features/run`, `apps/api`, `packages/workflow`, `packages/api-client` | Run lane |
| `apps/web/src/features/review`, `packages/viewer` | Review lane |
| `packages/contracts` | Both; contract PRs only |
| `packages/design-tokens`, `packages/ui`, `apps/web/src/shell`, `apps/web/src/dev-ui`, root config, `tools/ci` | Both; small PRs |

- Edit only your lane's directories. When you need a change in the other
  lane's code, open a GitHub issue for its owner.
- `features/run` and `features/review` never import each other. Lanes share
  code only through `packages/`. Web features call the API only through
  `@voluma/api-client`. Biome fails the lint on all three.
- Each feature owns its routes and theme; the shell only mounts them.

## Contract changes

`packages/contracts` holds the schemas both lanes build against. Never edit
it inside a feature PR. When you need a contract change:
1. Stop the feature work that depends on it.
2. Open a separate PR that changes only `packages/contracts` (schema and
   fixtures), and ask both owners to review it. If you can't, open an issue
   describing the change and build against the current contract.
3. Merge `origin/main` into your branch once it lands, then continue.

## Working in parallel

One worktree and branch per agent, created from the primary checkout:

```bash
git fetch origin
git worktree add ../voluma.worktrees/<name> -b <owner>/<topic> origin/main
cd ../voluma.worktrees/<name> && pnpm i
```

- Worktrees share nothing mutable: no fixed dev ports (Vite and Wrangler pick
  free ones), no shared database, Nx cache per worktree, no Nx daemon.
- Small PRs to `main`. Keep your branch current with
  `git merge origin/main`. Never rebase, force-push or commit to someone
  else's branch.
- Open PRs with [the template](.github/PULL_REQUEST_TEMPLATE.md).
  `gh pr create --body-file` skips it: copy every `##` section into your body
  file and run `pnpm check:pr-body <file>` first.
- Don't wait for a human: merge your own PR once CI is green. When it
  changes behaviour (product logic, the harness, analysis), first have a
  fresh agent review it (one that didn't write it, given the diff and the
  PR body) and fix what it finds. Setup, config and docs PRs need no
  review. Contract PRs are the exception: both owners approve them.
- Tiny changes skip the PR: a typo, a comment, a doc line, or a one-line fix
  or config tweak in your own lane that changes nothing a user sees and
  doesn't touch `packages/contracts`. Run `pnpm check`, then
  `git push origin HEAD:main`. If the push is rejected, `git merge
  origin/main` and push again.
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
- Colours come only from `packages/design-tokens`; components use token
  utilities (`bg-surface`, `text-fg-muted`). Visual rules: [DESIGN.md](DESIGN.md).
  Check shared components at `/dev/ui` in both themes.
- Workflows and analysis code are not in this repo. A workflow is a Mars
  schema v1 package on GitHub (`mars.toml`, skills, `workflow.md`), imported
  and pinned to a commit; the generic micro-CT skills are
  [voluma-bio/microct-analysis]. This repo holds no Python. Analysis tools
  take and return paths, never bytes.
- Tests: add one only where a bug would be silent and expensive (the
  stale-task graph, unit conversions). A feature is shown to work by a browser
  run with screenshots in the PR. When a package gets its first test, give it
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
[voluma-bio/microct-analysis]: https://github.com/voluma-bio/microct-analysis
