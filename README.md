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

In Review, **Open reference scan** downloads OA6-1RK from R2; **Open run scan**
resolves the run's own input. Local file selection is not available. Choose a
series when the archive contains several, then use Acquired slices for navigation,
window/level and zoom, or **Build 3D** for the native raw volume. Closing or
reloading releases the browser's scan data. Downloads and expanded archives each
have a separate 2 GiB limit; neither is a total browser memory budget. Orthogonal
reformats and segmented 3D meshes are not generated yet.

Specifications: [Review workspace](apps/web/src/features/review/.context/CONTEXT.md)
and [DICOM intake/viewer](packages/viewer/.context/CONTEXT.md).

See [architecture](.context/CONTEXT.md) and [design rules](DESIGN.md).
