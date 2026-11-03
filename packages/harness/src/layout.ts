/**
 * Where a run's files are, for the model and for the sandbox. The one place that pairs a mount
 * path with its R2 prefix, per thread: the sandbox spec mounts `mounts` (`specOf`), the tool descriptions say
 * `description`, and host-side tools turn paths into keys with `keyOf`.
 *
 * An agent (`forAgent`): its own `/work/<folder>` read-write; every agent's folder under `/work` (a blind worker's: its own and the one it started from)
 * (so main's `plan.md` too), `/outputs` (the published versions), `/run` (the files rendered from the
 * events), `/inputs` and `/workflow` read-only. Mounts must not overlap (a nested one is unreliable on
 * Modal: the same spec once wrote and once failed read-only), so the sandbox mounts each peer folder that
 * exists when it is created (`peers`); host-side tools (`read`) see all of `/work`, peers
 * that started later included. The folder is the agent's name, except that every main thread (`main`,
 * `main.2`) works in `main`; the sandbox keeps the thread's name.
 *
 * `/inputs` is mounted read-only in every sandbox, read from the bucket and not copied.
 *
 * Every sandbox gets `WORK`, its own folder `/work/<folder>` (`ThreadLayout.dir`).
 */
import {
  evidencePrefix,
  inputReviewPrefix,
  outputsPrefix,
  relativePathSchema,
  reviewAssetPrefix,
  runFilesPrefix,
  workflowSnapshotPrefix,
  workPrefix,
} from "@voluma/contracts/r2";
import type { Skill } from "@voluma/workflow/definition";
import type { SandboxMount } from "./ports/sandbox";

const INPUTS = "/inputs";
export const OUTPUTS = "/outputs";
export const WORKFLOW = "/workflow";
export const EVIDENCE = "/evidence";
export const REVIEW = "/review";
const INPUT_REVIEW = "/input-review";
const RUN = "/run";
const WORK = "/work";

export interface ThreadLayout {
  /** What the thread is in the run. */
  place: "worker" | "main";
  /** The role file it runs on: the key of the definition's `agents`. */
  role: string;
  /** The thread's name (`AgentRecord.name`): the sandbox's name. */
  name: string;
  /** What the thread's sandbox mounts. */
  mounts: SandboxMount[];
  /** The thread's writable folder mount. */
  scratch: SandboxMount;
  /** The thread's own working folder, `/work/<folder>`: `WORK`, the command workdir, its spill folder. */
  dir: string;
  /** The sandbox's env: the run's `PYTHONPATH` and `WORK` (`dir`). */
  env: Record<string, string>;
  /** The tools its role holds (the role file's, less what the run cannot grant). */
  tools: readonly string[];
  /** The sandbox may reach the gateway (and gets its URL and token): the role holds `segment_sam`. */
  gateway: boolean;
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

/** What a sandbox is created from (`specOf`): a thread's layout, or the run's convert sandbox. */
export type SandboxLayout = Pick<ThreadLayout, "name" | "mounts" | "env" | "gateway"> & {
  /** The command workdir; absent: the image's. */ dir?: string;
};

export interface RunLayout {
  /** The layout of an agent's thread: `tools` are the ones its role holds. */
  forAgent(agent: {
    name: string;
    role: "main" | "worker";
    tools: readonly string[];
    /** The `/work` folders of the other agents that exist now: mounted read-only in the sandbox. */
    peers: readonly string[];
    /** A blind worker (`start_worker {blind}`): only its own folder is under `/work`, in the sandbox and host-side. */
    blind: boolean;
    /** The closed worker this one started from (`start_worker {from}`): its folder stays readable to a blind worker. */
    from?: string;
  }): ThreadLayout;
}

export interface RunLayoutOptions {
  runId: string;
  /** The R2 prefix of the run's read-only inputs. */
  inputPrefix: string;
  /**
   * `WorkflowDefinition.skills`: `PYTHONPATH` lets one skill's script import another skill's
   * module (module names are unique across skills, a test enforces it).
   */
  skills: readonly Skill[];
}

/**
 * The mount of `table` that holds the absolute `path`, and the bucket key it names. A mount whose
 * prefix has no trailing slash is a single file (`/work/main/plan.md`): its prefix is the whole key.
 * Throws on a path outside what the thread can see (or write, when `access` is `write`) and on
 * invalid segments.
 */
const holds = (m: SandboxMount, path: string) =>
  path.startsWith(`${m.path}/`) || (!m.prefix.endsWith("/") && path === m.path);

function lookup(table: readonly SandboxMount[], path: string, access: "read" | "write") {
  const mount = table.find((m) => holds(m, path));
  if (!mount || (access === "write" && mount.access !== "read-write")) {
    const usable = table.filter((m) => access === "read" || m.access === "read-write");
    throw new Error(
      `${path} is not under ${usable.map((m) => m.path).join(", ")}, the paths this tool can ${access}`,
    );
  }
  const relative = path.slice(mount.path.length + 1);
  if (path === mount.path) return { mount, relative: "", key: mount.prefix };
  if (!relativePathSchema.safeParse(relative).success)
    throw new Error(`${path} is not a valid path`);
  return { mount, relative, key: `${mount.prefix}${relative}` };
}

/**
 * The review-asset converter's sandbox, outside the threads and the same for every loop: reads
 * the evidence, the published versions (`/outputs`, the agent loop's) and the workflow, writes the
 * run's review prefix and the input's conversion cache, no network. The converter imports
 * `sidecar` through the run's PYTHONPATH.
 */
export function convertLayout(o: {
  runId: string;
  inputId: string;
  skills: readonly Skill[];
}): SandboxLayout {
  return {
    name: "convert",
    mounts: [
      { path: EVIDENCE, prefix: evidencePrefix(o.runId), access: "read-only" },
      { path: OUTPUTS, prefix: outputsPrefix(o.runId), access: "read-only" },
      { path: WORKFLOW, prefix: workflowSnapshotPrefix(o.runId), access: "read-only" },
      { path: REVIEW, prefix: reviewAssetPrefix(o.runId), access: "read-write" },
      { path: INPUT_REVIEW, prefix: inputReviewPrefix(o.inputId), access: "read-write" },
    ],
    env: { PYTHONPATH: pythonPathOf(o.skills), VOLUMA_REVIEW_CACHE: INPUT_REVIEW },
    gateway: false,
  };
}

const pythonPathOf = (skills: readonly Skill[]) =>
  skills.map((s) => `${s.path}/resources`).join(":");

export function runLayout({ runId, inputPrefix, skills }: RunLayoutOptions): RunLayout {
  const pythonPath = pythonPathOf(skills);
  const inputs: SandboxMount = { path: INPUTS, prefix: inputPrefix, access: "read-only" };
  const workflow: SandboxMount = {
    path: WORKFLOW,
    prefix: workflowSnapshotPrefix(runId),
    access: "read-only",
  };
  const outputs: SandboxMount = {
    path: OUTPUTS,
    prefix: outputsPrefix(runId),
    access: "read-only",
  };
  const common =
    `- ${INPUTS} is the input data, read from the bucket (not copied): read it, do not modify it.\n` +
    `- ${WORKFLOW} holds the workflow's skills and resources, under their repo paths: read them, do not modify them.\n`;

  // Measured on Modal's R2 mounts (run p659): a file written whole in one pass works; seeks,
  // reopening for update and renames fail with EINVAL, EBADF, EPERM or ENOSYS, and VTK's
  // writers (pyvista `.save`) crash the process.
  const writeRule = (writable: string) =>
    `- Files under ${writable} live on cloud storage: a file can be created, or replaced, by writing it whole from start to end in one pass, and nothing else. ` +
    "Seeking back, appending, reopening a file to change it, truncating, renaming (mv, sed -i, os.rename, os.replace) and keeping times (cp -p, cp -a, shutil.copy2) fail there; " +
    "so do np.savez, tifffile and memmap writes, and pyvista/VTK saves crash or fail. Anything a library writes in several steps goes to /tmp first; then copy it with a plain `cp` or shutil.copy " +
    `(cp /tmp/x.vtp $WORK/). Reading is unrestricted.\n`;

  return {
    forAgent({ name, role, tools, peers, blind, from }) {
      const folder = role === "main" ? "main" : name;
      const dir = `${WORK}/${folder}`;
      const work = workPrefix(runId);
      const own: SandboxMount = { path: dir, prefix: `${work}${folder}/`, access: "read-write" };
      const visible = blind ? (from ? [from] : []) : peers;
      const peerMounts: SandboxMount[] = [...new Set(visible)]
        .filter((p) => p !== folder)
        .map((p) => ({ path: `${WORK}/${p}`, prefix: `${work}${p}/`, access: "read-only" }));
      const hostWork: SandboxMount[] = blind
        ? []
        : [{ path: WORK, prefix: work, access: "read-only" }];
      const mounts: SandboxMount[] = [
        inputs,
        workflow,
        outputs,
        { path: RUN, prefix: runFilesPrefix(runId), access: "read-only" },
        own,
        ...peerMounts,
      ];
      // `own` before the whole of /work: the more specific folder matches first.
      const table = [...mounts, ...hostWork];
      const resolve = (path: string) =>
        path.startsWith("/") ? path : `${dir}/${path.replace(/^(\.\/)+/, "")}`;
      return {
        place: role,
        role,
        name,
        mounts,
        scratch: own,
        dir,
        env: { PYTHONPATH: pythonPath, WORK: dir },
        tools,
        gateway: tools.includes("segment_sam"),
        description:
          `${common}- ${OUTPUTS} holds every published output version, one folder per version: read it, do not modify it. ${RUN}/outputs.yaml lists the versions and ${RUN}/final-outputs.yaml the outputs the researcher asked for; both are rewritten as the run goes.\n` +
          `${writeRule(dir)}- ${dir} is your own folder and the only place you write: $WORK is ${dir}. It is kept, ` +
          (blind
            ? `and it is the only folder under ${WORK} you can see: you work blind, so no other agent's files are open to you.\n`
            : `and the other agents' folders under ${WORK} are read-only to you; read their files, never change them. A folder of an agent that started after your sandbox did is visible to read at once, and to bash after the sandbox restarts. `) +
          `Reporting an output moves the files you name out of your folder into ${OUTPUTS}, leaving a <file>.removed.txt that says where.`,
        restartNote: `The sandbox was restarted. ${dir} was kept, and local files elsewhere (including /tmp) are gone.`,
        toolOutputPath: (toolCallId) => `${dir}/.tool-output/${toolCallId}`,
        resolve,
        mounted: (path) => table.some((m) => holds(m, path)),
        keyOf: (named, access) => lookup(table, resolve(named), access).key,
      };
    },
  };
}
