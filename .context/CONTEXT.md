# Repo architecture

How the workspace fits together and why it is set up this way. Rules and
commands are in [AGENTS.md](../AGENTS.md).

## Shape

```
apps/web        React + Vite. shell/ mounts routes; features/run and features/review own screens
apps/api        Cloudflare Worker. src/index.ts is the composition root: the only code that
                reads env; it builds adapters/ for the ports/ and mounts domains/run at /run/
                (agent runtime ported from voluma-legacy, supervisor, thread store, sandboxes) and domains/review at /review/
                (review data, chat threads, corrections)
packages/
  contracts     zod schemas for the four contracts and the shared formats
  workflow      pure functions over a workflow package: read and validate it, task graph, stale tasks
  api-client    typed commands and event stream; the only way web features reach the API
  viewer        three.js 3D view and slice planes with a thin React wrapper
  ui            shared React components, styled from tokens
  design-tokens tokens.css (raw values, two themes) and theme.css (Tailwind mapping)
tools/ci        PR-body check
```

Dependencies point down: apps → feature code → packages. `contracts` and
`design-tokens` depend on nothing.

## Packages export source

Every package's `exports` points at `src/*.ts`. There is no build step
between packages: Vite and `tsc` read the source directly, so an edit in a
package shows up in the app at once. Packages get a build only if something
outside the workspace consumes them.

## Checks

`pnpm check` runs Biome over the whole repo, then `nx run-many -t typecheck
test`. Nx caches each package's typecheck and test against its inputs and
its dependencies' inputs, so an unchanged package costs nothing on the next
run. Nx config is target defaults and caching only. A package joins
`typecheck` or `test` by having that script in its `package.json`.

Import boundaries are written rules in `AGENTS.md`; Biome uses its recommended rules.

## Theming

`tokens.css` defines semantic custom properties under `:root` and
`[data-theme="light"]`, and again under `[data-theme="dark"]`. `theme.css`
maps them into Tailwind with `@theme inline`, so a utility reads the token
where it is used and `data-theme` on any element themes its subtree. That is
how `/dev/ui` shows both themes side by side. Review now selects light, following
Andrew's implementation direction. Tailwind's default palette is removed.

The viewer's colours (axes, bone, rulers, labels) are tokens too. Canvas and
WebGL code reads them with `getComputedStyle` rather than copying values, so
the CSS stays the one source.

## Review integration

The Review UI is in `apps/web/src/features/review`; persistent view slots are
in `packages/viewer`. There is one Review route, `/runs/:runId`, with no demo
route. The local workspace uses `runId=local` without creating a server run.
No synthetic measurements or simulated services are mounted.

`features/review/report/model.ts` is a presentation model, not the shared API
contract. Reports, revision selection and command UI remain available for the
real adapter; until it exists the workspace shows explicit empty states. Shared
contracts and API client are unchanged from main. Report/viewer splits retain
react-resizable-panels to preserve the verified nested maximize/restore behavior;
the unrelated shared `SplitPanel` API and `/dev/ui` remain unchanged.

## Parallel agents

Several agents from two people work at once, each in its own worktree.
Nothing they run shares mutable state:
- dev servers take free ports (Vite moves to the next free one);
- Nx keeps its cache in the worktree's `.nx/` and runs without a daemon;
- there is no shared database yet; when the thread store lands, each
  worktree gets its own local store;
- the pnpm store is shared, but it is content-addressed and append-only.

The pre-commit hook lives in the shared `.git`, so every worktree runs the
same hook.
