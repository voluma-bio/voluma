# Repo architecture

How the workspace fits together and why it is set up this way. Rules and
commands are in [AGENTS.md](../AGENTS.md).

## Shape

```
apps/web        React + Vite. shell/ mounts routes; features/run and features/review own screens
apps/api        Cloudflare Worker. src/index.ts is the composition root: the only code that
                reads env; it builds adapters/ for the ports/ and mounts domains/run at /run/
                (runs, the event log, sandboxes) and domains/review at /review/
                (review data, chat threads, corrections)
apps/runner     Node entry point that runs the agent harness against the API (Run lane)
packages/
  contracts     zod schemas for the four contracts and the shared formats
  harness       the agent harness: our tools, the Sandbox and EventLog ports, the Pi
                adapter; runtime-neutral (no Node or Worker types)
  workflow      pure functions over a workflow package: read and validate it, task graph, stale tasks
  api-client    typed commands and event stream; the only way web features reach the API
  viewer        three.js 3D view and slice planes with a thin React wrapper
  ui            shared React components, styled from tokens
  design-tokens tokens.css (raw values, two themes) and theme.css (Tailwind mapping)
tools/ci        PR-body check
```

Dependencies point down: apps → feature code → packages. `contracts` and
`design-tokens` depend on nothing.

## The agent runtime

The agent loop is Pi's (`@earendil-works/pi-agent-core`), used as it comes;
we add our own pieces only when a real run needs them. The agent runs
outside the sandbox, so credentials never enter it. A run is a tree of
threads: a supervisor (the root), a worker that goes through the task
checklist, check threads, and review chat threads.
- **Event log.** Ours, kept separately from Pi's history: the `threads` and
  `events` tables in D1, behind the run domain's API. Each event is saved
  before it is published, and `seq` (per run) is the stream cursor. Both the
  UI and the review read this log. Pi's own messages go in `pi_messages`,
  one row per message, so a thread can resume.
- **Sandboxes.** One Cloudflare Sandbox Durable Object per sandbox. It
  mounts R2 prefixes that don't overlap: the workflow and the inputs
  read-only, the run's scratch and outputs read-write. It has no internet,
  and R2 credentials stay in the Worker.
- **Where the runner lives.** For now it's a Node process (`apps/runner`)
  that talks to the API. Whether it moves into a Durable Object per run is
  decided after the first real run.

The design, the evidence behind it and the order of work are in the
voluma-bio/docs work item `mvp-contracts-and-data` (`design/harness-v0.md`).

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

Import boundaries are Biome `noRestrictedImports` and `noRestrictedGlobals`
overrides in `biome.json`.

## Theming

`tokens.css` defines semantic custom properties under `:root` and
`[data-theme="light"]`, and again under `[data-theme="dark"]`. `theme.css`
maps them into Tailwind with `@theme inline`, so a utility reads the token
where it is used and `data-theme` on any element themes its subtree. That is
how `/dev/ui` shows both themes side by side, and how the review page turns
dark inside a light app. Tailwind's default palette is removed.

The viewer's colours (axes, bone, rulers, labels) are tokens too. Canvas and
WebGL code reads them with `getComputedStyle` rather than copying values, so
the CSS stays the one source.

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
