/**
 * Pure functions over a workflow's plan: whether a task's result lets its dependents start, and
 * which tasks go stale when one changes. No I/O. (Building the plan from a workflow's files is
 * `plan.ts`; reading them is `load.ts`.)
 */

/** The part of a plan task the graph needs; `WorkflowPlan` tasks fit it. */
export interface GraphTask {
  id: string;
  /** Tasks this one builds on. */
  dependsOn: readonly string[];
}

/** What the graph needs of a task's latest attempt; `FoldedTask` fits it. */
export interface TaskState {
  status: string;
  /** Required declared outputs the attempt hasn't reported. */
  missingRequired: readonly string[];
  /** Set on a skipped task (and one that depends on a skipped task): it has no result. */
  skipped?: unknown;
  /** The check rejected the result (`needs-review`) and the main agent hasn't yet decided. */
  rejected?: boolean;
}

/**
 * Whether a task that builds on this one may start: it is `done`, or `to-check` with every
 * required output present. A To check item is for the researcher in review; it must not
 * stop the run, but a task with no usable result still blocks: one that is skipped or whose
 * check rejected it (`needs-review`). `to-check` by `accept` or the `fix-limit` rule is satisfied. `undefined`: no attempt yet.
 */
export function isSatisfied(task: TaskState | undefined): boolean {
  if (!task || task.skipped || task.rejected) return false;
  return (
    task.status === "done" || (task.status === "to-check" && task.missingRequired.length === 0)
  );
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
