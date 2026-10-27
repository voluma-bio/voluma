## Changelog

- Added: a working pnpm workspace where `pnpm i && pnpm check` lints, typechecks and tests every package, locally and in CI
- Added: one design token set with a light theme (workflows, runs) and a dark theme (review), and shared UI components shown at `/dev/ui`
- Added: a PR template and a PR-body check (`pnpm check:pr-body <body.md>`)

## Why

The run lane and the review lane split after the contracts PR, and each owner
works with several coding agents at once. Before that, the repo needs every
shared file in place so neither lane has to touch the other's files early:
the workspace, the check command, the design tokens, the shared components
and the rules agents follow. This is step 1 of the tech-lead handoff and
implements "Repo setup" in the [requirements].

## What changed

- **Workspace.** pnpm workspaces over `apps/*` and `packages/*`; Biome for lint and format; Nx only caches `typecheck` and `test` per package (target defaults, cache kept inside each worktree, no plugins, no daemon). `pnpm check` = Biome over the repo, then `nx run-many -t typecheck test`. Pre-commit runs Biome on staged files; nothing runs on push. CI (`.github/workflows/ci.yml`) runs `pnpm i && pnpm check`.
- **Packages and apps, one owner each.** Empty, typed shells with a purpose header: `packages/contracts` (with `fixtures/`), `workflow`, `api-client`, `viewer`; `apps/api` (a Cloudflare Worker answering `/health`); `workflows/mouse-oa-knee` (`SKILL.md` stub, `scripts/`, `pyproject.toml`). Packages export their TypeScript source, so there is no build step between them.
- **Web shell.** `apps/web` is React 19 + Vite + React Router 8. Each feature exports its own routes and sets its own theme; `src/shell/app.tsx` only mounts them, so a lane adds screens without editing the shell. Biome fails the lint when `features/run` and `features/review` import each other, or when a feature calls `fetch` instead of going through `@voluma/api-client`.
- **Design tokens.** `packages/design-tokens/src/tokens.css` unifies the two mockups' variables (`--ink`/`--paper`/`--pine` in `start.html`, `--fg`/`--bg`/`--accent` in `review-live.html`) into one set of semantic names, with a light and a dark theme selected by `data-theme` on any element, plus the viewer's values: axis colours, ivory bone, rulers, the amber outline under check, and a structure label palette. `theme.css` maps them into Tailwind v4 with `@theme inline` and removes Tailwind's default palette, so a raw colour class doesn't exist. The file header maps each mockup variable to its token.
- **Shared components.** `packages/ui` has Button, SplitPanel (resizable, keeps both panes mounted), StatusBadge (takes a tone, not a domain status), Card, ChatThread with composer, Lightbox (native `<dialog>`) and Table, styled only from tokens. `/dev/ui` renders all of them and every token in both themes.
- **PR template and check.** `.github/PULL_REQUEST_TEMPLATE.md` has six sections. `tools/ci/check-pr-body.mjs` is ported from meridian-flow: it reads the required headings from the template, and adds three rules: UI paths (`apps/web/src`, `packages/ui`, `packages/viewer`, `packages/design-tokens`) need a screenshot or "No visual change"; a PR touching `packages/contracts` can't write "None." under Contract changes; Changelog lines only need an Added/Changed/Fixed/Removed prefix. It runs on PR open and edit, skips drafts.
- **Docs.** `AGENTS.md` is rewritten for agents without Meridian: exact commands, the ownership map, how to handle a contract change, one worktree per agent, trunk-based PRs, and where decisions and deferred work go. Agents merge their own PRs once approved and green, and push tiny changes (a typo, a doc line, a one-line fix in their own lane that nothing user-visible or contract-related depends on) straight to `main` after `pnpm check`. It no longer links deleted KB pages or `../voluma-legacy`. `CLAUDE.md` is an `@AGENTS.md` shim. New: `DESIGN.md` (visual rules as review points), `.context/CONTEXT.md` (architecture), `.context/decisions.md` (shared decision log), `.context/TODO.md`. `.agents/setup` now installs the workspace before the optional Meridian tooling.

Decisions with real alternatives: React Router over TanStack Router (fewer moving parts for four routes); Tailwind v4 over CSS modules (utilities read the tokens directly and the default palette can be removed); px-sized SplitPanel rather than a docking library (docking is deferred in the visual direction).

## Contract changes

Adds `packages/contracts` as an empty package with a `fixtures/` directory. It holds no schemas yet, so neither lane has anything to change; the four contracts and the fake OA6-1RK fixtures land in the next PR.

## Verification

- Ran: `pnpm i` from a clean clone (24.6 s), then `pnpm check`: 6.5 s cold, 1.3 s warm (all 7 typecheck targets from the Nx cache). A fresh worktree installs in 3.3 s and its first `pnpm check` takes 6.3 s.
- Ran: the lint boundaries with throwaway files. `features/run` importing `../review`, `features/review` importing `../run` or `../../features/run/x`, and `fetch(...)` inside a feature each fail `pnpm lint`; the shell importing both features passes.
- Ran: the pre-commit hook on a badly formatted file in `packages/workflow/src/`. Biome reformatted it and the commit carried the fixed file.
- Ran: `pnpm check:pr-body` on the template with `## Why` removed (fails, names the section), the unchanged template (fails on the placeholder changelog and each empty section), a body saying "None." under Contract changes with `packages/contracts` changed (fails), a UI change with no screenshot (fails), and a filled-in body (passes).
- Ran: `pnpm dev` and a Chromium run of `/dev/ui` at 1440×900 against no data (the page has its own samples). Two checkouts at once: the second Vite took 5174 and the second Wrangler took 8788; `/health` answered `ok` on both.
- Saw: both themes render from the same components. IBM Plex Sans and Mono load; the dark column's background is `rgb(11, 14, 16)` (`--canvas`); primary buttons are pine in light and mint in dark. The split panel resizes by drag and arrow keys, the lightbox closes on Escape and on Close, the chat composer sends on Enter. `/` and `/runs` are light, `/runs/OA6-1RK` is dark, `/nope` shows "Page not found". No console errors.

Light theme:

![/dev/ui, light theme](https://github.com/voluma-bio/voluma/blob/e7800a77b7bb3bf33b3bce2ab43f0b6e8a5a956e/.github/pr-assets/scaffold/dev-ui-light.png?raw=true)

Dark theme:

![/dev/ui, dark theme](https://github.com/voluma-bio/voluma/blob/e7800a77b7bb3bf33b3bce2ab43f0b6e8a5a956e/.github/pr-assets/scaffold/dev-ui-dark.png?raw=true)

Evidence lightbox, opened from the dark theme:

![Lightbox open over the dark theme](https://github.com/voluma-bio/voluma/blob/e7800a77b7bb3bf33b3bce2ab43f0b6e8a5a956e/.github/pr-assets/scaffold/dev-ui-lightbox-dark.png?raw=true)

No test added: nothing in the scaffold has a silent failure mode that the checks above don't show.

## Left out

- [ ] The four contracts and the fake OA6-1RK fixtures: the next PR (tech-lead handoff, step 2)
- [ ] `pnpm data:pull` for the OA6-1RK assets from R2: `.context/TODO.md`
- [ ] `uv.lock` for the workflow scripts once they have dependencies: `.context/TODO.md`
- [ ] Nx 24 and TypeScript 7 are out; the scaffold stays on Nx 23 and TypeScript 6 until someone checks the upgrades: `.context/TODO.md`

[requirements]: https://github.com/voluma-bio/docs/blob/main/work/microct-workflow-mvp/requirements.md
