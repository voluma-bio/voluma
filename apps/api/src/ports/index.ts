/**
 * Interfaces both API domains depend on (blob storage, the thread store).
 * Adapters are chosen in index.ts. Owned by both lanes; change in small PRs.
 * The Sandbox port lives in packages/harness: the Node runner, not the Worker,
 * creates sandboxes.
 */
export {};
