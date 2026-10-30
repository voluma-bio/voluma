/**
 * Builds the `WorkflowPlan` of a run from the workflow's `outputs.json` and `tasks.json` and
 * the outputs the user selected: the tasks that produce them plus everything those depend on,
 * in `tasks.json` order. A task's outputs come from `outputs.json`, so units, ranges and labels
 * live once.
 */
import {
  type DeclaredOutput,
  type PlanTask,
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
  if (rest.kind === "measurement") delete rest.headline;
  return { ...rest, required };
}

/**
 * One task of `tasks.json` as a plan task: its declared outputs copied from `outputs.json`.
 * `wanted(outputId)` says a measurement or score is required; a file always is, an object never.
 */
export function planTask(
  files: WorkflowFiles,
  task: WorkflowFiles["tasks"][number],
  wanted: (outputId: string) => boolean,
): PlanTask {
  const byId = new Map(files.outputs.map((o) => [o.id, o]));
  return {
    id: task.id,
    ...(task.title && { title: task.title }),
    dependsOn: task.dependsOn,
    instructions: task.instructions,
    ...(task.doneWhen.length && { doneWhen: task.doneWhen }),
    outputs: task.outputs.map((id) => {
      const entry = byId.get(id) as OutputEntry;
      return declared(entry, entry.kind === "file" || (isSelectable(entry) && wanted(id)));
    }),
  };
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
      .map((t) => planTask(files, t, (id) => wanted.has(id) || needed.has(t.id))),
  });
  if (!plan.success) {
    const issue = plan.error.issues[0];
    throw new WorkflowParseError("tasks.json", `${issue?.path.join(".")}: ${issue?.message}`);
  }
  return plan.data;
}
