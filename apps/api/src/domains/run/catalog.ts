/**
 * The workflow catalog: server config mapping a `workflowId` to the packages it pins and
 * the plan a claim hands the runner (`@voluma/contracts/workflow`). A request names an
 * id from here, never raw pins, so a caller can't make the server import an arbitrary
 * repo. Adding a workflow is a code change that pins a commit.
 *
 * Missing: the mouse-OA entry. No Mars package in `voluma-bio/microct-analysis` has a
 * `workflow.md`, and `packages/workflow` (the parser that would produce the plan) is
 * empty, so there is no plan to pin yet. Add it with its first workflow package.
 */
import type { WorkflowPin, WorkflowPlan } from "@voluma/contracts/workflow";
import { workflowPlanSchema } from "@voluma/contracts/workflow";

export interface CatalogEntry {
  pins: WorkflowPin[];
  plan: WorkflowPlan;
}

export type Catalog = Record<string, CatalogEntry>;

export const catalog: Catalog = {
  // A small plan to exercise the run lifecycle: two tasks, the second building on the first.
  "two-task-test": {
    pins: [
      { repo: "voluma-bio/microct-analysis", commit: "a96736e05c9c60b47d364f2ee86ca6b4f973b12b" },
    ],
    plan: workflowPlanSchema.parse({
      tasks: [
        {
          id: "segment-tibia",
          dependsOn: [],
          outputs: [{ id: "tibia", kind: "structure", required: true, name: "Tibia" }],
        },
        {
          id: "measure-tibia",
          dependsOn: ["segment-tibia"],
          outputs: [{ id: "tibia-volume", kind: "measurement", required: true, unit: "mm3" }],
        },
      ],
    }),
  },
};
