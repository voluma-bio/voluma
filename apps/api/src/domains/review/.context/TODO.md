# Review domain TODO

- **A run's files are served, but the viewer doesn't load volumes, meshes or assets yet.** `GET /runs/:runId/files/:sha256` streams any `evidenceKey`; loading the scan, labels and surfaces into `packages/viewer` (labels over slices, surfaces in 3D, the outline under check) is the next step, over the converted assets in `ReviewRun.assets` (served by the asset route, which the conversion worker's PR adds).
