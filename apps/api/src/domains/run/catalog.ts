/**
 * The workflow catalog: server config mapping a `workflowId` to the packages a run pins.
 * A request names an id from here, never raw pins, so a caller can't make the runner
 * import an arbitrary repo. Adding a workflow is one entry that pins commits; the plan,
 * prompts and skills come from the packages themselves (`@voluma/workflow`), which the
 * runner imports when it claims the run.
 *
 * `pins[0]` is the workflow package (it holds `workflow.md`); the others are the packages
 * it draws agents and skills from, each pinned too. A package inside a repo's
 * subdirectory pins `path`.
 *
 * Empty: `mouse-oa` has no `workflow.md` package yet. Add its entry with its first commit.
 */
import type { WorkflowPin } from "@voluma/contracts/workflow";

export interface CatalogEntry {
  pins: WorkflowPin[];
}

export type Catalog = Record<string, CatalogEntry>;

export const catalog: Catalog = {};
