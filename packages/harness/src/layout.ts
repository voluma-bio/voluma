/**
 * Where a run's files are, for the model and for the sandbox. The one place that pairs a mount
 * path with its R2 prefix, per thread: the runner mounts `mounts`, the tool descriptions say
 * `description`, and host-side tools turn paths into keys with `keyOf`.
 *
 * A worker mounts the run's `/scratch` and `/outputs` read-write and works in `/scratch/<its name>/`. A checker mounts `/outputs`
 * read-only and writes only `/scratch/<its name>/`, the R2 prefix `scratch/<its name>/`; the main
 * agent has the same shape, with `/outputs` writable when its role holds `bash` (it then does
 * tasks itself, `mainWorks`), and a sandbox only then. Host-side (`keyOf`, so `view_image`) they also read
 * the run's `/scratch`, but a checker only the files the attempt under review cites as
 * evidence: the worker's scripts, logs and notes stay unread. Its sandbox does
 * not mount the rest. The path namespace is the same for every thread:
 * `/scratch/<name>/x.png` is the key `scratchKey(runId, "<name>/x.png")` whoever wrote it, so
 * evidence `{root: "scratch", path: "<name>/x.png"}` resolves the same way.
 *
 * `/inputs` is mounted read-only in every sandbox. Only a thread of a task whose `tasks.json`
 * entry sets `copyInputs` gets it copied to local disk (`stage`); the others read the mount.
 *
 * Every sandbox gets `SCRATCH`, its own folder `/scratch/<name>` (`ThreadLayout.dir`).
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
  /** `main` has a sandbox only if its role holds `bash` (`runLayout`'s `mainWorks`). */
  role: "worker" | "checker" | "main";
  /** The thread id without the run id: the sandbox's name, and the folder of its spill and (non-workers) scratch. */
  name: string;
  /** What the thread's sandbox mounts. */
  mounts: SandboxMount[];
  /** The thread's writable scratch mount: `/scratch` for a worker, `/scratch/<name>` for the others. */
  scratch: SandboxMount;
  /** The thread's own working folder, `/scratch/<name>`: `SCRATCH`, the command workdir, its spill folder. */
  dir: string;
  /** The sandbox's env: the run's `PYTHONPATH` and `SCRATCH` (`dir`). */
  env: Record<string, string>;
  /** `/inputs` is copied to local disk in this thread's sandbox; otherwise it is the read-only mount. */
  copiesInputs: boolean;
  /** The mounts, as bullet lines for the tool description. */
  description: string;
  /** Tells a model that resumes a thread which of its files survived in a new sandbox. */
  restartNote: string;
  /** Where the full output of a truncated `bash` call is written, in the sandbox. */
  toolOutputPath(toolCallId: string): string;
  /** A path the model named, absolute: a relative one is read from `dir`, the folder its commands run in. */
  resolve(path: string): string;
  /** Whether the absolute path is under a mount (or a host-only folder), so `keyOf` can name its key. */
  mounted(path: string): boolean;
  /**
   * The bucket key of a file the model named by its sandbox path (`resolve`d), for host-side tools that
   * read or write the mounts without the sandbox. Throws on a path outside what the thread can
   * see (or outside what it can write, when `write`) and on `..` segments.
   */
  keyOf(path: string, access: "read" | "write"): string;
}

type RoleParts = Pick<ThreadLayout, "mounts" | "scratch" | "description" | "restartNote"> & {
  hostOnly: SandboxMount[];
};

export interface RunLayout {
  /** The main agent's role holds `bash` (`runLayout`'s `mainWorks`): its `/outputs` is writable. */
  mainWorks: boolean;
  /** The run's `PYTHONPATH`, for a sandbox outside the threads (the convert sandbox). */
  pythonPath: string;
  /**
   * The layout of a thread id as `thread-id.ts` builds it. `cited` says whether the attempt a
   * checker reviews cites a scratch file (the path after `/scratch/`); it gates the checker's
   * host-side reads of the rest of the run's scratch, and without it a checker reads none.
   */
  forThread(threadId: string, cited?: (path: string) => boolean): ThreadLayout;
}

/**
 * `inputPrefix` is the R2 prefix of the run's read-only inputs. `copiesInputs(taskId)` says the
 * task's threads get them copied to local disk, which the workflow declares (`copyInputs`):
 * reading the DICOM straight from a cold mount is slow (measured on Modal: OA7-1R, 1,126 files,
 * 535 MB, intake took 179-302 s on the mount against a 7-16 s copy plus 6 s on local disk;
 * OA6-1RK 62-187 s against 5 s plus 4 s), while the 32-way copy hides the per-file latency. Only
 * the task that reads the DICOM is worth it: later tasks read `hu.npy` from `/outputs`, and the
 * copy costs every start and idle restart 5-16 s. The main thread never copies.
 * `skills` is `WorkflowDefinition.skills`: `PYTHONPATH` lets one skill's script import another
 * skill's module (module names are unique across skills, a test enforces it).
 */
export function runLayout(
  runId: string,
  inputPrefix: string,
  skills: readonly Skill[],
  /** The main agent's role holds `bash`: it does tasks itself, so its `/outputs` is writable. */
  mainWorks = false,
  copiesInputs: (taskId: string) => boolean = () => false,
): RunLayout {
  const scratch = scratchPrefix(runId);
  const pythonPath = skills.map((s) => `${s.path}/resources`).join(":");
  const inputs = (copy: boolean): SandboxMount => ({
    path: INPUTS,
    prefix: inputPrefix,
    access: "read-only",
    ...(copy && { stage: true }),
  });
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
  const common = (copy: boolean) =>
    `- ${INPUTS} is the input data${copy ? ", copied to local disk" : ", read from the bucket (not copied)"}: read it, do not modify it.\n` +
    `- ${WORKFLOW} holds the workflow's skills and resources, under their repo paths: read them, do not modify them.\n`;

  // Measured on Modal's R2 mounts (run p659): a file written whole in one pass works; seeks,
  // reopening for update and renames fail with EINVAL, EBADF, EPERM or ENOSYS, and VTK's
  // writers (pyvista `.save`) crash the process.
  const writeRule = (writable: string) =>
    `- Files under ${writable} live on cloud storage: a file can be created, or replaced, by writing it whole from start to end in one pass, and nothing else. ` +
    "Seeking back, appending, reopening a file to change it, truncating, renaming (mv, sed -i, os.rename, os.replace) and keeping times (cp -p, cp -a, shutil.copy2) fail there; " +
    "so do np.savez, tifffile and memmap writes, and pyvista/VTK saves crash or fail. Anything a library writes in several steps goes to /tmp first; then copy it with a plain `cp` or shutil.copy " +
    `(cp /tmp/x.vtp $SCRATCH/). Reading is unrestricted.\n`;

  // What differs by role. `hostOnly` entries are readable by host-side tools, not mounted.
  const worker = (dir: string, copy: boolean): RoleParts => {
    const writable: SandboxMount = { path: SCRATCH, prefix: scratch, access: "read-write" };
    return {
      mounts: [inputs(copy), workflow, writable, outputs("read-write")],
      scratch: writable,
      hostOnly: [],
      description:
        `${common(copy)}${writeRule(`${OUTPUTS} and ${SCRATCH}`)}- ${OUTPUTS} is for files you produce; they are kept.\n` +
        `- ${SCRATCH} is for intermediate files and is kept too; the other threads' folders are there as well. Work in $SCRATCH (${dir}) and write nothing else under ${SCRATCH}.`,
      restartNote: `The sandbox was restarted. ${OUTPUTS} and ${SCRATCH} were kept, ${copy ? `${INPUTS} was copied again, ` : ""}and local files elsewhere (including /tmp) are gone.`,
    };
  };
  const confined = (
    name: string,
    dir: string,
    outputsAccess: SandboxMount["access"],
    copy: boolean,
  ): RoleParts => {
    const writable: SandboxMount = {
      path: dir,
      prefix: `${scratch}${name}/`,
      access: "read-write",
    };
    return {
      mounts: [inputs(copy), workflow, outputs(outputsAccess), writable],
      scratch: writable,
      // After `mounts`: the more specific writable folder matches first.
      hostOnly: [{ path: SCRATCH, prefix: scratch, access: "read-only" }],
      description:
        `${common(copy)}${writeRule(outputsAccess === "read-write" ? `${OUTPUTS} and ${dir}` : dir)}- ${OUTPUTS} holds the worker's files: ${outputsAccess === "read-write" ? "the files you produce go here too" : "read them, do not modify them"}.\n` +
        `- ${dir} is for your intermediate files; it is kept. $SCRATCH is ${dir}. Write nothing else under ${SCRATCH}. ` +
        `bash sees only your folder there; view_image also opens the files under ${SCRATCH}/ that the worker cited as evidence (read-only).`,
      restartNote: `The sandbox was restarted. ${dir} was kept, ${copy ? `${INPUTS} was copied again, ` : ""}and local files elsewhere (including /tmp) are gone.`,
    };
  };

  return {
    mainWorks,
    pythonPath,
    forThread(threadId, cited = () => false) {
      const parsed = parseThreadId(runId, threadId);
      const { name, kind } = parsed;
      const copy = parsed.kind !== "main" && copiesInputs(parsed.taskId);
      const role = kind === "worker" ? "worker" : kind === "check" ? "checker" : "main";
      const dir = `${SCRATCH}/${name}`;
      const parts =
        role === "worker"
          ? worker(dir, copy)
          : confined(name, dir, role === "main" && mainWorks ? "read-write" : "read-only", copy);
      const { hostOnly, ...rest } = parts;
      const table = [...parts.mounts, ...hostOnly];
      const resolve = (path: string) =>
        path.startsWith("/") ? path : `${dir}/${path.replace(/^(\.\/)+/, "")}`;
      return {
        ...rest,
        role,
        name,
        copiesInputs: copy,
        dir,
        env: { PYTHONPATH: pythonPath, SCRATCH: dir },
        toolOutputPath: (toolCallId) =>
          `${SCRATCH}/${toolOutputKey(runId, name, toolCallId).slice(scratch.length)}`,
        resolve,
        mounted: (path) => table.some((m) => path.startsWith(`${m.path}/`)),
        keyOf(named, access) {
          const path = resolve(named);
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
          if (role === "checker" && hostOnly.includes(mount)) {
            if (!cited(relative))
              throw new Error(
                `${path} is in the worker's folder and the worker did not cite it as evidence. A check can open the files the worker cited, and its own folder ${dir}.`,
              );
          }
          return `${mount.prefix}${relative}`;
        },
      };
    },
  };
}
