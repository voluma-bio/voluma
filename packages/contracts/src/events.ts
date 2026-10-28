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
 * Ids that become R2 key segments (`runId`, `task`, `toolCallId`, evidence paths) are checked
 * with the `r2.ts` schemas here, so an accepted event can't fail later when a
 * key is built. `compaction` is added when something produces it.
 *
 * `task`, `checkpoint` and `value` are what the run screen and the review are
 * folded from; the fold is specified below.
 */
import { z } from "zod";
import {
  relativePathSchema,
  runIdSchema,
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

/** Who made a decision: a tool call, a named runtime rule, or a judgment seam. */
export const bySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({
    kind: z.literal("rule"),
    rule: z.enum(["stuck", "stale", "check-result", "attempt-open", "fix"]),
  }),
  z.object({ kind: z.literal("judgment"), arm: nonEmpty }),
]);
export type By = z.infer<typeof bySchema>;

/**
 * THE FOLD: how the run screen and the review read `task`, `checkpoint` and
 * `value` events. Both lanes implement exactly this; nothing is summarised by a
 * model. The runtime guarantees the event rules in `task-tools.ts`.
 *
 * Group by `payload.taskId`, in `seq` order. An *opener* is a `task` event with
 * status `in-progress`, or `under-review` with `by` rule `fix`. An *attempt* is
 * the events from one opener up to the next; the latest is the current one, the
 * earlier ones stay as revisions. Ignore a `verdict` unless its thread's
 * `thread.started` has kind `check`.
 *
 * Run screen, per task (current attempt):
 * - state: the latest `task` event's `status` and `reason`; `pending` if none.
 * - milestones: the `checkpoint` texts in order, with evidence. One with a
 *   `verdict` is the check line. "N to check" counts the `checks` below.
 * - outputs: the `value` events, the latest per `measurementId`.
 *
 * Review, a `ReviewTask` per attempt:
 * - `status`: the attempt's latest `task` status (the importer sets `done`).
 * - `resultRevisionId`: the opener event's id.
 * - measurements: each output becomes a `Measurement`: `id` is
 *   `${taskId}/${measurementId}`; `numeratorId`/`denominatorId` name a same-task
 *   `measurementId` or a `taskId/measurementId` and become full ids; `source` is
 *   the event's `{threadId, id}`; `evidenceIds` are its evidence sha256;
 *   `references` is empty; the other fields are copied.
 * - evidence: checkpoint and value files, unique by sha256, as `Asset { id:
 *   sha256, name: path, stage: task title, key: evidenceKey(runId, sha256),
 *   sha256 }`.
 * - checker: the latest checkpoint with a `verdict` → `{verdict, text}`, or null.
 * - checks, all `status: "open"` (accepting one is the review lane's, not an
 *   event): each `toCheck` checkpoint → `{id: event id, title: toCheck.title,
 *   detail: text}`; a `to-check` status event in an attempt with no `toCheck`
 *   checkpoint → `{id: event id, title: "Marked to check", detail: reason}`; an
 *   attempt opened by `fix` → `{id: opener id, title: "Changed by the second
 *   agent", detail: opener reason}`.
 * - threads: `worker` is the `threadId` of the attempt's events from a worker
 *   thread; `check` is the latest `thread.started` with kind `check` and `task`
 *   = this taskId after the opener; `chat` comes from the review lane.
 * - not from these events: `title`, `ask`, `dependsOn` and `structureIds` (the
 *   workflow), `files` (the API lists the task's output folder). A
 *   `structureIds`/`annotationIds` entry the revision doesn't contain is dropped.
 *
 * Run-level revisions (`ReviewRun.revisions`): one is cut at the run's first
 * opener and at each opener of a task that already has a `done` event in an
 * earlier attempt (a correction or a fix). Its id is that event's id and it
 * holds each task's latest attempt opened at or before it. Labels are the API's.
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
      /** The `taskId` a check thread checks (the fold reads it). */
      task: taskIdSchema.optional(),
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
   * A checklist task changed status. Written when a `checklist` tool call
   * succeeds (`by` agent) or by the runtime's own code (`by` rule or judgment);
   * the envelope `threadId` is the thread whose tool or wake produced it.
   */
  const task = event(
    "task",
    z.object({
      taskId: taskIdSchema,
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
   * `measurementId` again; within an attempt the latest wins.
   */
  const value = event(
    "value",
    z.object({
      taskId: taskIdSchema,
      /** Stable across reruns of the task: the agent's name for the quantity, e.g. `femur-width`. */
      measurementId: nonEmpty,
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
