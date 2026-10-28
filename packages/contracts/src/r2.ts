/**
 * The one place R2 key layout is written. Every reader and writer of the
 * bucket (sandbox mounts, tool-output spill, importers) builds keys here.
 * Prefixes end in `/` so they can be used directly as mount prefixes.
 */
import { z } from "zod";
import { segmentSchema } from "./ids";
import { type WorkflowPin, workflowPinSchema } from "./workflow";

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

/** All workflow packages; the sandbox mounts this read-only at `/workflow`. */
export const workflowsPrefix = () => "workflows/";

export const workflowPrefix = (pin: WorkflowPin) => {
  const { repo, commit } = workflowPinSchema.parse(pin);
  return `workflows/${repo}/${commit}/`;
};

export const runPrefix = (runId: string) => `runs/${seg(runId)}/`;
export const inputsPrefix = (runId: string) => `${runPrefix(runId)}inputs/`;
export const scratchPrefix = (runId: string) => `${runPrefix(runId)}scratch/`;
/** All tasks' outputs; the sandbox mounts this read-write at `/outputs`. */
export const outputsPrefix = (runId: string) => `${runPrefix(runId)}outputs/`;
export const taskOutputPrefix = (runId: string, task: string) =>
  `${outputsPrefix(runId)}${seg(task)}/`;

export const inputKey = (runId: string, path: string) => `${inputsPrefix(runId)}${rel(path)}`;
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

/** Reference data for the OA6-1RK sample: the raw scan and the reference run. */
export const referencePrefix = (part: "scan" | "run") => `reference/OA6-1RK/${part}/`;
export const referenceKey = (part: "scan" | "run", path: string) =>
  `${referencePrefix(part)}${rel(path)}`;

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
 * A stored pointer to a folder of files (a DICOM series): a prefix under the
 * run's inputs or under the reference scan. Ends in `/`.
 */
export const storedPrefixSchema = z.string().refine(
  (k) => {
    if (!k.endsWith("/")) return false;
    const path = k.slice(0, -1);
    const inputs = /^runs\/([^/]+)\/inputs\/(.+)$/.exec(path);
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
  { message: "must be a folder under a run's inputs or the reference scan" },
);
