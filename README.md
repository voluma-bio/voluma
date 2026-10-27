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

In Review, **Open DICOM ZIP** reads a local scan without uploading it. Choose a
series when the ZIP contains several, then use Acquired slices for navigation,
window/level and zoom. Closing or reloading releases the local scan. Use
de-identified files; the app does not anonymize them. Current limits are
256 MiB compressed and 512 MiB expanded. Orthogonal reformats and 3D meshes are
not generated yet.

Specifications: [Review workspace](apps/web/src/features/review/.context/CONTEXT.md)
and [DICOM intake/viewer](packages/viewer/.context/CONTEXT.md).

See [architecture](.context/CONTEXT.md) and [design rules](DESIGN.md).
