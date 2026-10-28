/**
 * Interfaces both API domains depend on (blob storage, once review data is served).
 * The run domain's EventLog and History ports live in packages/harness, which the Node
 * runner shares; the Sandbox port too, since the runner, not the API, creates sandboxes.
 * Adapters of these shared ports go in adapters/ (none yet); a domain's own Postgres
 * adapters live in the domain. Only index.ts constructs adapters.
 * Owned by both lanes; change in small PRs.
 */
export {};
