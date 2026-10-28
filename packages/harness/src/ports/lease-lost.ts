/**
 * The run's lease is gone: the API refused an ingest write because its lease token is
 * stale (`@voluma/contracts/runner`). The runner stops the run at once and does not retry.
 */
export class LeaseLost extends Error {}
