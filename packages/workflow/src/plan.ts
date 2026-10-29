/**
 * Builds the `WorkflowPlan` of a run from the workflow's `outputs.json` and `tasks.json` and
 * the outputs the user selected: the tasks that produce them plus everything those depend on,
 * in `tasks.json` order. A task's outputs come from `outputs.json`, so units, ranges and labels
 * live once.
 */
import {
  type DeclaredOutput,
  type WorkflowPlan,
  workflowPlanSchema,
} from "@voluma/contracts/workflow";
import {
  isSelectable,
  type OutputEntry,
  type WorkflowFiles,
} from "@voluma/contracts/workflow-files";
import { WorkflowParseError } from "./definition";

/** The entry less what only the file keeps (`declaredOutputSchema`). */
function declared(entry: OutputEntry, required: boolean): DeclaredOutput {
  const { task: _task, region: _region, sourceRef: _sourceRef, ...rest } = entry;
  return { ...rest, required };
}

/**
 * `selected` absent means every measurement and score. A measurement or score is required when
 * it is selected or when a task of the plan builds on its task (something downstream needs
 * it); otherwise it is optional. A file is required whenever its task is in the plan, and an
 * object never is: a run that can't produce one (no patella in the field) must not stall the
 * tasks that build on its task.
 */
export function computePlan(files: WorkflowFiles, selected?: readonly string[]): WorkflowPlan {
  const byId = new Map(files.outputs.map((o) => [o.id, o]));
  const wanted = new Set(selected ?? files.outputs.filter(isSelectable).map((o) => o.id));
  for (const id of wanted) {
    const entry = byId.get(id);
    if (!entry || !isSelectable(entry)) {
      throw new WorkflowParseError(
        "outputs.json",
        `the run selects "${id}", which is not a measurement or score`,
      );
    }
  }
  const direct = new Set([...wanted].map((id) => byId.get(id)?.task as string));
  const tasks = new Map(files.tasks.map((t) => [t.id, t]));
  const included = new Set<string>();
  const add = (id: string) => {
    if (included.has(id)) return;
    included.add(id);
    for (const d of tasks.get(id)?.dependsOn ?? []) add(d);
  };
  for (const id of direct) add(id);
  const needed = new Set(files.tasks.filter((t) => included.has(t.id)).flatMap((t) => t.dependsOn));

  const plan = workflowPlanSchema.safeParse({
    tasks: files.tasks
      .filter((t) => included.has(t.id))
      .map((t) => ({
        id: t.id,
        ...(t.title && { title: t.title }),
        dependsOn: t.dependsOn,
        instructions: t.instructions,
        ...(t.doneWhen.length && { doneWhen: t.doneWhen }),
        outputs: t.outputs.map((id) => {
          const entry = byId.get(id) as OutputEntry;
          const required =
            entry.kind === "file" || (isSelectable(entry) && (wanted.has(id) || needed.has(t.id)));
          return declared(entry, required);
        }),
      })),
  });
  if (!plan.success) {
    const issue = plan.error.issues[0];
    throw new WorkflowParseError("tasks.json", `${issue?.path.join(".")}: ${issue?.message}`);
  }
  return plan.data;
}

/** What the main thread may change at run start: more done-when lines, and workflow tasks to add. */
export interface PlanChange {
  /** Lines appended to a task's done-when, by task id. */
  doneWhen?: Record<string, string[]>;
  /** Tasks of `tasks.json` to add (with what they depend on); their measurements and scores become selected. */
  add?: string[];
}

/**
 * The run's plan with a change applied. Code builds it from the workflow files, so a change
 * can never alter an output, its unit, range or whether it is required, and cannot drop a
 * task that produces a selected output. It throws on a change it cannot apply: a task that is
 * not in `tasks.json`, already in the plan, or without a measurement or score to select it by, and done-when
 * lines for a task not in the plan.
 */
export function adaptPlan(
  files: WorkflowFiles,
  selected: readonly string[] | undefined,
  change: PlanChange,
): WorkflowPlan {
  const byTask = new Map(files.tasks.map((t) => [t.id, t]));
  const byOutput = new Map(files.outputs.map((o) => [o.id, o]));
  const inPlan = new Set(computePlan(files, selected).tasks.map((t) => t.id));
  const added = (change.add ?? []).flatMap((id) => {
    const task = byTask.get(id);
    if (!task) throw new WorkflowParseError("tasks.json", `the change adds "${id}", not a task`);
    if (inPlan.has(id)) {
      throw new WorkflowParseError("tasks.json", `the change adds "${id}", already in the plan`);
    }
    const selectable = task.outputs.filter((o) => isSelectable(byOutput.get(o) as OutputEntry));
    if (!selectable.length) {
      throw new WorkflowParseError(
        "tasks.json",
        `the change adds "${id}", which has no measurement or score to select it by`,
      );
    }
    return selectable;
  });
  const base = computePlan(files, selected && [...selected, ...added]);
  const known = new Set(base.tasks.map((t) => t.id));
  for (const id of Object.keys(change.doneWhen ?? {})) {
    if (!known.has(id)) throw new WorkflowParseError("tasks.json", `"${id}" is not in the plan`);
  }
  return workflowPlanSchema.parse({
    tasks: base.tasks.map((t) => {
      const doneWhen = [...(t.doneWhen ?? []), ...(change.doneWhen?.[t.id] ?? [])];
      const { doneWhen: _, ...rest } = t;
      return { ...rest, ...(doneWhen.length && { doneWhen }) };
    }),
  });
}
