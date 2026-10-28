/**
 * The workflow the start screen offers, its task titles, and its outputs grouped for the "What
 * do you want measured?" checklist. Both come from the workflow's own `tasks.json` and
 * `outputs.json`, bundled at build: the API never reads workflow files
 * (`apps/api/.context/deploy.md`), and the runner validates every selected id against the same
 * file at its own commit.
 */
import {
  type OutputEntry,
  outputsFileSchema,
  tasksFileSchema,
} from "@voluma/contracts/workflow-files";
import outputsJson from "../../../../../workflows/workflow-mouse-oa/outputs.json?raw";
import tasksJson from "../../../../../workflows/workflow-mouse-oa/tasks.json?raw";

export const WORKFLOW = {
  /** The catalog id `startRun` takes (`apps/api/src/domains/run/catalog.ts`). */
  id: "mouse-oa",
  path: "workflows/workflow-mouse-oa",
  name: "Mouse OA knee",
  description: "Measures the proximal tibia, the distal femur and the knee's bone structures.",
};

const titles = new Map(
  tasksFileSchema.parse(JSON.parse(tasksJson)).flatMap((t) => (t.title ? [[t.id, t.title]] : [])),
);

/** A task's title, also its checklist group's; a task without one shows its id. */
export const taskTitle = (id: string) => titles.get(id) ?? id;

export type OutputGroup = { title: string; outputs: OutputEntry[] };

const outputs = outputsFileSchema.parse(JSON.parse(outputsJson));

/** One group per producing task, in file order. */
export const OUTPUT_GROUPS: OutputGroup[] = (() => {
  const byTask = new Map<string, OutputEntry[]>();
  for (const o of outputs) byTask.set(o.task, [...(byTask.get(o.task) ?? []), o]);
  return [...byTask].map(([task, list]) => ({ title: taskTitle(task), outputs: list }));
})();

export const ALL_OUTPUT_IDS = outputs.map((o) => o.id);

/** The workflow's display name for a run's pin; an unknown path shows its directory name. */
export function workflowName(path: string | undefined): string {
  if (path === WORKFLOW.path) return WORKFLOW.name;
  return path?.split("/").pop() ?? "Workflow";
}
