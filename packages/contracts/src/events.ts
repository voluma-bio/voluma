/**
 * The run event log: what an agent thread did, in order. The envelope is the
 * same for every kind; `type` selects the payload. The runner appends events
 * (`eventInputSchema`; `id` is chosen by the client so a retried POST is a
 * no-op, and the POST carries the run's lease token, `LEASE_TOKEN_HEADER` in
 * `runner.ts`, whose 409 means the runner stops); the server stamps `seq`,
 * unique and increasing per run, which is also the stream cursor the UI
 * resumes from.
 *
 * Reading back (the runner, to resume a run it claimed):
 *   GET /api/run/ingest/runs/:runId/events?after=<seq>  → 200 `runEventsResponseSchema`
 * with the lease token like every ingest call (`runner.ts`); a stale token is a
 * 409 whose body is `leaseLostSchema`, and the runner stops. It returns the
 * run's events with `seq > after` (0 or absent for all; `seq` starts at 1) in
 * `seq` order, at most 1000; `more` says another page follows, read by passing
 * the last `seq` as `after`. A stored event the runner can't parse fails the
 * resume: skipping it would shift every later `seq`. The runner reads them all before it
 * decides anything, so its view is the stored log.
 *
 * These are the durable events. Live output (text and tool deltas, tool output
 * chunks) is not stored, has no `seq` and is not served yet: see `stream.ts`.
 *
 * Ids that become R2 key segments (`runId`, `taskId`, `toolCallId`, evidence paths) are checked
 * with the `r2.ts` schemas here, so an accepted event can't fail later when a
 * key is built. `compaction` is added when something produces it.
 *
 * `task`, `checkpoint` and `output` are what the run screen and the review are
 * folded from (see below).
 */
import { z } from "zod";
import {
  modelRefSchema,
  runIdSchema,
  taskIdSchema,
  taskStatusSchema,
  toolCallIdSchema,
} from "./ids";
import { evidenceRefSchema, outputReportSchema } from "./output";
import { focusSchema } from "./review";
import { recordedPinSchema, workflowPlanSchema } from "./workflow";

const nonEmpty = z.string().min(1);

/** Bounds on what a `wake` stores, in UTF-16 code units: the notes block goes into every later worker's prompt. */
export const WAKE_NOTE_MAX = 6000;
export const WAKE_ERROR_MAX = 1000;

export const threadKindSchema = z.enum(["supervisor", "worker", "check", "chat"]);
export type ThreadKind = z.infer<typeof threadKindSchema>;

/**
 * Who made a decision: a tool call, a named runtime rule (`task-tools.ts`), or
 * a judgment seam (the experiment's arm name).
 */
export const bySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({
    kind: z.literal("rule"),
    rule: z.enum(["stuck", "stale", "check-start", "check-result"]),
  }),
  z.object({ kind: z.literal("judgment"), arm: nonEmpty }),
]);
export type By = z.infer<typeof bySchema>;

/**
 * THE FOLD is the function `fold` in `fold.ts`: the one spec the run screen,
 * the runtime's per-task record and the review all call. The runtime
 * guarantees the event rules in `task-tools.ts`.
 *
 * Two runtime-owned markers carry the structure; nothing is inferred from the
 * order of status events:
 * - `revision.started` opens a revision at a point in the log. Revision *k* is
 *   the fold of every event before revision *k+1* starts.
 * - `attempt.opened` opens a work attempt on a task. Its id is that event's
 *   id; the runtime stamps it as `attemptId` on the `task`, `checkpoint` and
 *   `output` events that belong to it.
 */

const envelope = {
  /** Chosen by the client; appending the same id twice stores one event. */
  id: nonEmpty,
  runId: runIdSchema,
  threadId: nonEmpty,
  createdAt: z.iso.datetime(),
};

/** The union of all kinds; `extra` adds fields to every envelope. */
const eventUnion = <S extends z.ZodRawShape>(extra: S) => {
  const event = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
    z.object({ ...envelope, ...extra, type: z.literal(type), payload });

  /**
   * A thread has one `thread.started` per invocation: the first run and each
   * resume after a restart. The latest one with no `thread.ended` after it
   * means the thread is running.
   */
  const threadStarted = event(
    "thread.started",
    z
      .object({
        /** Null on a run's root thread. */
        parentThreadId: z.string().nullable(),
        kind: threadKindSchema,
        /** The task a worker or check thread works on; required for those, absent on the supervisor. */
        task: taskIdSchema.optional(),
        /** The attempt a check thread checks; set on check threads only. */
        attemptId: nonEmpty.optional(),
        /** The tool call in the parent thread that started this thread. */
        spawnedBy: nonEmpty.optional(),
        /** The workflow files the run ran, with the commit the runner's checkout was at; required on the root thread, absent on child threads. */
        workflows: z.array(recordedPinSchema).min(1).optional(),
        /**
         * The model this thread calls, as the runner names it: `provider/id`
         * (`meta/muse-spark-1.3`). Worker, check and chat threads call one and
         * should set it. The supervisor thread sets none: the main thread's calls run on
         * it and each `wake` records the model that answered. A thread's model is
         * fixed for its life: every `thread.started` of a thread names the same one, and
         * the harness fails a resume on a different model, as it does for a differing
         * system prompt. Optional in the schema until the harness writes it; then it
         * becomes required on those kinds.
         */
        model: modelRefSchema.optional(),
      })
      .refine((p) => p.parentThreadId !== null || p.workflows !== undefined, {
        path: ["workflows"],
        message: "the root thread records the workflows it ran",
      })
      .refine((p) => p.kind !== "supervisor" || p.model === undefined, {
        path: ["model"],
        message: "the supervisor calls no model",
      })
      .refine(
        (p) =>
          p.kind === "worker" || p.kind === "check"
            ? p.task !== undefined
            : p.kind !== "supervisor" || p.task === undefined,
        {
          path: ["task"],
          message: "task goes with worker and check threads, and not the supervisor",
        },
      ),
  );

  const threadEnded = event(
    "thread.ended",
    z.object({
      status: z.enum(["completed", "failed", "cancelled"]),
      error: z.string().optional(),
    }),
  );

  /**
   * The runner writes one for every assistant reply, including an empty or
   * failed one. A tool call is a separate event; the `message` of a reply that
   * only calls tools has empty text.
   */
  const message = event(
    "message",
    z.discriminatedUnion("role", [
      z.object({
        role: z.literal("user"),
        text: z.string(),
        /**
         * Who sent it: another thread's `thread_message` (`thread-message.ts`),
         * the runtime (the restart note), or a person.
         */
        sender: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("thread"), threadId: nonEmpty }),
          z.object({ kind: z.literal("runtime") }),
          z.object({ kind: z.literal("person") }),
        ]),
      }),
      z.object({ role: z.literal("assistant"), text: z.string() }),
      z.object({ role: z.literal("system"), text: z.string() }),
    ]),
  );

  const toolCall = event(
    "tool.call",
    z.object({ toolCallId: toolCallIdSchema, name: nonEmpty, input: z.unknown() }),
  );

  /**
   * Authoritative end of a tool call. Live output while it ran was never
   * stored (`stream.ts`); this and `toolOutputKey` are the record.
   */
  const toolResult = event(
    "tool.result",
    z.object({
      toolCallId: toolCallIdSchema,
      isError: z.boolean(),
      /** What the model saw: head and tail only when `truncated`. */
      output: z.string(),
      /** When true the full output is at `toolOutputKey(runId, toolCallId)`. */
      truncated: z.boolean(),
    }),
  );

  /**
   * Sandbox lifecycle, written by the runner under the thread whose tool call
   * needed the sandbox. The sandbox is created on first use, once per run.
   */
  const sandbox = event(
    "sandbox",
    z.object({
      name: nonEmpty,
      state: z.enum(["starting", "ready", "stopped", "failed"]),
      detail: z.string().optional(),
    }),
  );

  /**
   * A revision starts: the first at the run's start, then one per correction
   * (`taskId` is the corrected task) and one per fix (`taskId` is the task the
   * check thread is fixing). Written by the runtime before the writes it covers.
   */
  const revisionStarted = event(
    "revision.started",
    z.discriminatedUnion("reason", [
      /** The run's first event; `plan` is the declared outputs of every task, copied from the workflow. */
      z.object({ reason: z.literal("run"), plan: workflowPlanSchema }),
      z.object({ reason: z.literal("correction"), taskId: taskIdSchema }),
      z.object({ reason: z.literal("fix"), taskId: taskIdSchema }),
    ]),
  );

  /** A work attempt opens on a task: its first write, or a redo after a stale mark or a failure. */
  const attemptOpened = event("attempt.opened", z.object({ taskId: taskIdSchema }));

  /**
   * A checklist task changed status. Written when a `checklist` tool call
   * succeeds (`by` agent) or by the runtime's own code (`by` rule or judgment);
   * the envelope `threadId` is the thread whose tool or wake produced it.
   */
  const task = event(
    "task",
    z.object({
      taskId: taskIdSchema,
      /** Runtime-stamped: the attempt this belongs to. */
      attemptId: nonEmpty,
      status: taskStatusSchema,
      /** One plain-language line: why, shown beside the state. */
      reason: nonEmpty,
      by: bySchema,
    }),
  );

  /**
   * A milestone under a task, in the mockup's progress-line style, from a
   * worker or check thread's `checkpoint` tool.
   */
  const checkpoint = event(
    "checkpoint",
    z.object({
      taskId: taskIdSchema,
      attemptId: nonEmpty,
      text: nonEmpty,
      by: bySchema,
      evidence: z.array(evidenceRefSchema),
      /** The check thread's verdict line; only check threads may set it. */
      verdict: z.enum(["passed", "needs-review"]).optional(),
      /** Raises a To check item: `text` is its detail; the fold resolves `focus` ids (`fold.ts`). */
      toCheck: z.object({ title: nonEmpty, focus: focusSchema.optional() }).optional(),
    }),
  );

  /**
   * A result from `report_output` (`output.ts`). A new attempt reports the same
   * `outputId` again; within an attempt the latest wins, a check thread's fix
   * included.
   */
  const output = event(
    "output",
    outputReportSchema.extend({ taskId: taskIdSchema, attemptId: nonEmpty }),
  );

  /**
   * One judgment point and what came of it, written by the runtime so the
   * judgment experiment's data comes from the record. `point` is what the arm
   * was given; `decision` is its raw answer (absent when it threw); `applied`
   * is the action the runtime took, which differs from `decision` on a
   * fallback. `fold` ignores it for results.
   */
  const judgment = event(
    "judgment",
    z.object({
      point: z.object({ kind: nonEmpty, input: z.unknown() }),
      arm: nonEmpty,
      taskId: taskIdSchema.optional(),
      decision: z.unknown().optional(),
      applied: z.object({
        action: nonEmpty,
        /** Why `applied` is not `decision`: the arm threw (taken as accept), or the redo cap was reached. */
        fallback: z.enum(["error", "redo-cap"]).optional(),
      }),
    }),
  );

  /**
   * One wake of the run's main thread: what it was told (`point`), what it answered, and
   * which model (`provider/id`). Written before the runtime applies the answer, so a resumed
   * run applies this and does not ask again. The main thread runs on the root thread, which
   * has no `model` on `thread.started`: each wake names the model that answered, and a
   * resume may run on another one (the thread's context is rebuilt from the recorded
   * answers, not from a provider-side session).
   *
   * Points: `run-started` (the run's first wake: the main thread may adapt the computed plan;
   * `plan` is the plan it chose, absent when it kept the computed one, and
   * `revision.started.plan` stays the record of what was applied), `task-checked` (a task's
   * check passed), and the judgment points `check-disagreed` and `thread-failed`, which
   * need a `decision`; a `judgment` event records what was applied. `note` is the whole
   * notes block in force from here on (absent: unchanged), at most `WAKE_NOTE_MAX` UTF-16
   * code units; the supervisor passes it into later workers' and checkers' prompts. `error`
   * (the writer truncates it to `WAKE_ERROR_MAX`): the model did not answer, so there is no
   * note, decision or plan. `fold` ignores it.
   */
  const wakePoint = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("run-started"), input: z.unknown() }),
    z.object({ kind: z.literal("task-checked"), taskId: taskIdSchema, input: z.unknown() }),
    z.object({ kind: z.literal("check-disagreed"), taskId: taskIdSchema, input: z.unknown() }),
    z.object({ kind: z.literal("thread-failed"), taskId: taskIdSchema, input: z.unknown() }),
  ]);
  const wake = event(
    "wake",
    z
      .object({
        point: wakePoint,
        model: modelRefSchema,
        note: z.string().max(WAKE_NOTE_MAX).optional(),
        decision: z
          .object({ action: z.enum(["accept", "redo", "fail"]), reason: nonEmpty })
          .optional(),
        plan: workflowPlanSchema.optional(),
        error: z.string().max(WAKE_ERROR_MAX).optional(),
      })
      .superRefine((p, ctx) => {
        const judged = p.point.kind === "check-disagreed" || p.point.kind === "thread-failed";
        const issue = (message: string) => ctx.addIssue({ code: "custom", message });
        if (p.error !== undefined) {
          if (p.note !== undefined || p.decision !== undefined || p.plan !== undefined) {
            issue("a wake the model did not answer has no note, decision or plan");
          }
        } else if (judged !== (p.decision !== undefined)) {
          issue("a decision goes with, and only with, a judgment point the model answered");
        }
        if (p.plan !== undefined && p.point.kind !== "run-started") {
          issue("only the run-started wake carries a plan");
        }
      }),
  );

  return z.discriminatedUnion("type", [
    threadStarted,
    threadEnded,
    message,
    toolCall,
    toolResult,
    sandbox,
    revisionStarted,
    attemptOpened,
    task,
    checkpoint,
    output,
    judgment,
    wake,
  ]);
};

/** What a client appends: an event without `seq`. */
export const eventInputSchema = eventUnion({});
export type EventInput = z.infer<typeof eventInputSchema>;

/** A stored event, with its server-assigned `seq`. */
export const runEventSchema = eventUnion({ seq: z.number().int().nonnegative() });
export type RunEvent = z.infer<typeof runEventSchema>;
export type EventType = RunEvent["type"];

/** A page of a run's stored events, oldest first. */
export const runEventsResponseSchema = z.object({
  events: z.array(runEventSchema),
  more: z.boolean(),
});
export type RunEventsResponse = z.infer<typeof runEventsResponseSchema>;
