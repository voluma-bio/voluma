/**
 * Concrete implementations of the ports (R2, D1, local fakes). Only index.ts
 * constructs them. Owned by both lanes; change in small PRs. The Modal sandbox
 * adapter is in apps/runner, not here.
 */
export { d1EventLog } from "./d1-event-log";
export { d1History } from "./d1-history";
