/**
 * The workflow the start screen offers and its outputs, grouped for the "What do you want
 * measured?" checklist. The outputs come from the workflow's own `outputs.json`, bundled at
 * build: the API never reads workflow files (`apps/api/.context/deploy.md`), and the runner
 * validates every selected id against the same file at its own commit.
 */
import { type OutputEntry, outputsFileSchema } from "@voluma/contracts/workflow-files";
import outputsJson from "../../../../../workflows/workflow-mouse-oa/outputs.json?raw";

export const WORKFLOW = {
  /** The catalog id `startRun` takes (`apps/api/src/domains/run/catalog.ts`). */
  id: "mouse-oa",
  path: "workflows/workflow-mouse-oa",
  name: "Mouse OA knee",
  description: "Measures the proximal tibia, the distal femur and the knee's bone structures.",
};

/** Task titles, also the titles of the checklist groups; a task not listed here shows its id. */
const TASK_TITLES: Record<string, string> = {
  intake: "Scan intake",
  orientation: "Orientation",
  segmentation: "Segmentation volumes",
  iioc: "Tibial IIOC",
  "subchondral-plate": "Subchondral bone plate",
  "trabecular-roi": "IIOC trabecular bone",
  "metaphyseal-roi": "Proximal tibial metaphysis",
  cortical: "Cortical bone",
  "femoral-geometry": "Distal femur",
};

export const taskTitle = (id: string) => TASK_TITLES[id] ?? id;

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
