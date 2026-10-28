/**
 * The workflow catalog: server config mapping a `workflowId` to the workflow directory
 * (`workflows/<name>`) a run uses. A request names an id from here, never a path, so a caller
 * can't point the runner at another directory. A run pins the deployed commit and that path;
 * the runner snapshots the directory (and the ones its `workflow.md` lists in `uses`) into the
 * run's R2 prefix when it starts. The plan, prompts and skills come from those files
 * (`@voluma/workflow`). A workflow's text reaches a prompt only through a commit of this
 * repo, which is the trust boundary.
 *
 * `smoke` is a two-task workflow that checks the runner end to end; `mouse-oa` follows with
 * its first commit.
 */
export interface CatalogEntry {
  workflow: string;
}

export type Catalog = Record<string, CatalogEntry>;

export const catalog: Catalog = {
  smoke: { workflow: "workflows/smoke" },
};
