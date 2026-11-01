# Review domain TODO

- **Assets under the reference run's keys would 404.** `GET /runs/:runId/files/:sha256` serves only `evidenceKey`s, so an asset under the reference run's keys (`reference/OA6-1RK/run/`, which the contract allows for an importer) would 404; nothing produces those today.
