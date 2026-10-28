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
 * `task`, `checkpoint` and `value` are what the run screen and the review are
 * folded from (see below).
 */
import { z } from "zod";
import {
  relativePathSchema,
  runIdSchema,
  segmentSchema,
  sha256Schema,
  taskIdSchema,
  toolCallIdSchema,
} from "./r2";
import { workflowPinSchema } from "./workflow";

const nonEmpty = z.string().min(1);

export const threadKindSchema = z.enum(["supervisor", "worker", "check", "chat"]);
export type ThreadKind = z.infer<typeof threadKindSchema>;

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
 * A file the agent named, as recorded: copied to `evidenceKey(runId, sha256)`
 * before the event is appended, so a rerun can't erase it. `path` is under
 * `root`: `outputs` is the task's output folder (`outputKey`), `scratch` the
 * run's scratch (`scratchKey`), where a check thread keeps its reproductions.
 * The runtime scopes every path to this run.
 */
export const evidenceRefSchema = z.object({
  root: z.enum(["outputs", "scratch"]),
  path: relativePathSchema,
  sha256: sha256Schema,
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

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
 *   `value` events that belong to it.
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
      z.object({ reason: z.literal("run") }),
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
      /** Raises a To check item: `text` is its detail. */
      toCheck: z.object({ title: nonEmpty }).optional(),
    }),
  );

  /**
   * A measurement from `report_value`. A new attempt reports the same
   * `measurementId` again; within an attempt the latest wins, a check thread's
   * fix included.
   */
  const value = event(
    "value",
    z.object({
      taskId: taskIdSchema,
      attemptId: nonEmpty,
      /** Stable across reruns of the task: the agent's name for the quantity, e.g. `femur-width`. One segment, so `taskId/measurementId` is unambiguous. */
      measurementId: segmentSchema,
      title: nonEmpty,
      /** Null when it could not be computed; say why in `note`. */
      value: z.number().finite().nullable(),
      unit: nonEmpty,
      confidence: z.enum(["provisional", "candidate"]).nullable(),
      note: z.string().optional(),
      definition: z.string().optional(),
      evidence: z.array(evidenceRefSchema),
      structureIds: z.array(nonEmpty),
      annotationIds: z.array(nonEmpty),
      /** Ratios: a same-task `measurementId` or `taskId/measurementId`. */
      numeratorId: nonEmpty.optional(),
      denominatorId: nonEmpty.optional(),
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
    value,
  ]);
};

/** What a client appends: an event without `seq`. */
export const eventInputSchema = eventUnion({});
export type EventInput = z.infer<typeof eventInputSchema>;

/** A stored event, with its server-assigned `seq`. */
export const runEventSchema = eventUnion({ seq: z.number().int().nonnegative() });
export type RunEvent = z.infer<typeof runEventSchema>;
export type EventType = RunEvent["type"];
