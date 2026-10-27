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
- object storage and the sandbox run per worktree, as the recipe below
  describes; when the thread store lands, each worktree gets its own local store;
- the pnpm store is shared, but it is content-addressed and append-only.

The pre-commit hook lives in the shared `.git`, so every worktree runs the
same hook.

## Running the sandbox locally

`apps/api` uses `@cloudflare/sandbox` 1.0.x, which is npm `latest`. Its API is
`ctx.container` with `S3Mount`, `S3Gateway` and `Files`. Cloudflare's
`sandbox-next` and `sandbox-stable` agent skills predate that release: they
describe a `getSandbox()` and `exec(argv)`-handle preview that 1.0 doesn't
export, and npm's `@next` tag now points at an older 0.13 build. Go by the
installed types and the 1.0 docs.

`apps/api` reaches R2 only through S3 variables, so locally they point at a MinIO
that each worktree starts for itself. Names carry the worktree so nothing collides.

```bash
docker run -d --name minio-<worktree> -p 127.0.0.1::9000 -v /tmp/minio-<worktree>:/data \
  -e MINIO_ROOT_USER=voluma -e MINIO_ROOT_PASSWORD=voluma-secret minio/minio server /data
docker port minio-<worktree> 9000        # the free port Docker chose, e.g. 127.0.0.1:32768
```

In `apps/api/.dev.vars` (git-ignored; names in `.dev.vars.example`) set
`S3_ENDPOINT=http://127.0.0.1:<port>`, `S3_REGION=us-east-1`,
`S3_BUCKET=voluma-<worktree>`, `S3_ACCESS_KEY_ID=voluma`,
`S3_SECRET_ACCESS_KEY=voluma-secret` and any `API_TOKEN`. Then `pnpm --filter
@voluma/api dev` (Wrangler builds the container image on first start and picks a
free port).

The scan reaches `/inputs` by being uploaded under the run's inputs prefix; the
sandbox mounts that prefix read-only. Create the bucket with a `PUT`, then upload
each slice (no `mc` or `aws` needed; curl signs the request):

```bash
curl -X PUT --aws-sigv4 aws:amz:us-east-1:s3 --user voluma:voluma-secret http://127.0.0.1:<port>/voluma-<worktree>
for f in <scan-dir>/*.dcm; do curl -sT "$f" --aws-sigv4 aws:amz:us-east-1:s3 \
  --user voluma:voluma-secret "http://127.0.0.1:<port>/voluma-<worktree>/runs/<runId>/inputs/$(basename "$f")"; done
```

Remove MinIO's data with `docker run --rm -v /tmp:/t alpine rm -rf /t/minio-<worktree>`
(it writes as root).

Known limits on a Linux host (verified on kernel 7.2, Docker 29, Wrangler 4.153):
- The host firewall must admit containers (`sudo ufw allow in on docker0`, plus the
  `br-*` interfaces for compose networks). Wrangler's egress sidecar connects back to
  a random host port on the docker gateway; ufw drops that by default.
- Even then, the sidecar's `-m socket -j DIVERT` rule in its network namespace drops
  the replies to its own connections to the gateway, so Wrangler never creates the
  sandbox container. Deleting that rule from the sidecar's namespace gets past it.
- The container Wrangler creates has no `/dev/fuse` and no capabilities, so every
  `S3Mount.mount()` fails with `fuse: device not found`. Local mounts therefore do
  not work on Linux; commands that need no mount (exec, kill, timeout) do.
Mounts are exercised by a deployed Worker (`wrangler deploy` with an R2 bucket) or
on a Docker Desktop host, which has not been tried.
