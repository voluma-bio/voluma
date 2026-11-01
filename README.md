# Voluma

`apps/web` shows each scan's run, live and for review, at `/scans/:runId`, in the
user's Light or Dark theme (`DESIGN.md`). No simulated results or agent responses are mounted.

Use the Node version in `.tool-versions` and the pnpm version in `package.json`.
Run `pnpm install`, then `pnpm dev`. In an Amp orb, run
`amp orb services ensure` and open the Review portal.

`pnpm check` runs lint, typechecks and package tests.
`pnpm --filter @voluma/web build` verifies the production frontend bundle.

In the scan review, each task opens on its own analysis grid (the scan, or an aligned grid
the run made) in the grid viewer: 3D plus axial, coronal and sagittal slices
through one crosshair, with the task's structures and surfaces from the run's
converted assets.

Specifications: [scan review](apps/web/src/features/scan/.context/CONTEXT.md),
[run view](packages/run-view/.context/CONTEXT.md)
and [grid viewer](packages/viewer/.context/CONTEXT.md).

See [architecture](.context/CONTEXT.md) and [design rules](DESIGN.md).
