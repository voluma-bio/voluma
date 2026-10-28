/**
 * The tools that write `task`, `checkpoint` and `value` events (`events.ts`),
 * and the rules the runtime enforces when they run. `fold` (`fold.ts`) relies
 * on these; the schemas below only shape the calls.
 *
 * Who sets what. `checklist` and `report_value` are the worker's (the
 * supervisor's own checklist calls use `checklist` too); `checkpoint` is the
 * worker's and a check thread's. A worker sets only `in-progress`, `done`,
 * `failed` and `to-check`; `under-review` is the runtime's, `stale` the
 * runtime's and the supervisor's, and `to-check` also the supervisor's. Only a
 * check thread sets `verdict`. Only a worker thread opens an attempt: a
 * supervisor's `checklist` call that would need a new attempt is refused.
 *
 * Decisions. The runtime decides from `fold` of the log (`fold.ts`), refolded
 * for each decision; it keeps no second record. It takes each decision and its
 * appends inside one per-run critical section, whichever thread asks, so a
 * decision sees every earlier task write of the run. Task tools, check-start,
 * check-result, the stuck guard and corrections all take it.
 *
 * Attempts. The runtime writes `attempt.opened` and stamps `attemptId` on every
 * `task`, `checkpoint` and `value` event, from the task's latest attempt. An
 * attempt's status is its latest stamped `task` event, otherwise `in-progress`.
 * The runtime rebuilds its per-task record by `fold` on a resume.
 * - A task with no attempt is `pending`. An attempt opens automatically only on
 *   the first write to a `pending` task.
 * - A write to a `stale` or `failed` task is refused with the reason and "call
 *   `checklist in-progress` to redo it"; that call opens the new attempt.
 * - A worker's `in-progress` on its own `done` or `to-check` task is refused. A
 *   redo goes through a stale mark. `in-progress` on a task already in progress
 *   appends nothing.
 * - Other writes to an `in-progress`, `done` or `to-check` task stay in its
 *   attempt. Nobody but the check thread writes to a task under review.
 *
 * Checks. The runtime starts a check thread only on a `done` or `to-check`
 * task. Its `thread.started` carries the attempt it checks, and the runtime
 * appends `task under-review` (`check-start`) with the same `attemptId` before
 * the thread runs. The check thread's events join that attempt,
 * and it writes only to the task it checks (a write to another task is
 * refused).
 * - A check thread's first `value` is a fix of the task it checks: the
 *   runtime appends `revision.started` (`fix`, with that `taskId`), then a
 *   stale mark (`stale`) on each transitive dependent of the task that has an
 *   attempt and isn't stale already, then the value. Later values add nothing.
 * - A check never clears an open To check item. When the check thread ends the
 *   runtime sets the status (`check-result`) to `checkResult(task)` (`fold.ts`)
 *   with a reason, but only if the task is still under review: `done` only for
 *   a `passed` verdict with no open item (a worker's doubt, a `toCheck`
 *   checkpoint, a fix), otherwise `to-check`.
 *
 * Staleness. A correction is one `checklist stale` call by the supervisor on
 * the corrected task, which has an attempt. The runtime appends
 * `revision.started` (`correction`), the call's own stale event, and a stale
 * mark (`stale`) on each transitive dependent in the workflow's
 * graph that has an attempt and isn't stale already. A stale mark on a task under review stops its check
 * thread, so no `check-result` follows. When a worker thread ends with tasks
 * still in progress, the stuck guard marks each `to-check` (`stuck`).
 *
 * Run start. The first event of a run is `revision.started` (`run`).
 *
 * Operands. `report_value` refuses a `numeratorId` or `denominatorId` the named
 * task's latest attempt hasn't reported. A later attempt may stop reporting it;
 * the fold drops such an operand.
 *
 * Evidence is named by `{root, path}` (`evidenceRefSchema`). On success the
 * runtime copies each file to its `evidenceKey` and appends the event with the
 * sha256; a missing file fails the call and appends nothing. The runtime scopes
 * paths to this run; `outputs` paths are under the call's `taskId`.
 *
 * Ids and crashes. Every event id has its thread as a prefix. A tool's event
 * is `${threadId}:${toolCallId}`; the runtime's other events derive theirs from
 * their trigger, so a resume never appends one twice:
 * - `attempt.opened`: `${threadId}:${toolCallId}:open`
 * - `revision.started`: `${threadId}:${toolCallId}:revision` (a run's first:
 *   `${rootThreadId}:revision`), and its stale marks `…:stale:${taskId}`
 * - `check-start`: `${checkThreadId}:start`; `check-result`: `${checkThreadId}:result`
 * - stuck guard: `${workerThreadId}:stuck:${taskId}`
 *
 * The three task tools run with `executionMode: "sequential"` within a
 * thread, and a tool succeeds only after its appends are acknowledged. A crash between an
 * `attempt.opened` and the tool's own event leaves an `in-progress` attempt;
 * the interrupted call is answered with an error and the model's retry lands in
 * it.
 *
 * Results reach the record as `tool.result.output`, the object as JSON.
 */
import { z } from "zod";
import { relativePathSchema, segmentSchema, taskIdSchema } from "./r2";

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
  // The statuses a caller may set; who may set which is in the rules above.
  status: z.enum(["in-progress", "done", "failed", "to-check", "stale"]),
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
  measurementId: segmentSchema.describe(
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
