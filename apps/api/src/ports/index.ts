/**
 * Interfaces both API domains depend on (blob storage, the thread store). The run domain's EventLog and History ports live in packages/harness, which the Node runner shares.
 * Adapters are chosen in index.ts. Owned by both lanes; change in small PRs.
 * The Sandbox port lives in packages/harness: the Node runner, not the API,
 * creates sandboxes.
 */
export {};
