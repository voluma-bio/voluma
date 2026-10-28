/**
 * Pure functions over a workflow's plan: which tasks are ready to start and
 * which go stale when one changes. No I/O. (Building the plan from a workflow's files is
 * `plan.ts`; reading them is `load.ts`.)
 */

/** The part of a plan task the graph needs; `WorkflowPlan` tasks fit it. */
export interface GraphTask {
  id: string;
  /** Tasks this one builds on. */
  dependsOn: readonly string[];
}

/** Statuses that make a task start (or restart): never started, or marked for a redo. */
const STARTABLE = new Set(["pending", "stale"]);

/**
 * Tasks to start now, in plan order: `pending` or `stale`, with every dependency
 * `done`. `statusOf` answers `pending` for a task with no attempt.
 */
export function readyTasks(
  tasks: readonly GraphTask[],
  statusOf: (id: string) => string,
): string[] {
  return tasks
    .filter(
      (t) => STARTABLE.has(statusOf(t.id)) && t.dependsOn.every((d) => statusOf(d) === "done"),
    )
    .map((t) => t.id);
}

/** Every task that depends on `id`, directly or through others, in plan order. */
export function transitiveDependents(tasks: readonly GraphTask[], id: string): string[] {
  const hit = new Set([id]);
  // A fixpoint pass per level: plans are small, and this needs no ordering of the plan.
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of tasks) {
      if (!hit.has(t.id) && t.dependsOn.some((d) => hit.has(d))) {
        hit.add(t.id);
        grew = true;
      }
    }
  }
  return tasks.filter((t) => t.id !== id && hit.has(t.id)).map((t) => t.id);
}
