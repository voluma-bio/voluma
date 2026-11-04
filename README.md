# Voluma

`apps/web` shows each input's run, live and for review, at `/studies/:studyId/inputs/:inputId`, in the
user's Light or Dark theme (`DESIGN.md`). No simulated results or agent responses are mounted.

Use the Node version in `.tool-versions` and the pnpm version in `package.json`.
Run `pnpm install`, then `pnpm dev`. In an Amp orb, run
`amp orb services ensure` and open the Review portal.

`pnpm check` runs lint, typechecks and package tests.
`pnpm --filter @voluma/web build` verifies the production frontend bundle.

In the input review, each output opens on its own analysis grid (the scan, or an aligned grid
the run made) in the grid viewer: 3D plus axial, coronal and sagittal slices
through one crosshair, with its structures and surfaces from the run's
converted assets.

Specifications: [input review](apps/web/src/features/input/.context/CONTEXT.md),
[run view](packages/run-view/.context/CONTEXT.md)
and [grid viewer](packages/viewer/.context/CONTEXT.md).

The growth-plate model the runs call is a SAM 3.1 fine-tune trained offline in
[training/plate-finetune](training/plate-finetune/README.md) (scores, methods, Modal app); its weights are public at
[VolumaBio/mouse-knee-growth-plate](https://huggingface.co/VolumaBio/mouse-knee-growth-plate).

See [architecture](.context/CONTEXT.md) and [design rules](DESIGN.md).
