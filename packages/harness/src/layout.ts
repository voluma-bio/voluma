/**
 * Where a run's files are, for the model and for the sandbox. The one place that
 * pairs a mount path with its R2 prefix, per thread: the runner mounts `mounts`, the tool
 * description says `description`, and tools turn keys into paths with `toolOutputPath`.
 *
 * A worker mounts the run's `/scratch` and `/outputs` read-write. A checker (`SandboxRole`)
 * mounts `/outputs` read-only and writes only `/scratch/<its name>/`, the R2 prefix
 * `scratch/<its name>/`. The path namespace is the same for both: `/scratch/<name>/x.png` is the
 * key `scratchKey(runId, "<name>/x.png")` whoever wrote it, so evidence `{root: "scratch",
 * path: "<name>/x.png"}` resolves the same way.
 */
import {
  outputsPrefix,
  relativePathSchema,
  scratchPrefix,
  toolOutputKey,
  workflowSnapshotPrefix,
} from "@voluma/contracts/r2";
import type { Skill } from "@voluma/workflow/definition";
import type { SandboxMount } from "./ports/sandbox";

const INPUTS = "/inputs";
const OUTPUTS = "/outputs";
const SCRATCH = "/scratch";
const WORKFLOW = "/workflow";

export interface ThreadLayout {
  /** `worker` or `checker`: the sandbox role of the thread. */
  role: "worker" | "checker";
  /** The thread id without the run id: the sandbox's name, and a checker's folder under `/scratch`. */
  name: string;
  mounts: SandboxMount[];
  /** The thread's writable scratch mount: `/scratch`, or `/scratch/<name>` for a checker. */
  scratch: SandboxMount;
  /** The mounts, as bullet lines for the tool description. */
  description: string;
  /** Tells a model that resumes a thread which of its files survived in a new sandbox. */
  restartNote: string;
  /** Where the full output of a truncated `bash` call is written, in the sandbox. */
  toolOutputPath(toolCallId: string): string;
  /**
   * The bucket key of a file the model named by its sandbox path, for host-side tools that
   * read or write the mounts without the sandbox. Throws on a path outside the mounts (or
   * outside the read-write ones when `write`) and on `..` segments.
   */
  keyOf(path: string, access: "read" | "write"): string;
}

export interface RunLayout {
  /**
   * The environment of every sandbox of the run, whatever its role or thread. `PYTHONPATH` lets
   * one skill's script import another skill's module; `skills` is `WorkflowDefinition.skills`.
   * Module names are unique across skills (a test enforces it), so the order does not matter.
   */
  env: Record<string, string>;
  /** The layout of a worker or check thread (`<runId>.<taskId>.worker[.n]` / `.check[.n]`). */
  forThread(threadId: string): ThreadLayout;
}

/** `inputPrefix` is the R2 prefix of the run's read-only inputs; it is staged to local disk. */
export function runLayout(runId: string, inputPrefix: string, skills: readonly Skill[]): RunLayout {
  const scratch = scratchPrefix(runId);
  const inputs: SandboxMount = {
    path: INPUTS,
    prefix: inputPrefix,
    access: "read-only",
    stage: true,
  };
  const workflow: SandboxMount = {
    path: WORKFLOW,
    prefix: workflowSnapshotPrefix(runId),
    access: "read-only",
  };
  const outputs = (access: SandboxMount["access"]): SandboxMount => ({
    path: OUTPUTS,
    prefix: outputsPrefix(runId),
    access,
  });

  return {
    env: { PYTHONPATH: skills.map((s) => `${s.path}/resources`).join(":") },
    forThread(threadId) {
      // Task ids hold no '.', so the role is the second segment (`supervisor.ts` `threadId`).
      const name = threadId.slice(runId.length + 1);
      const kind = name.split(".")[1];
      if (!threadId.startsWith(`${runId}.`) || (kind !== "worker" && kind !== "check"))
        throw new Error(`${threadId} is not a worker or check thread of run ${runId}`);
      const role = kind === "worker" ? "worker" : "checker";
      const writable: SandboxMount =
        role === "worker"
          ? { path: SCRATCH, prefix: scratch, access: "read-write" }
          : { path: `${SCRATCH}/${name}`, prefix: `${scratch}${name}/`, access: "read-write" };
      const scratchDir = writable.path;
      const mounts: SandboxMount[] =
        role === "worker"
          ? [inputs, workflow, writable, outputs("read-write")]
          : [inputs, workflow, outputs("read-only"), writable];
      const common =
        `- ${INPUTS} is a local copy of the input data: read it, do not modify it.\n` +
        `- ${WORKFLOW} holds the workflow's skills and resources, under their repo paths: read them, do not modify them.\n`;
      return {
        role,
        name,
        mounts,
        scratch: writable,
        description:
          role === "worker"
            ? `${common}- ${OUTPUTS} is for files you produce; they are kept.\n` +
              `- ${SCRATCH} is for intermediate files; it is kept too.`
            : `${common}- ${OUTPUTS} holds the worker's files: read them, do not modify them.\n` +
              `- ${scratchDir} is for your intermediate files; it is kept. Write nothing else: the rest of ${SCRATCH} is not available to you.`,
        restartNote:
          role === "worker"
            ? `The sandbox was restarted. ${OUTPUTS} and ${SCRATCH} were kept, ${INPUTS} was copied again, and local files elsewhere (including /tmp) are gone.`
            : `The sandbox was restarted. ${scratchDir} was kept, ${INPUTS} was copied again, and local files elsewhere (including /tmp) are gone.`,
        toolOutputPath: (toolCallId) =>
          `${SCRATCH}/${toolOutputKey(runId, toolCallId, role === "worker" ? "" : `${name}/`).slice(scratch.length)}`,
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
    },
  };
}
