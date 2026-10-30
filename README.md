# Voluma

Run and Review share `apps/web`. Review uses the light theme and the single
`/runs/:runId` route. `/runs/local` opens the R2 reference scan workspace without creating
a server run. No simulated results or agent responses are mounted.

Use the Node version in `.tool-versions` and the pnpm version in `package.json`.
Run `pnpm install`, then `pnpm dev`. In an Amp orb, run
`amp orb services ensure` and open the Review portal.

`pnpm check` runs lint, typechecks and package tests.
`pnpm --filter @voluma/web build` verifies the production frontend bundle.

The report UI is not yet wired to the landed Review run API.
Reports show no results until real data is supplied. The earlier simulator is
preserved in the phase 1–3 commits, not in a second application or demo route.

In Review, each task opens on its own analysis grid (the scan, or an aligned grid
the run made) in the grid viewer: 3D plus axial, coronal and sagittal slices
through one crosshair, with the task's structures and surfaces from the run's
converted assets.

Specifications: [Review workspace](apps/web/src/features/review/.context/CONTEXT.md)
and [grid viewer](packages/viewer/.context/CONTEXT.md).

See [architecture](.context/CONTEXT.md) and [design rules](DESIGN.md).
