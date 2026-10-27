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
- 2026-10-27: Agents merge their own PRs after a fresh agent's review and green CI, without waiting for a human; contract PRs need both owners; tiny changes push straight to `main` after `pnpm check` (rules in AGENTS.md). (scaffold PR)
- 2026-10-27: Workflows are Mars schema v1 packages on GitHub, imported and pinned to a commit; this repo holds no workflows or Python. If Mars blocks the MVP, packages are bundled into the repo instead. (scaffold PR)

[requirements]: https://github.com/voluma-bio/docs/blob/main/work/microct-workflow-mvp/requirements.md
