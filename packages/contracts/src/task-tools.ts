/**
 * The tools that write `task`, `checkpoint` and `value` events (`events.ts`,
 * which also holds the fold the run screen and review read them by). The fold
 * relies on the rules below; the runtime enforces them, these schemas only
 * shape the call.
 *
 * Who sets what. `checklist` and `report_value` are the worker's (the
 * supervisor's own checklist calls use `checklist` too); `checkpoint` is the
 * worker's and a check thread's. A worker sets only `in-progress`, `done`,
 * `failed` and `to-check`; `under-review` and `stale` are the supervisor's or
 * the runtime's. Only a check thread sets `verdict`. Nobody but the check
 * thread writes to a task under review.
 *
 * Attempts belong to the runtime, as `task` events with `by` rule:
 * - `in-progress` on a task already in progress appends nothing.
 * - A `checkpoint` or `value` on a task that is neither in progress nor under
 *   review first appends `task in-progress` (`attempt-open`).
 * - A check thread's first `value` on a task appends `task under-review` (`fix`)
 *   unless the task's latest event already is one. That opens a fix attempt, so
 *   the worker's result stays in its own revision.
 * - When a check thread ends, the runtime sets the task's status (`check-result`):
 *   `passed` → `done`; `needs-review` → `to-check`; no verdict → `to-check`
 *   with a reason. A check that disagrees is a judgment point (`judgment` by).
 *
 * Evidence is named by `{root, path}` (`evidenceRefSchema`). On success the
 * runtime copies each file to its `evidenceKey` and appends the event with the
 * sha256; a missing file fails the call and appends nothing. The runtime scopes
 * paths to this run; `outputs` paths are under the call's `taskId`.
 *
 * Crashes. The id of the event a tool appends is its `toolCallId`, and of an
 * attempt-opening event it appends first, `${toolCallId}:open`, so a resume
 * finds them and answers the call with success. A tool succeeds only after its
 * append is acknowledged; these events never use the fire-and-forget path.
 *
 * Results reach the record as `tool.result.output`, the object as JSON.
 */
import { z } from "zod";
import { taskStatusSchema } from "./events";
import { relativePathSchema, taskIdSchema } from "./r2";

const nonEmpty = z.string().min(1);

const evidencePaths = z
  .array(
    z.object({
      root: z
        .enum(["outputs", "scratch"])
        .default("outputs")
        .describe("`outputs` is this task's output folder; `scratch` is the run's scratch."),
      path: relativePathSchema,
    }),
  )
  .describe("Files the line rests on.");

/** Every tool answers the same way: a short line, and the id of the event it wrote. */
export const taskToolResultSchema = z.object({
  message: nonEmpty,
  /** Absent when nothing was appended (`in-progress` on a task already in progress). */
  eventId: nonEmpty.optional(),
});
export type TaskToolResult = z.infer<typeof taskToolResultSchema>;

export const checklistInputSchema = z.object({
  taskId: taskIdSchema,
  status: taskStatusSchema,
  reason: nonEmpty.describe("One plain-language line: why the task is in this state."),
});
export type ChecklistInput = z.infer<typeof checklistInputSchema>;

export const checkpointInputSchema = z.object({
  taskId: taskIdSchema,
  text: nonEmpty.describe(
    "A milestone in plain language, e.g. 'Width on the plane square to the shaft: 3.39 mm.'",
  ),
  evidence: evidencePaths,
  verdict: z
    .enum(["passed", "needs-review"])
    .optional()
    .describe("Check threads only: your verdict on the task. Put it on one line."),
  toCheck: z
    .object({ title: nonEmpty.describe("What the reviewer should look at, in a few words.") })
    .optional()
    .describe("Set when you are unsure of something; `text` explains it. The run doesn't stop."),
});
export type CheckpointInput = z.infer<typeof checkpointInputSchema>;

export const reportValueInputSchema = z.object({
  taskId: taskIdSchema,
  measurementId: nonEmpty.describe(
    "Stable name for this quantity; reuse it when you redo the task.",
  ),
  title: nonEmpty,
  value: z
    .number()
    .finite()
    .nullable()
    .describe("Null if it could not be computed; explain in note."),
  unit: nonEmpty.describe("`mm`, `mm^3`, `1/mm`; `1` for a ratio or a count."),
  confidence: z.enum(["provisional", "candidate"]).nullable(),
  note: z.string().optional(),
  definition: z.string().optional(),
  evidence: evidencePaths,
  structureIds: z
    .array(nonEmpty)
    .default([])
    .describe("Structures it was counted from or drawn on."),
  annotationIds: z.array(nonEmpty).default([]).describe("Annotations that show it."),
  numeratorId: nonEmpty
    .optional()
    .describe(
      "Ratios: a `measurementId` you reported for this task, or `taskId/measurementId`. Report the operands first.",
    ),
  denominatorId: nonEmpty.optional().describe("Like `numeratorId`."),
});
export type ReportValueInput = z.infer<typeof reportValueInputSchema>;
