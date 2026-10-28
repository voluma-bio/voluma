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

/**
 * `selected` absent means every output. A task that produces a selected output reports it as
 * required and its other outputs as optional; a task included only as a dependency reports all
 * of its outputs as required, since something downstream builds on them.
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

  const plan = workflowPlanSchema.safeParse({
    tasks: files.tasks
      .filter((t) => included.has(t.id))
      .map((t) => ({
        id: t.id,
        dependsOn: t.dependsOn,
        ...(t.doneWhen.length && { doneWhen: t.doneWhen }),
        outputs: t.outputs.map((id) =>
          declared(byId.get(id) as OutputEntry, !direct.has(t.id) || wanted.has(id)),
        ),
      })),
  });
  if (!plan.success) {
    const issue = plan.error.issues[0];
    throw new WorkflowParseError("tasks.json", `${issue?.path.join(".")}: ${issue?.message}`);
  }
  return plan.data;
}

/**
 * The seam where the main thread adapts the computed plan to the user's notes (add, drop or
 * reorder tasks, tighten criteria) before the run starts. Today it returns the plan as computed.
 */
export async function adaptPlan(
  plan: WorkflowPlan,
  _context: { notes?: string; files: WorkflowFiles },
): Promise<WorkflowPlan> {
  return plan;
}
