# Decisions

One dated line per settled decision that agents in both lanes need, newest
last, with a link to the PR. Record the decision, not its description.
Product decisions live in the [requirements].

- 2026-10-27: Web is React 19 + Vite with React Router 8; each feature exports its own routes. (scaffold PR)
- 2026-10-27: Styling is Tailwind v4 over the design tokens via `@theme inline`; Tailwind's default palette is removed. (scaffold PR)
- 2026-10-27: One token set, two themes selected by `data-theme`; light is the default, the review sets dark on its root. (scaffold PR)
- 2026-10-27: Packages export TypeScript source; no package build step. (scaffold PR)
- 2026-10-27: Nx caches typecheck and test only, in each worktree's `.nx/cache`, without the daemon; Biome runs once over the repo. (scaffold PR)
- 2026-10-27: `packages/ui` components take a tone or variant, not a domain status; features map their statuses to tones. (scaffold PR)
- 2026-10-27: Agents merge their own PRs on green CI without waiting for a human, after a fresh agent's review when the PR changes behaviour or structure; contract PRs need both owners; tiny changes push straight to `main` after `pnpm check` (rules in AGENTS.md). (scaffold PR)
- 2026-10-27: Workflows are Mars schema v1 packages on GitHub, imported and pinned to a commit; this repo holds no workflows or Python. If Mars blocks the MVP, packages are bundled into the repo instead. (scaffold PR)
- 2026-10-27: The API has one domain per lane, mounted by path prefix (`/run/`, `/review/`); each is built from a factory taking ports, and only `apps/api/src/index.ts` reads env and builds adapters. ([#2](https://github.com/voluma-bio/voluma/pull/2))
- 2026-10-27: `packages/api-client` changes only in contract PRs; the contracts PR makes it a generic client over a command map. ([#2](https://github.com/voluma-bio/voluma/pull/2))
- 2026-10-27: This log merges with git's union driver, so append a line rather than edit one. ([#2](https://github.com/voluma-bio/voluma/pull/2))
- 2026-10-27: No fixtures or mock transports: lanes test against real OA6-1RK data and the real API. Lint is Biome's recommended rules only; boundaries are written rules. (user)
- 2026-10-27: The agent runtime is `pi-agent-core` + `pi-ai`, used as they come; `pi-durable` (experimental) is adopted only when compaction or resume needs it. There is no `Harness` port while there is one runtime. (user, tech lead)
- 2026-10-27: The run's event log (`threads`, `events`, `pi_messages`) lives in D1 behind the run domain's API; `seq` per run is the stream cursor; both lanes read it. (tech lead)
- 2026-10-27: One Cloudflare Sandbox Durable Object per sandbox; mounts don't overlap: workflow and inputs read-only, run scratch and outputs read-write; no internet; R2 credentials stay in the Worker. (user, tech lead)
- 2026-10-27: Review uses the light theme and one `/runs/:runId` route; no separate demo application or synthetic results are mounted. `/runs/local` is a local workspace, not a server run. This supersedes the scaffold's dark Review default. ([Andrew's direction](https://ampcode.com/threads/T-01a17c7b-ed35-74fa-b025-670e440c66ee))
- 2026-10-27: Contracts are one file per contract with subpath exports (`@voluma/contracts/r2`, `/events`, `/review`, `/workflow`); R2 keys are built only by `r2.ts`; the run event log has v0 kinds only and the review data is one `ReviewRun` shape for the UI and the reference-run importer: a generic core (tasks, measurements, evidence) plus closed building blocks per revision (volumes, structures, annotations in world mm) that every workflow fills, so a new workflow needs no Review-lane code and a new block kind is a contract PR. (contracts PR B)

[requirements]: https://github.com/voluma-bio/docs/blob/main/work/microct-workflow-mvp/requirements.md
