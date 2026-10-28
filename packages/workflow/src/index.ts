/**
 * Pure functions over a workflow's plan: which tasks are ready to start and
 * which go stale when one changes. No I/O. (Reading `workflow.md` into the plan
 * is not built yet.)
 */

/** The part of a plan task the graph needs; `WorkflowPlan` tasks fit it. */
export interface GraphTask {
  id: string;
  /** Tasks this one builds on. */
  dependsOn: readonly string[];
}

/** Statuses that make a task start (or restart): never started, or marked for a redo. */
const STARTABLE = new Set(["pending", "stale"]);

/** What the graph needs of a task's latest attempt; `FoldedTask` fits it. */
export interface TaskState {
  status: string;
  /** Required declared outputs the attempt hasn't reported. */
  missingRequired: readonly string[];
}

/**
 * Whether a task that builds on this one may start: it is `done`, or `to-check` with every
 * required output present. A To check item is for the researcher in review; it must not
 * stop the run, but a task with no usable result still blocks. `undefined`: no attempt yet.
 */
export function isSatisfied(task: TaskState | undefined): boolean {
  return (
    task?.status === "done" || (task?.status === "to-check" && task.missingRequired.length === 0)
  );
}

/**
 * Tasks to start now, in plan order: `pending` or `stale`, with every dependency
 * satisfied (`isSatisfied`). `stateOf` answers `undefined` for a task with no attempt.
 */
export function readyTasks(
  tasks: readonly GraphTask[],
  stateOf: (id: string) => TaskState | undefined,
): string[] {
  return tasks
    .filter(
      (t) =>
        STARTABLE.has(stateOf(t.id)?.status ?? "pending") &&
        t.dependsOn.every((d) => isSatisfied(stateOf(d))),
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
