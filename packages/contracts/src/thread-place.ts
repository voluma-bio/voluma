/**
 * What a thread is for, from the fields of its first `thread.started`. The one place these field
 * rules live: spend and the run view ask here.
 */
import type { RunEvent } from "./events";

export type ThreadPlace = "root" | "main" | "worker";

type Started = Extract<RunEvent, { type: "thread.started" }>["payload"];

/** Root has no parent; every other thread says its `role` (the schema requires it). */
export function threadPlace(p: Pick<Started, "parentThreadId" | "role">): ThreadPlace {
  if (p.parentThreadId === null) return "root";
  if (!p.role) throw new Error("a thread under the root says its role");
  return p.role;
}
