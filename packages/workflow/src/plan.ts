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
import type { OutputEntry, WorkflowFiles } from "@voluma/contracts/workflow-files";
import { WorkflowParseError } from "./definition";

function declared(entry: OutputEntry, required: boolean): DeclaredOutput {
  const base = { id: entry.id, required };
  switch (entry.kind) {
    case "measurement":
      return {
        ...base,
        kind: "measurement",
        unit: entry.unit,
        ...(entry.range && { range: entry.range }),
      };
    case "score":
      return { ...base, kind: "score", levels: entry.levels };
    case "structure":
      return {
        ...base,
        kind: "structure",
        name: entry.name,
        ...(entry.label && { label: entry.label }),
      };
    case "annotation":
      return { ...base, kind: "annotation", shape: entry.shape };
    case "volume":
      return { ...base, kind: "volume", volumeKind: entry.volumeKind };
    case "file":
      return { ...base, kind: "file", mediaType: entry.mediaType };
  }
}

/** One task of `tasks.json` as a plan task: its declared outputs copied from `outputs.json`. */
export function planTask(
  files: WorkflowFiles,
  task: WorkflowFiles["tasks"][number],
  required: (outputId: string) => boolean,
): PlanTask {
  const byId = new Map(files.outputs.map((o) => [o.id, o]));
  return {
    id: task.id,
    ...(task.title && { title: task.title }),
    dependsOn: task.dependsOn,
    instructions: task.instructions,
    ...(task.doneWhen.length && { doneWhen: task.doneWhen }),
    outputs: task.outputs.map((id) => declared(byId.get(id) as OutputEntry, required(id))),
  };
}

/**
 * `selected` absent means every output. An output is required when it is selected or when a
 * task of the plan builds on its task (something downstream needs it); otherwise it is optional.
 */
export function computePlan(files: WorkflowFiles, selected?: readonly string[]): WorkflowPlan {
  const byId = new Map(files.outputs.map((o) => [o.id, o]));
  const wanted = new Set(selected ?? files.outputs.map((o) => o.id));
  for (const id of wanted) {
    if (!byId.has(id)) {
      throw new WorkflowParseError(
        "outputs.json",
        `the run selects "${id}", which is not an output`,
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
