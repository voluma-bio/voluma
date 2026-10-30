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
export const studyIdSchema = segmentSchema;
/** `main` and `supervisor` are thread roles in ids (`<runId>.main`, `<runId>.supervisor`), so no task takes them. */
export const taskIdSchema = dotFreeSegmentSchema.refine((s) => s !== "main" && s !== "supervisor", {
  message: "'main' and 'supervisor' are reserved",
});
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

/**
 * Where a task stands as every screen shows it (`taskStates`, review-state.ts): its status,
 * read with the run's state, its threads and the tasks it builds on.
 * - `waiting`: not started, and a task it builds on has no usable result yet.
 * - `ready`: not started, and every task it builds on has one (`satisfied`).
 * - `running`: an AI is working on it now. `checking`: a second AI is checking it now.
 * - `held`: started, and no AI is working on it or checking it: the lead AI decides what's next.
 * - `skipped`: skipped by the plan, or builds on a skipped task.
 * - `failed`: failed, or its AI failed on the error that failed the run.
 * - `stopped`, `paused`: started when the run ended, or while it waits for a runner or keys.
 */
export const taskStateSchema = z.enum([
  "waiting",
  "ready",
  "running",
  "checking",
  "held",
  "done",
  "to-check",
  "skipped",
  "failed",
  "stopped",
  "paused",
]);
export type TaskState = z.infer<typeof taskStateSchema>;

/** The kinds of output a task reports; `output.ts` has the payload of each. */
export const outputKindSchema = z.enum([
  "measurement",
  "score",
  "structure",
  "surface",
  "annotation",
  "volume",
  "file",
]);
export type OutputKind = z.infer<typeof outputKindSchema>;

/** The kinds review places in a view (blocks a measurement is shown on); the rest are values and files. */
export const isObjectKind = (kind: OutputKind) =>
  kind === "volume" || kind === "structure" || kind === "surface" || kind === "annotation";

/** A model as the runner names it: `provider/id`, e.g. `meta/muse-spark-1.3`. */
export const modelRefSchema = z
  .string()
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._:@/+-]+$/, "model must be provider/model-id");
