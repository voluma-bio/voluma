/**
 * What a thread is for, from the fields of its first `thread.started`. The one place these field
 * rules live: the fold, spend and the run view all ask here. Its own file because `threads.ts`
 * imports the fold, which needs this.
 */
import type { RunEvent } from "./events";

export type ThreadRole = "root" | "main" | "worker" | "check";

type Started = Extract<RunEvent, { type: "thread.started" }>["payload"];

/** Root has no parent; a check records the attempt it checks; a worker has a task and no attempt; the main agent has none of these. */
export function threadRole(p: Pick<Started, "parentThreadId" | "task" | "attemptId">): ThreadRole {
  if (p.parentThreadId === null) return "root";
  if (p.attemptId !== undefined) return "check";
  return p.task !== undefined ? "worker" : "main";
}
