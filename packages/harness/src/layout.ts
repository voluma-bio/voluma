/**
 * Where a run's files are, for the model and for the sandbox. The one place that
 * pairs a mount path with its R2 prefix: the runner mounts `mounts`, the tool description says
 * `description`, and tools turn keys into paths with `toolOutputPath`.
 */
import {
  outputsPrefix,
  relativePathSchema,
  scratchPrefix,
  toolOutputKey,
} from "@voluma/contracts/r2";
import type { SandboxMount } from "./ports/sandbox";

const INPUTS = "/inputs";
const OUTPUTS = "/outputs";
const SCRATCH = "/scratch";

export interface RunLayout {
  mounts: SandboxMount[];
  /** The mounts, as bullet lines for the tool description. */
  description: string;
  /** Tells a model that resumes a thread which of its files survived in a new sandbox. */
  restartNote: string;
  /** Where `toolOutputKey(runId, toolCallId)` appears in the sandbox. */
  toolOutputPath(toolCallId: string): string;
  /**
   * The bucket key of a file the model named by its sandbox path, for host-side tools that
   * read or write the mounts without the sandbox. Throws on a path outside the mounts (or
   * outside the read-write ones when `write`) and on `..` segments.
   */
  keyOf(path: string, access: "read" | "write"): string;
}

/** `inputPrefix` is the R2 prefix of the run's read-only inputs; it is staged to local disk. */
export function runLayout(runId: string, inputPrefix: string): RunLayout {
  const scratch = scratchPrefix(runId);
  const mounts: SandboxMount[] = [
    { path: INPUTS, prefix: inputPrefix, access: "read-only", stage: true },
    { path: SCRATCH, prefix: scratch, access: "read-write" },
    { path: OUTPUTS, prefix: outputsPrefix(runId), access: "read-write" },
  ];
  return {
    mounts,
    description:
      `- ${INPUTS} is a local copy of the input data: read it, do not modify it.\n` +
      `- ${OUTPUTS} is for files you produce; they are kept.\n` +
      `- ${SCRATCH} is for temporary files.`,
    restartNote: `The sandbox was restarted. ${OUTPUTS} and ${SCRATCH} were kept, ${INPUTS} was copied again, and local files elsewhere (including /tmp) are gone.`,
    toolOutputPath: (toolCallId) =>
      `${SCRATCH}/${toolOutputKey(runId, toolCallId).slice(scratch.length)}`,
    keyOf(path, access) {
      const mount = mounts.find((m) => path.startsWith(`${m.path}/`));
      if (!mount || (access === "write" && mount.access !== "read-write")) {
        const usable = mounts.filter((m) => access === "read" || m.access === "read-write");
        throw new Error(
          `${path} is not under ${usable.map((m) => m.path).join(", ")}, the paths this tool can ${access}`,
        );
      }
      const relative = path.slice(mount.path.length + 1);
      if (!relativePathSchema.safeParse(relative).success)
        throw new Error(`${path} is not a valid path`);
      return `${mount.prefix}${relative}`;
    },
  };
}
