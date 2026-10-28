/**
 * Where a run's files are, for the model and for the sandbox. The one place that
 * pairs a mount path with its R2 prefix: the runner mounts `mounts`, the tool description says
 * `description`, and tools turn keys into paths with `toolOutputPath`.
 */
import { outputsPrefix, scratchPrefix, toolOutputKey, workflowPrefix } from "@voluma/contracts/r2";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { workflowMountPath } from "@voluma/workflow/mount";
import type { SandboxMount } from "./ports/sandbox";

const INPUTS = "/inputs";
const OUTPUTS = "/outputs";
const SCRATCH = "/scratch";
const WORKFLOW = "/workflow";

export interface RunLayout {
  mounts: SandboxMount[];
  /** The mounts, as bullet lines for the tool description. */
  description: string;
  /** Tells a model that resumes a thread which of its files survived in a new sandbox. */
  restartNote: string;
  /** Where `toolOutputKey(runId, toolCallId)` appears in the sandbox. */
  toolOutputPath(toolCallId: string): string;
}

/** `inputPrefix` is the R2 prefix of the run's read-only inputs; it is staged to local disk. */
/** `workflows` are the run's pins: only their packages are mounted, one read-only mount each. */
export function runLayout(
  runId: string,
  inputPrefix: string,
  workflows: readonly WorkflowPin[],
): RunLayout {
  const scratch = scratchPrefix(runId);
  return {
    mounts: [
      { path: INPUTS, prefix: inputPrefix, access: "read-only", stage: true },
      ...[...new Map(workflows.map((pin) => [workflowPrefix(pin), pin])).values()].map(
        (pin): SandboxMount => ({
          path: workflowMountPath(pin),
          prefix: workflowPrefix(pin),
          access: "read-only",
        }),
      ),
      { path: SCRATCH, prefix: scratch, access: "read-write" },
      { path: OUTPUTS, prefix: outputsPrefix(runId), access: "read-write" },
    ],
    description:
      `- ${INPUTS} is a local copy of the input data: read it, do not modify it.\n` +
      `- ${WORKFLOW} holds the workflow's skills and resources: read them, do not modify them.\n` +
      `- ${OUTPUTS} is for files you produce; they are kept.\n` +
      `- ${SCRATCH} is for temporary files.`,
    restartNote: `The sandbox was restarted. ${OUTPUTS} and ${SCRATCH} were kept, ${INPUTS} was copied again, and local files elsewhere (including /tmp) are gone.`,
    toolOutputPath: (toolCallId) =>
      `${SCRATCH}/${toolOutputKey(runId, toolCallId).slice(scratch.length)}`,
  };
}
