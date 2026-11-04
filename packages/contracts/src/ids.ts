/**
 * The leaf of the contracts: path-segment ids that several contracts share. It imports only
 * zod, so `r2.ts`, `workflow.ts` and the rest can all import it without an
 * import cycle (a cycle crashes any entry point run with `tsx`).
 */
import { z } from "zod";

/** One path segment: non-empty, no `/`, not `.` or `..`. */
export const segmentSchema = z
  .string()
  .min(1)
  .refine((s) => !s.includes("/") && s !== "." && s !== "..", {
    message: "must be one path segment (no '/', '.' or '..')",
  });

/**
 * A run id also holds no '.': the sandbox name is `<runId>.<name>`, which reads back one way
 * only if the id holds none. Runs recorded before opaque thread ids have thread ids `<runId>.<name>`.
 */
const dotFreeSegmentSchema = segmentSchema.refine((s) => !s.includes("."), {
  message: "must not contain '.' (sandbox names are '<runId>.<name>')",
});

export const runIdSchema = dotFreeSegmentSchema;
export const inputIdSchema = segmentSchema;
export const studyIdSchema = segmentSchema;
export const toolCallIdSchema = segmentSchema;

/** A model as the runner names it: `provider/id`, e.g. `meta/muse-spark-1.3`. */
export const modelRefSchema = z
  .string()
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._:@/+-]+$/, "model must be provider/model-id");
