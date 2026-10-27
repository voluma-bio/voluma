/**
 * The one place R2 key layout is written. Every reader and writer of the
 * bucket (sandbox mounts, tool-output spill, importers) builds keys here.
 * Prefixes end in `/` so they can be used directly as mount prefixes.
 */
import { z } from "zod";

/** One path segment: non-empty, no `/`, not `.` or `..`. */
export const segmentSchema = z
  .string()
  .min(1)
  .refine((s) => !s.includes("/") && s !== "." && s !== "..", {
    message: "must be one path segment (no '/', '.' or '..')",
  });

export const runIdSchema = segmentSchema;
export const taskSchema = segmentSchema;
export const toolCallIdSchema = segmentSchema;

/** A relative path under a prefix; every segment is validated. */
export const relativePathSchema = z
  .string()
  .min(1)
  .refine((p) => p.split("/").every((s) => segmentSchema.safeParse(s).success), {
    message: "must be a relative path of valid segments",
  });

/** A workflow package pinned to a commit. */
export const workflowPinSchema = z.object({
  /** GitHub `owner/name`. */
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/),
});
export type WorkflowPin = z.infer<typeof workflowPinSchema>;

const seg = (s: string) => segmentSchema.parse(s);
const rel = (p: string | undefined) => (p === undefined ? "" : relativePathSchema.parse(p));

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

/** Reference data for the OA6-1RK sample: the raw scan and the reference run. */
export const referencePrefix = (part: "scan" | "run") => {
  if (part !== "scan" && part !== "run") throw new Error(`unknown reference part: ${part}`);
  return `reference/OA6-1RK/${part}/`;
};
export const referenceKey = (part: "scan" | "run", path: string) =>
  `${referencePrefix(part)}${rel(path)}`;
