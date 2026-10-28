/**
 * The leaf of the contracts: path-segment ids and the closed vocabularies
 * (task statuses, output kinds) that several contracts share. It imports only
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

export const runIdSchema = segmentSchema;
export const inputIdSchema = segmentSchema;
export const taskIdSchema = segmentSchema;
export const toolCallIdSchema = segmentSchema;

/** Checklist statuses (requirements, Vocabulary). */
export const taskStatusSchema = z.enum([
  "pending",
  "in-progress",
  "done",
  "failed",
  "to-check",
  "under-review",
  "stale",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** The kinds of output a task reports; `output.ts` has the payload of each. */
export const outputKindSchema = z.enum([
  "measurement",
  "score",
  "structure",
  "annotation",
  "volume",
  "file",
]);
export type OutputKind = z.infer<typeof outputKindSchema>;
