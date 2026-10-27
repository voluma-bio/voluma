# Voluma

Run and Review share `apps/web`. Review uses the light theme and the single
`/runs/:runId` route. `/runs/local` opens a local workspace without creating
a server run. No simulated results or agent responses are mounted.

Use the Node version in `.tool-versions` and the pnpm version in `package.json`.
Run `pnpm install`, then `pnpm dev`. In an Amp orb, run
`amp orb services ensure` and open the Review portal.

`pnpm check` runs lint, typechecks and package tests.
`pnpm --filter @voluma/web build` verifies the production frontend bundle.

The analysis API, persistence and reference-run importer remain unconnected.
Reports show no results until real data is supplied. The earlier simulator is
preserved in the phase 1–3 commits, not in a second application or demo route.

See [architecture](.context/CONTEXT.md) and [design rules](DESIGN.md).
