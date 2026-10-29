/**
 * The workflow catalog: server config mapping a `workflowId` to the workflow directory
 * (`workflows/<name>`) a run uses. A request names an id from here, never a path, so a caller
 * can't point the runner at another directory. A run pins the deployed commit and that path;
 * the runner snapshots the directory (and `workflows/core`) into the
 * run's R2 prefix when it starts. The plan and skills come from those files
 * (`@voluma/workflow`). A workflow's text reaches a prompt only through a commit of this
 * repo, which is the trust boundary.
 *
 * `smoke` is a two-task workflow that checks the runner end to end.
 */
import type { WorkflowPin } from "@voluma/contracts/workflow";

export interface CatalogEntry {
  workflow: string;
}

export type Catalog = Record<string, CatalogEntry>;

export const catalog: Catalog = {
  smoke: { workflow: "workflows/smoke" },
  // A starter for the lab to edit (`workflows/mouse-oa/skills/mouse-oa/SKILL.md`).
  "mouse-oa": { workflow: "workflows/mouse-oa" },
};

/** The pins a run of catalog workflow `workflowId` records, or undefined for an id the catalog lacks. */
export function pinsOf(
  catalog: Catalog,
  repo: string,
  workflowId: string,
): WorkflowPin[] | undefined {
  const entry = Object.hasOwn(catalog, workflowId) ? catalog[workflowId] : undefined;
  return entry && [{ repo, path: entry.workflow }];
}
