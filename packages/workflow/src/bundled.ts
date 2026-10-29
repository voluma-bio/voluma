/**
 * The workflow catalog: every workflow a run can start from, with its `tasks.json` and
 * `outputs.json` bundled as JSON imports and parsed with the contract's schemas. The API takes a
 * `workflowId` from here, never a path, so a caller can't point the runner at another directory;
 * a run pins the deployed commit and the entry's `path`, and the runner snapshots that directory
 * (and `workflows/core`) when it starts. A workflow's text reaches a prompt only through a commit
 * of this repo, which is the trust boundary.
 *
 * The web app reads names, task titles and outputs from here at build time: the API serves no
 * workflow files. The runner checks a run's selected outputs against its own checkout, which may
 * be a later commit than this bundle.
 *
 * JSON imports (`with { type: "json" }`) work in Vite, Node (tsx) and `tsc` alike.
 */
import {
  type OutputEntry,
  outputsFileSchema,
  type TaskEntry,
  tasksFileSchema,
} from "@voluma/contracts/workflow-files";
import mouseOaOutputs from "../../../workflows/mouse-oa/outputs.json" with { type: "json" };
import mouseOaTasks from "../../../workflows/mouse-oa/tasks.json" with { type: "json" };
import smokeOutputs from "../../../workflows/smoke/outputs.json" with { type: "json" };
import smokeTasks from "../../../workflows/smoke/tasks.json" with { type: "json" };

export interface BundledWorkflow {
  /** The catalog id `startRun` takes. */
  id: string;
  /** The directory a run pins, relative to the repo root. */
  path: string;
  name: string;
  description: string;
  tasks: TaskEntry[];
  /** Every output a run can produce, in file order. */
  outputs: OutputEntry[];
  /** The outputs a summary leads with (`headline` in `outputs.json`), in file order. */
  headline: OutputEntry[];
  /** A task's title; a task without one shows its id. */
  taskTitle: (id: string) => string;
  /** An output's name; one the workflow doesn't list shows its id. */
  outputName: (id: string) => string;
}

function bundle(
  meta: Pick<BundledWorkflow, "id" | "path" | "name" | "description">,
  tasksJson: unknown,
  outputsJson: unknown,
): BundledWorkflow {
  const tasks = tasksFileSchema.parse(tasksJson);
  const outputs = outputsFileSchema.parse(outputsJson);
  const titles = new Map(tasks.flatMap((t) => (t.title ? [[t.id, t.title]] : [])));
  const names = new Map(outputs.map((o) => [o.id, o.name]));
  return {
    ...meta,
    tasks,
    outputs,
    // `headline` is optional in the schema; an output without it is not a headline.
    headline: outputs.filter((o) => "headline" in o && o.headline === true),
    taskTitle: (id) => titles.get(id) ?? id,
    outputName: (id) => names.get(id) ?? id,
  };
}

export const catalog = {
  /** A two-task workflow that checks the runner end to end. */
  smoke: bundle(
    {
      id: "smoke",
      path: "workflows/smoke",
      name: "Smoke test",
      description: "Counts the scan's files and lists their extensions.",
    },
    smokeTasks,
    smokeOutputs,
  ),
  // A starter for the lab to edit (`workflows/mouse-oa/skills/mouse-oa/SKILL.md`).
  "mouse-oa": bundle(
    {
      id: "mouse-oa",
      path: "workflows/mouse-oa",
      name: "Mouse OA knee",
      description: "Measures the proximal tibia, the distal femur and the knee's bone structures.",
    },
    mouseOaTasks,
    mouseOaOutputs,
  ),
} satisfies Record<string, BundledWorkflow>;

type WorkflowId = keyof typeof catalog;

/** The catalog entry for a request's `workflowId`, or undefined for an id the catalog lacks. */
export const workflowById = (id: string): BundledWorkflow | undefined =>
  Object.hasOwn(catalog, id) ? catalog[id as WorkflowId] : undefined;

/** A run's pinned workflow path as a name; a path outside the catalog shows its directory name. */
export function workflowName(path: string | undefined): string {
  const entry = Object.values(catalog).find((w) => w.path === path);
  return entry?.name ?? path?.split("/").pop() ?? "Workflow";
}
