# Repo architecture

How the workspace fits together and why it is set up this way. Rules and
commands are in [AGENTS.md](../AGENTS.md).

## Shape

```
apps/web        React + Vite. shell/ mounts routes; features/run and features/review own screens
apps/api        Cloudflare Worker. src/index.ts is the composition root: the only code that
                reads env; it builds adapters/ for the ports/ and mounts domains/run at /run/
                (runs, the event log) and domains/review at /review/
                (review data, chat threads, corrections)
apps/runner     Node entry point that runs the agent harness against the API (Run lane)
packages/
  contracts     zod schemas for the four contracts and the shared formats
  harness       the agent harness: our tools, the Sandbox and EventLog ports, the Pi
                adapter; runtime-neutral (no Node or Worker types)
  workflow      pure functions over a workflow package: read and validate it, task graph, stale tasks
  api-client    typed commands and event stream; the only way web features reach the API
  viewer        local DICOM ZIP intake, Cornerstone acquired slices, persistent imaging slots
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
- **Sandboxes.** One Modal sandbox per sandbox, CPU or GPU, created by the Node
  runner through the `Sandbox` port (`packages/harness/src/ports/sandbox.ts`); the
  adapter is `apps/runner/src/modal-sandbox.ts`, the only file that imports `modal`
  (pinned: the JS SDK is pre-1.0). It mounts R2 prefixes that don't overlap: the
  workflow and the inputs read-only, the run's scratch and outputs read-write. Each
  mount gets its own temporary R2 credential, limited to its prefix and the sandbox's
  lifetime, minted from `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_BUCKET` and `CLOUDFLARE_API_TOKEN`; the credentials never enter
  the sandbox. Inputs flagged `stage` are copied to local disk at create (a cold mounted
  read of the scan is slow; see the POC in the docs repo, `research/modal-poc.md`).
  There is no internet. The image is prebuilt and named
  (`node --env-file=.env apps/runner/src/publish-image.ts <name>`). Every command runs
  under `timeout -k`, which leads its own process group,; a timeout or an abort kills the whole
  group, except a descendant that calls `setsid` itself, which survives until the
  sandbox is destroyed.
- **One thread, step by step.** `runThread` (`packages/harness/src/adapters/pi`) loads
  the thread's stored history, builds a Pi `Agent` from it, and records every Pi message
  to `History` at `message_end` and every tool call, result and `tool.output` chunk to
  `EventLog`. `apps/runner/src/main.ts` wires it to the HTTP client
  (`packages/harness/src/adapters/http`), the Modal sandbox and a model:
  `pnpm --filter @voluma/runner run-task --provider openai --model <id> --task "<text>"`
  (needs `pnpm --filter @voluma/api dev` running and the keys in `.env`). The sandbox is
  created on the first `bash` call and destroyed at the end; Ctrl-C kills the running
  command and ends the thread as cancelled; the same `--run` and `--thread` resume it.
  A Claude `refusal` ends the thread as failed with that reason. The `bash` tool lives
  in `packages/harness/src/tools`; it caps what the model sees and writes the full text
  to `toolOutputKey` through `/scratch`. An R2 mount cannot append to a file, so
  anything written there must be written in one go.
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

Local DICOM intake and rendering work without the API. They do not populate
analysis results or create server runs. The [Review specification][review-spec]
describes the UI seam; the [viewer specification][viewer-spec] describes input
support, geometry, limits, library integration and verification coverage.

[review-spec]: ../apps/web/src/features/review/.context/CONTEXT.md
[viewer-spec]: ../packages/viewer/.context/CONTEXT.md

## Parallel agents

Several agents from two people work at once, each in its own worktree.
Nothing they run shares mutable state:
- dev servers take free ports (Vite moves to the next free one);
- Nx keeps its cache in the worktree's `.nx/` and runs without a daemon;
- sandboxes are named `<runId>.<name>` and tagged with the run id, so give each
  worktree's runs their own run ids; when the thread store lands, each worktree gets
  its own local store;
- the pnpm store is shared, but it is content-addressed and append-only.

The pre-commit hook lives in the shared `.git`, so every worktree runs the
same hook.
