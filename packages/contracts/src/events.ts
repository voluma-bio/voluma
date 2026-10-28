/**
 * The run event log: what an agent thread did, in order. The envelope is the
 * same for every kind; `type` selects the payload. The runner appends events
 * (`eventInputSchema`; `id` is chosen by the client so a retried POST is a
 * no-op); the server stamps `seq`, unique and increasing per run, which is
 * also the stream cursor the UI resumes from.
 *
 * These are the durable events. Live output (text and tool deltas, tool output
 * chunks) is not stored and has no `seq`: see `stream.ts`.
 *
 * Ids that become R2 key segments (`runId`, `taskId`, `toolCallId`, evidence paths) are checked
 * with the `r2.ts` schemas here, so an accepted event can't fail later when a
 * key is built. `compaction` is added when something produces it.
 *
 * `task`, `checkpoint` and `output` are what the run screen and the review are
 * folded from (see below).
 */
import { z } from "zod";
import { runIdSchema, taskIdSchema, taskStatusSchema, toolCallIdSchema } from "./ids";
import { evidenceRefSchema, outputReportSchema } from "./output";
import { focusSchema } from "./review";
import { workflowPinSchema, workflowPlanSchema } from "./workflow";

const nonEmpty = z.string().min(1);

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
    z.object({
      /** Null on a run's root thread. */
      parentThreadId: z.string().nullable(),
      kind: threadKindSchema,
      task: taskIdSchema.optional(),
      /** The attempt a check thread checks; set on check threads only. */
      attemptId: nonEmpty.optional(),
      /** The tool call in the parent thread that started this thread. */
      spawnedBy: nonEmpty.optional(),
      /** Workflow packages the run is pinned to; set on the root thread only. */
      workflows: z.array(workflowPinSchema).optional(),
    }),
  );

  const threadEnded = event(
    "thread.ended",
    z.object({
      status: z.enum(["completed", "failed", "cancelled"]),
      error: z.string().optional(),
      /**
       * The reply that was streaming when the invocation was cut off, if its
       * `message` was never written. It ends that reply's live partial
       * (`stream.ts`), so every clearing rule stays keyed by an id.
       */
      messageId: nonEmpty.optional(),
    }),
  );

  /**
   * Replaces the live partial text whose `messageId` equals this event's `id`
   * (`stream.ts`). The runner writes one for every assistant reply that
   * streamed, including an empty or failed one. A tool call is a separate
   * event; the `message` of a reply that only calls tools has empty text.
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
  ]);
};

/** What a client appends: an event without `seq`. */
export const eventInputSchema = eventUnion({});
export type EventInput = z.infer<typeof eventInputSchema>;

/** A stored event, with its server-assigned `seq`. */
export const runEventSchema = eventUnion({ seq: z.number().int().nonnegative() });
export type RunEvent = z.infer<typeof runEventSchema>;
export type EventType = RunEvent["type"];
