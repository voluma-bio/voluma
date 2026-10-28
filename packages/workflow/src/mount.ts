/** Where the sandbox mounts a pinned package: `/workflow/<repo>/<commit>/(root|sub/<path>)`. */
import { workflowPrefix } from "@voluma/contracts/r2";
import type { WorkflowPin } from "@voluma/contracts/workflow";

export const workflowMountPath = (pin: WorkflowPin) =>
  `/workflow/${workflowPrefix(pin).slice("workflows/".length).replace(/\/$/, "")}`;
