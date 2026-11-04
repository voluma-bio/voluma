/**
 * The workflow catalog: every workflow a run can start from. The API takes a `workflowId` from
 * here, never a path, so a caller can't point the runner at another directory; a run pins the
 * deployed commit and the entry's `path`, and the runner snapshots that directory (and
 * `workflows/core`) when it starts. A workflow's text reaches a prompt only through a commit of
 * this repo, which is the trust boundary.
 *
 * Names, units and sections of a workflow's outputs are its `outputs.yaml`: the web app reads it
 * with `outputCatalogOf` (`output-catalogs.ts`, Vite only), the API from disk (`apps/api`).
 */

export interface BundledWorkflow {
  /** The catalog id `createStudy` takes. */
  id: string;
  /** The directory a run pins, relative to the repo root. */
  path: string;
  name: string;
  description: string;
}

export const catalog = {
  // A starter for the lab to edit (`workflows/mouse-oa/skills/mouse-oa/SKILL.md`).
  "mouse-oa": {
    id: "mouse-oa",
    path: "workflows/mouse-oa",
    name: "Mouse OA knee",
    description: "Measures the proximal tibia, the distal femur and the knee's bone structures.",
  },
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
