/**
 * Where a run's files are, for the model and for the sandbox. The one place that pairs a mount
 * path with its R2 prefix, per thread: the runner mounts `mounts`, the tool descriptions say
 * `description`, and host-side tools turn paths into keys with `keyOf`.
 *
 * A worker mounts the run's `/scratch` and `/outputs` read-write. A checker mounts `/outputs`
 * read-only and writes only `/scratch/<its name>/`, the R2 prefix `scratch/<its name>/`; the main
 * agent has the same shape (no sandbox yet). Host-side (`keyOf`, so `view_image`) they also read
 * the run's whole `/scratch`, which is how a checker opens the images the worker cited; its
 * sandbox does not mount the rest. The path namespace is the same for every thread:
 * `/scratch/<name>/x.png` is the key `scratchKey(runId, "<name>/x.png")` whoever wrote it, so
 * evidence `{root: "scratch", path: "<name>/x.png"}` resolves the same way.
 *
 * Every sandbox gets `SCRATCH`, its writable scratch path (`ThreadLayout.env`).
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
import { parseThreadId } from "./thread-id";

const INPUTS = "/inputs";
const OUTPUTS = "/outputs";
const SCRATCH = "/scratch";
const WORKFLOW = "/workflow";

export interface ThreadLayout {
  /** `main` has no sandbox today; its layout is the shape one would have. */
  role: "worker" | "checker" | "main";
  /** The thread id without the run id: the sandbox's name, and the folder of its spill and (non-workers) scratch. */
  name: string;
  /** What the thread's sandbox mounts. */
  mounts: SandboxMount[];
  /** The thread's writable scratch mount: `/scratch`, or `/scratch/<name>`. */
  scratch: SandboxMount;
  /** The sandbox's env: the run's `PYTHONPATH` and `SCRATCH`, the path of `scratch`. */
  env: Record<string, string>;
  /** The mounts, as bullet lines for the tool description. */
  description: string;
  /** Tells a model that resumes a thread which of its files survived in a new sandbox. */
  restartNote: string;
  /** Where the full output of a truncated `bash` call is written, in the sandbox. */
  toolOutputPath(toolCallId: string): string;
  /**
   * The bucket key of a file the model named by its sandbox path, for host-side tools that
   * read or write the mounts without the sandbox. Throws on a path outside what the thread can
   * see (or outside what it can write, when `write`) and on `..` segments.
   */
  keyOf(path: string, access: "read" | "write"): string;
}

type RoleParts = Pick<ThreadLayout, "mounts" | "scratch" | "description" | "restartNote"> & {
  hostOnly: SandboxMount[];
};

export interface RunLayout {
  /** The layout of a thread id as `thread-id.ts` builds it. */
  forThread(threadId: string): ThreadLayout;
}

/**
 * `inputPrefix` is the R2 prefix of the run's read-only inputs; it is staged to local disk.
 * `skills` is `WorkflowDefinition.skills`: `PYTHONPATH` lets one skill's script import another
 * skill's module (module names are unique across skills, a test enforces it).
 */
export function runLayout(runId: string, inputPrefix: string, skills: readonly Skill[]): RunLayout {
  const scratch = scratchPrefix(runId);
  const pythonPath = skills.map((s) => `${s.path}/resources`).join(":");
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
  const common =
    `- ${INPUTS} is a local copy of the input data: read it, do not modify it.\n` +
    `- ${WORKFLOW} holds the workflow's skills and resources, under their repo paths: read them, do not modify them.\n`;

  // What differs by role. `hostOnly` entries are readable by host-side tools, not mounted.
  const worker = (): RoleParts => {
    const writable: SandboxMount = { path: SCRATCH, prefix: scratch, access: "read-write" };
    return {
      mounts: [inputs, workflow, writable, outputs("read-write")],
      scratch: writable,
      hostOnly: [],
      description:
        `${common}- ${OUTPUTS} is for files you produce; they are kept.\n` +
        `- ${SCRATCH} is for intermediate files; it is kept too. Work in $SCRATCH (${SCRATCH}).`,
      restartNote: `The sandbox was restarted. ${OUTPUTS} and ${SCRATCH} were kept, ${INPUTS} was copied again, and local files elsewhere (including /tmp) are gone.`,
    };
  };
  const confined = (name: string): RoleParts => {
    const dir = `${SCRATCH}/${name}`;
    const writable: SandboxMount = {
      path: dir,
      prefix: `${scratch}${name}/`,
      access: "read-write",
    };
    return {
      mounts: [inputs, workflow, outputs("read-only"), writable],
      scratch: writable,
      // After `mounts`: the more specific writable folder matches first.
      hostOnly: [{ path: SCRATCH, prefix: scratch, access: "read-only" }],
      description:
        `${common}- ${OUTPUTS} holds the worker's files: read them, do not modify them.\n` +
        `- ${dir} is for your intermediate files; it is kept. $SCRATCH is ${dir}. Write nothing else under ${SCRATCH}. ` +
        `bash sees only your folder there; view_image also opens the files the worker kept under ${SCRATCH}/ (read-only).`,
      restartNote: `The sandbox was restarted. ${dir} was kept, ${INPUTS} was copied again, and local files elsewhere (including /tmp) are gone.`,
    };
  };

  return {
    forThread(threadId) {
      const { name, kind } = parseThreadId(runId, threadId);
      const role = kind === "worker" ? "worker" : kind === "check" ? "checker" : "main";
      const parts = role === "worker" ? worker() : confined(name);
      const { hostOnly, ...rest } = parts;
      return {
        ...rest,
        role,
        name,
        env: { PYTHONPATH: pythonPath, SCRATCH: parts.scratch.path },
        toolOutputPath: (toolCallId) =>
          `${SCRATCH}/${toolOutputKey(runId, name, toolCallId).slice(scratch.length)}`,
        keyOf(path, access) {
          const table = [...parts.mounts, ...hostOnly];
          const mount = table.find((m) => path.startsWith(`${m.path}/`));
          if (!mount || (access === "write" && mount.access !== "read-write")) {
            const usable = table.filter((m) => access === "read" || m.access === "read-write");
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
