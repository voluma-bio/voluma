/**
 * The tools that write `task`, `checkpoint` and `output` events (`events.ts`),
 * and the rules the runtime enforces when they run. `fold` (`fold.ts`) relies
 * on these; the schemas below only shape the calls.
 *
 * Who writes. A task is held while it is `in-progress` or `under-review`, by the thread that
 * opened the current attempt (the holder: a worker, or the main agent doing the task itself).
 * `checkpoint` and `report_output` are the holder's; a check thread also writes `checkpoint`
 * on its task. `submit_task` (holder) sets `under-review`; the runtime's own rules set `done`,
 * `to-check`, `stale` and `pending` (`by` rule), and the main agent's `accept`, `stop_worker`
 * and `change_plan` set `to-check`, `pending` and skips. A thread whose `thread.started` names
 * a `task` (worker and check threads) writes only to that task.
 *
 * Decisions. The runtime decides from `fold` of the log (`fold.ts`), refolded for each
 * decision; it keeps no second record. Each decision and its appends run inside one per-run
 * critical section, so a decision sees every earlier task write of the run.
 *
 * Attempts. The runtime writes `attempt.opened` and stamps `attemptId` on every `task`,
 * `checkpoint` and `output` event, from the task's latest attempt. An attempt's status is its
 * latest stamped `task` event, otherwise `in-progress`. A task with no attempt is `pending`;
 * the first write by an eligible writer opens one. The runtime rebuilds its per-task record
 * by `fold` on a resume.
 *
 * Checks. The runtime starts a check thread on every `under-review` task. Its
 * `thread.started` carries the attempt it checks, and its checkpoints join that attempt. Its
 * tools are `checkpoint` and `ask`; it neither changes outputs nor sets task status.
 * - A check never clears an open To check item. When the check thread ends, the runtime
 *   sets the status (`check-result`) to `checkResult(task)` (`fold.ts`) with a reason, but
 *   only if the task is still under review: `done` only for a `passed` verdict with no
 *   open item (a worker's doubt, a `toCheck` checkpoint) and no required output missing,
 *   otherwise `to-check`.
 *
 * Staleness. A redo of a task that has attempted dependents appends `revision.started`
 * (`correction`) and a stale mark (`stale`) on each transitive dependent in the plan's
 * `dependsOn` graph that has an attempt and isn't stale already. A stale mark on a task
 * under review stops its check thread, so no `check-result` follows.
 *
 * Run start. The first event of a run is `revision.started` (`run`), carrying
 * the plan: every task's declared outputs (`workflowPlanSchema`), copied from
 * the workflow. `plan.changed` events adjust it; `fold` applies them in order.
 *
 * Declared outputs. `report_output` checks the call against the plan's
 * declaration for that `taskId` and `outputId`, and refuses a mismatch with the
 * declaration quoted:
 * - the `kind` equals the declared kind;
 * - a measurement's `unit` equals the declared unit;
 * - a score's `level` is one of the declared `levels`;
 * - a structure reports its declared `label` (or a mask when none is declared), and its
 *   `title` equals the declared `name`, where set;
 * - an annotation's shape equals the declared `shape`;
 * - a volume's `kind` equals the declared `volumeKind`;
 * - a file's `mediaType` equals the declared one.
 * A measurement, score or file the plan doesn't declare is accepted if its payload is valid;
 * the fold lists it as undeclared. A score without a declaration has no scale.
 * A required declared output the attempt hasn't reported keeps the task from
 * `done`: `submit_task` is refused, naming the missing outputs
 * (`missingRequired`; only measurements, scores and files are ever required). `checkResult` checks it too, so a check never makes a task `done`
 * while a required output is missing, whatever else changed. A required output
 * reported with `value: null` (a measurement that could not be made) counts as
 * reported: the task did its job and said so, and the `note` says why. The
 * reviewer sees the null and the note; making the task fail is the worker's
 * choice, with `failed`. `submit_task` is also refused while a declared output the task's
 * previous checked attempt reported is not reported again in this one (a `missing` report counts):
 * a redo cannot silently drop an output.
 *
 * Declarations and references. An object (structure, surface, annotation, volume) the plan
 * doesn't declare is refused: review places it by its declaration's grid. A structure, surface
 * or annotation is refused until its declared grid is reported in the latest attempt of the
 * grid's task, and a line annotation and the length measurement that names it (the one
 * measurement in mm whose `on` holds exactly that line) are checked against each other, by
 * the second of the pair to arrive (`rulerLengthProblem`). A ratio's `numeratorId` and
 * `denominatorId` must be measurements already reported. A volume's `dtype` must fit its kind
 * (`uint8`/`uint16` for `labels`, `int16`/`uint16`/`float32` for `image`). These are
 * write-time checks only: a later attempt of another task may stop reporting a target, and
 * the fold's resolvers (`fold.ts`) alone guarantee that the review has no dangling reference.
 *
 * Evidence, and the files inside an output (a structure's mask, a surface's heights, a
 * volume's voxels, a file output), are named by `{root, path}` (`evidenceRefSchema`). On success
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

export const checkpointInputSchema = z.object({
  taskId: taskIdSchema,
  text: nonEmpty.describe(
    "A milestone in plain language, e.g. 'Width on the plane square to the shaft: 3.39 mm.'",
  ),
  summary: nonEmpty.describe(
    "One or two plain sentences for the researcher: what this milestone shows, without file names or working detail.",
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

/**
 * `submit_task`: the holder hands its task to the check. Every required output must be reported
 * (a `missing` one with its reason counts), and so must every declared output the previous checked
 * attempt reported. It ends the thread's turn; call it alone.
 */
export const submitTaskInputSchema = z.object({
  taskId: taskIdSchema,
  summary: nonEmpty.describe("One or two plain sentences for the researcher: what the task found."),
});
export type SubmitTaskInput = z.infer<typeof submitTaskInputSchema>;

/** `ask`: a check thread's question to the main agent (at most 3 per check). It ends the turn; call it alone. */
export const askInputSchema = z.object({
  question: nonEmpty.describe("What you need to know to decide your verdict."),
});
export type AskInput = z.infer<typeof askInputSchema>;
