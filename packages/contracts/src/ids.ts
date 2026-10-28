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

/**
 * Run and task ids also hold no '.', so a thread id built as
 * `<runId>.<taskId>.<role>` reads back one way: with a '.' allowed,
 * run `a.b` + task `c` and run `a` + task `b.c` would build the same id. Thread ids
 * are global keys (events, history rows) and URL segments (`/ingest/runs/:runId/threads/:threadId/messages`),
 * and '.' is URL-safe. A root thread's id is `<runId>.<role>`.
 */
const dotFreeSegmentSchema = segmentSchema.refine((s) => !s.includes("."), {
  message: "must not contain '.' (thread ids are '<runId>.<taskId>.<role>')",
});

export const runIdSchema = dotFreeSegmentSchema;
export const inputIdSchema = segmentSchema;
export const taskIdSchema = dotFreeSegmentSchema;
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
