# Review domain TODO

- **Converted review assets are served (`GET /runs/:runId/assets/:sha256/*`, a 302 to a presigned GET) and the grid viewer reads them**, but Review doesn't choose a grid from the run's blocks yet (`packages/viewer/.context/TODO.md`). `GET /runs/:runId/files/:sha256` still streams any `evidenceKey`; it serves only `evidenceKey`s, so an asset under the reference run's keys (`reference/OA6-1RK/run/`, which the contract allows for an importer) would 404; nothing produces those today.
