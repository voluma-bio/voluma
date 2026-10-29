/**
 * The tools that write `task`, `checkpoint` and `output` events (`events.ts`),
 * and the rules the runtime enforces when they run. `fold` (`fold.ts`) relies
 * on these; the schemas below only shape the calls.
 *
 * Who sets what. `checklist` and `report_output` are the worker's; `checkpoint` is the
 * worker's and a check thread's. A worker sets only `in-progress`, `done`,
 * `failed` and `to-check`; `under-review` is the runtime's, `stale` the
 * runtime's and the supervisor's, and `to-check` also the supervisor's. Only a
 * check thread sets `verdict`. Only a worker thread opens an attempt: a
 * supervisor's `checklist` call that would need a new attempt is refused.
 *
 * Write scope. A thread whose `thread.started` names a `task` (worker and
 * check threads) writes only to that task; a write to another is refused. The
 * supervisor names none and writes to any task, through `checklist`.
 *
 * Decisions. The runtime decides from `fold` of the log (`fold.ts`), refolded
 * for each decision; it keeps no second record. It takes each decision and its
 * appends inside one per-run critical section, whichever thread asks, so a
 * decision sees every earlier task write of the run. Task tools, check-start,
 * check-result, the stuck guard and corrections all take it.
 *
 * Attempts. The runtime writes `attempt.opened` and stamps `attemptId` on every
 * `task`, `checkpoint` and `output` event, from the task's latest attempt. An
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
 * the thread runs. The check thread's checkpoints join that attempt,
 * and it writes only to the task it checks (a write to another task is
 * refused). Its only task tool is `checkpoint`: it neither changes outputs
 * nor sets task status. Re-derived values go in its checkpoint text next to
 * the worker's values and its verdict.
 * - A check never clears an open To check item. When the check thread ends the
 *   runtime sets the status (`check-result`) to `checkResult(task)` (`fold.ts`)
 *   with a reason, but only if the task is still under review: `done` only for
 *   a `passed` verdict with no open item (a worker's doubt, a `toCheck`
 *   checkpoint) and no required output missing, otherwise `to-check`.
 *
 * Staleness. A correction is one `checklist stale` call by the supervisor on
 * the corrected task, which has an attempt. The runtime appends
 * `revision.started` (`correction`), the call's own stale event, and a stale
 * mark (`stale`) on each transitive dependent in the plan's
 * `dependsOn` graph (`workflow.ts`, read from `revision.started`) that has an attempt and isn't stale already. A stale mark on a task under review stops its check
 * thread, so no `check-result` follows. When a worker thread ends with tasks
 * still in progress, the stuck guard marks each `to-check` (`stuck`).
 *
 * Run start. The first event of a run is `revision.started` (`run`), carrying
 * the plan: every task's declared outputs (`workflowPlanSchema`), copied from
 * the workflow. The runtime reads the plan back from the log by `fold`, not from
 * the workflow, so a resume sees the plan the run began with.
 *
 * Declared outputs. `report_output` checks the call against the plan's
 * declaration for that `taskId` and `outputId`, and refuses a mismatch with the
 * declaration quoted:
 * - the `kind` equals the declared kind;
 * - a measurement's `unit` equals the declared unit;
 * - a score's `level` is one of the declared `levels`;
 * - a structure's `label` and its `title` equal the declared `label` and
 *   `name`, where set;
 * - an annotation's shape equals the declared `shape`;
 * - a volume's `kind` equals the declared `volumeKind`;
 * - a file's `mediaType` equals the declared one.
 * An output the plan doesn't declare is accepted if its kind's payload is valid;
 * the fold lists it as undeclared. A score without a declaration has no scale.
 * A required declared output the attempt hasn't reported keeps the task from
 * `done`: the worker's `checklist done` is refused, naming the missing outputs
 * (`missingRequired`, structures included). It may still set `to-check` or
 * `failed`. `checkResult` checks it too, so a check never makes a task `done`
 * while a required output is missing, whatever else changed. A required output
 * reported with `value: null` (a measurement that could not be made) counts as
 * reported: the task did its job and said so, and the `note` says why. The
 * reviewer sees the null and the note; making the task fail is the worker's
 * choice, with `failed`.
 *
 * References. `report_output` refuses a reference its target hasn't reported in
 * the named task's latest attempt: a measurement's `numeratorId` and
 * `denominatorId` (measurements), `structureIds` of a measurement or score
 * (structures), `annotationIds` (annotations), a structure's `volume` (a
 * `volume` output of kind `labels`) and an annotation's `volume` (any `volume`
 * output; absent means the scan). A volume's `dtype` must fit its kind
 * (`uint8`/`uint16` for `labels`, `int16`/`uint16`/`float32` for `image`). This
 * is a write-time check only: a later attempt of another task may stop
 * reporting a target, and the fold's resolver (`fold.ts`) alone guarantees that
 * the review has no dangling reference.
 *
 * Evidence, and the files inside an output (a mesh, a volume's voxels, a
 * file output), are named by `{root, path}` (`evidenceRefSchema`). On success
 * the runtime copies each file to its `evidenceKey` and appends the event with
 * the sha256; a missing file fails the call and appends nothing. The runtime scopes
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
import { taskIdSchema } from "./ids";
import { fileRefInputSchema, outputReportInputSchema } from "./output";
import { focusSchema } from "./review";

const nonEmpty = z.string().min(1);

const evidencePaths = z.array(fileRefInputSchema).describe("Files the line rests on.");

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
    .object({
      title: nonEmpty.describe("What the reviewer should look at, in a few words."),
      focus: focusSchema
        .optional()
        .describe(
          "What to outline for the reviewer; absent means the whole task. Ids are output ids (`taskId/outputId`, or this task's `outputId`); `volumeId` is a labels volume output, `label` one region of it. `box` and `point` are voxel indices [z, y, x] on the scan's grid.",
        ),
    })
    .optional()
    .describe("Set when you are unsure of something; `text` explains it. The run doesn't stop."),
});
export type CheckpointInput = z.infer<typeof checkpointInputSchema>;

export const reportOutputInputSchema = outputReportInputSchema.extend({ taskId: taskIdSchema });
export type ReportOutputInput = z.infer<typeof reportOutputInputSchema>;
