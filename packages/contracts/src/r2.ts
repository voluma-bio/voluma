/**
 * The one place R2 key layout is written. Every reader and writer of the
 * bucket (sandbox mounts, tool-output spill, importers) builds keys here.
 * Prefixes end in `/` so they can be used directly as mount prefixes.
 *
 * Inputs live under `inputs/<inputId>/`, not under a run: a scan is uploaded
 * before any run exists and one input can serve several runs. The sandbox
 * mounts the run's input prefix (or the reference scan's) read-only at `/inputs`.
 */
import { z } from "zod";
import { segmentSchema } from "./ids";

/** A relative path under a prefix; every segment is validated. */
export const relativePathSchema = z
  .string()
  .min(1)
  .refine((p) => p.split("/").every((s) => segmentSchema.safeParse(s).success), {
    message: "must be a relative path of valid segments",
  });

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const seg = (s: string) => segmentSchema.parse(s);
const rel = (p: string) => relativePathSchema.parse(p);

export const inputPrefix = (inputId: string) => `inputs/${seg(inputId)}/`;
/**
 * Where an upload's presigned PUTs land before complete moves them to `inputPrefix`, so a
 * PUT URL that outlives the upload can't change what a run reads (`run.ts`, Uploads).
 */
export const uploadPrefix = (inputId: string) => `uploads/${seg(inputId)}/`;
export const runPrefix = (runId: string) => `runs/${seg(runId)}/`;
/**
 * The run's snapshot of `workflows/core/` and its workflow's directory (`workflows/<name>/`), copied from the runner's checkout when the run starts and keeping
 * their repo paths. The sandbox mounts it read-only at `/workflow`, so a resume after a
 * redeploy sees the files the run began with.
 */
export const workflowSnapshotPrefix = (runId: string) => `${runPrefix(runId)}workflow/`;
export const scratchPrefix = (runId: string) => `${runPrefix(runId)}scratch/`;
/** All tasks' outputs; the sandbox mounts this read-write at `/outputs`. */
export const outputsPrefix = (runId: string) => `${runPrefix(runId)}outputs/`;
export const taskOutputPrefix = (runId: string, task: string) =>
  `${outputsPrefix(runId)}${seg(task)}/`;

export const inputKey = (inputId: string, path: string) => `${inputPrefix(inputId)}${rel(path)}`;
export const uploadKey = (inputId: string, path: string) => `${uploadPrefix(inputId)}${rel(path)}`;
export const scratchKey = (runId: string, path: string) => `${scratchPrefix(runId)}${rel(path)}`;
export const outputKey = (runId: string, task: string, path: string) =>
  `${taskOutputPrefix(runId, task)}${rel(path)}`;

/** Full output of a `bash` call that was truncated for the model. */
export const toolOutputKey = (runId: string, toolCallId: string) =>
  `${scratchPrefix(runId)}.tool-output/${seg(toolCallId)}`;

/**
 * Content-addressed evidence: a file that backs a stored number, copied here
 * once and never overwritten, so a rerun of a task can't change what an
 * earlier revision points at. Inside the run prefix, so mounts stay isolated.
 */
export const evidenceKey = (runId: string, sha256: string) =>
  `${runPrefix(runId)}evidence/${sha256Schema.parse(sha256)}`;

/**
 * What the review converter made from one reported file (`events.ts`, `assets.ready`): zarr
 * levels and meshes, keyed by the file's sha256. Per run, inside the run prefix; the convert
 * sandbox mounts `evidence/` read-only and `review/` read-write, which do not overlap.
 */
export const reviewAssetPrefix = (runId: string) => `${runPrefix(runId)}review/`;
export const reviewAssetKey = (runId: string, sha256: string, path: string) =>
  `${reviewAssetPrefix(runId)}${sha256Schema.parse(sha256)}/${rel(path)}`;

/** Reference data for the OA6-1RK sample: the raw scan and the reference run. */
export const referencePrefix = (part: "scan" | "run") => `reference/OA6-1RK/${part}/`;
export const referenceKey = (part: "scan" | "run", path: string) =>
  `${referencePrefix(part)}${rel(path)}`;

/** The existing ZIP is beside scan/, not inside the sandbox's DICOM mount. */
export const referenceScanArchiveKey = () => "reference/OA6-1RK/scan.zip";

/**
 * A stored pointer to a file in R2: an `evidenceKey`, or a key under the
 * reference run (whose files are already immutable). Review data stores full
 * keys of this form, never paths relative to some root.
 */
export const storedKeySchema = z.string().refine(
  (k) => {
    const evidence = /^runs\/([^/]+)\/evidence\/([0-9a-f]{64})$/.exec(k);
    if (evidence) return segmentSchema.safeParse(evidence[1]).success;
    const ref = referencePrefix("run");
    return k.startsWith(ref) && relativePathSchema.safeParse(k.slice(ref.length)).success;
  },
  { message: "must be an evidence key or a reference-run key" },
);

/**
 * A stored pointer to a folder of files (a DICOM series): a prefix under an
 * input or under the reference scan. Ends in `/`.
 */
export const storedPrefixSchema = z.string().refine(
  (k) => {
    if (!k.endsWith("/")) return false;
    const path = k.slice(0, -1);
    const inputs = /^inputs\/([^/]+)\/(.+)$/.exec(path);
    if (inputs) {
      return (
        segmentSchema.safeParse(inputs[1]).success &&
        relativePathSchema.safeParse(inputs[2]).success
      );
    }
    const scan = referencePrefix("scan");
    if (k === scan) return true;
    return path.startsWith(scan) && relativePathSchema.safeParse(path.slice(scan.length)).success;
  },
  { message: "must be a folder under an input or the reference scan" },
);
